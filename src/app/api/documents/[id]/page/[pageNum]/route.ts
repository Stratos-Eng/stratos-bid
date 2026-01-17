import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);
const unlinkAsync = promisify(fs.unlink);
const readFileAsync = promisify(fs.readFile);

// GET /api/documents/[id]/page/[pageNum] - Render a specific PDF page as an image
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; pageNum: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id, pageNum: pageNumStr } = await params;
    const pageNum = parseInt(pageNumStr, 10);

    if (isNaN(pageNum) || pageNum < 1) {
      return NextResponse.json(
        { error: 'Invalid page number' },
        { status: 400 }
      );
    }

    // Get scale from query params (1-3, default 1.5)
    const { searchParams } = new URL(request.url);
    const scale = Math.min(3, Math.max(0.5, parseFloat(searchParams.get('scale') || '1.5')));

    // Map scale to DPI (72 DPI is baseline, scale 1 = 72 DPI)
    const dpi = Math.round(72 * scale);

    // Get document and verify ownership through bid
    const [doc] = await db
      .select({
        document: documents,
        bid: bids,
      })
      .from(documents)
      .innerJoin(bids, eq(documents.bidId, bids.id))
      .where(eq(documents.id, id))
      .limit(1);

    if (!doc || doc.bid.userId !== session.user.id) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Get file path
    const filePath = doc.document.storagePath;

    if (!filePath) {
      return NextResponse.json(
        { error: 'Document file path not available' },
        { status: 404 }
      );
    }

    // Resolve the file path
    let resolvedPath = filePath;
    if (!path.isAbsolute(filePath)) {
      resolvedPath = path.join(process.cwd(), filePath);
    }

    // Normalize and security check - allow files in uploads/ or docs/ directories
    const normalizedPath = path.normalize(resolvedPath);
    const uploadsDir = path.normalize(path.join(process.cwd(), 'uploads'));
    const docsDir = path.normalize(path.join(process.cwd(), 'docs'));
    if (!normalizedPath.startsWith(uploadsDir) && !normalizedPath.startsWith(docsDir)) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
    }

    if (!fs.existsSync(normalizedPath)) {
      return NextResponse.json(
        { error: 'File not found on disk' },
        { status: 404 }
      );
    }

    // Use pdftoppm to render the page (much more reliable than pdf.js with node-canvas)
    // Note: pdftoppm doesn't support stdout piping on macOS, so we use temp files
    const tempPrefix = path.join('/tmp', `pdf-page-${randomUUID()}`);
    const tempFile = `${tempPrefix}.png`;

    try {
      await execFileAsync('pdftoppm', [
        '-f', String(pageNum),
        '-l', String(pageNum),
        '-png',
        '-r', String(dpi),
        '-singlefile',
        normalizedPath,
        tempPrefix
      ], {
        timeout: 30000 // 30 second timeout
      });

      // Read the generated file
      const imageBuffer = await readFileAsync(tempFile);

      // Clean up temp file (don't await, do it async)
      unlinkAsync(tempFile).catch(() => {});

      // Return the image
      return new NextResponse(imageBuffer, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400', // Cache for 1 day
        },
      });
    } catch (renderError) {
      // Clean up temp file on error
      unlinkAsync(tempFile).catch(() => {});
      console.error('pdftoppm render error:', renderError);
      return NextResponse.json(
        { error: 'Failed to render PDF page' },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Document page render error:', error);
    return NextResponse.json(
      { error: 'Failed to render document page' },
      { status: 500 }
    );
  }
}
