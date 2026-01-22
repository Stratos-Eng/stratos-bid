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
import { downloadFile, isBlobUrl } from '@/lib/storage';
import { pythonApi, PythonApiNotConfiguredError } from '@/lib/python-api';

const execFileAsync = promisify(execFile);
const unlinkAsync = promisify(fs.unlink);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

/**
 * Safely cleanup temp files
 */
async function cleanupTempFiles(...files: (string | null | undefined)[]): Promise<void> {
  for (const file of files) {
    if (file) {
      try {
        await unlinkAsync(file);
      } catch (err) {
        // Log but don't throw - cleanup failures shouldn't affect the response
        console.warn(`Failed to cleanup temp file ${file}:`, err);
      }
    }
  }
}

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
    const storagePath = doc.document.storagePath;

    if (!storagePath) {
      return NextResponse.json(
        { error: 'Document file path not available' },
        { status: 404 }
      );
    }

    // For Blob URLs with Python API configured, use URL-based rendering (memory efficient)
    // Python fetches the PDF directly, avoiding Node.js memory usage
    if (isBlobUrl(storagePath) && pythonApi.isConfigured()) {
      try {
        const result = await pythonApi.render({
          pdfUrl: storagePath,  // Pass URL directly - Python fetches it
          pageNum: pageNum,
          scale: scale,
          returnBase64: true,
        });

        if (result.success && result.image) {
          const imageBuffer = Buffer.from(result.image, 'base64');
          return new NextResponse(new Uint8Array(imageBuffer), {
            headers: {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=86400',
            },
          });
        }

        return NextResponse.json(
          { error: result.error || 'Failed to render PDF page' },
          { status: 500 }
        );
      } catch (error) {
        console.error('Python render service failed:', error);
        return NextResponse.json(
          { error: 'Failed to render PDF page' },
          { status: 500 }
        );
      }
    }

    // For local files or when Python API is not configured, use local rendering
    let pdfPath: string;

    if (isBlobUrl(storagePath)) {
      // Python API not configured - need to download and use local renderer
      // This path should rarely be hit in production
      console.warn('[page-render] Python API not configured, falling back to local rendering');
      const buffer = await downloadFile(storagePath);
      const tempPdfPath = path.join('/tmp', `pdf-download-${randomUUID()}.pdf`);
      await writeFileAsync(tempPdfPath, buffer);
      pdfPath = tempPdfPath;
    } else {
      // Resolve local file path
      pdfPath = path.isAbsolute(storagePath)
        ? storagePath
        : path.join(process.cwd(), storagePath);

      // Security check for local files - allow files in uploads/ or docs/ directories
      const normalizedPath = path.normalize(pdfPath);
      const uploadsDir = path.normalize(path.join(process.cwd(), 'uploads'));
      const docsDir = path.normalize(path.join(process.cwd(), 'docs'));
      if (!normalizedPath.startsWith(uploadsDir) && !normalizedPath.startsWith(docsDir)) {
        return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
      }

      if (!fs.existsSync(pdfPath)) {
        return NextResponse.json(
          { error: 'File not found on disk' },
          { status: 404 }
        );
      }
    }

    // Use pdftoppm to render the page (local development only)
    const tempPrefix = path.join('/tmp', `pdf-page-${randomUUID()}`);
    const tempFile = `${tempPrefix}.png`;
    const tempPdfPath = isBlobUrl(storagePath) ? pdfPath : null;

    try {
      let imageBuffer: Buffer | null = null;

      try {
        await execFileAsync('pdftoppm', [
          '-f', String(pageNum),
          '-l', String(pageNum),
          '-png',
          '-r', String(dpi),
          '-singlefile',
          pdfPath,
          tempPrefix
        ], {
          timeout: 30000
        });
        imageBuffer = await readFileAsync(tempFile);
      } catch {
        // pdftoppm not available - try Python with base64 data
        if (pythonApi.isConfigured()) {
          try {
            const pdfBuffer = await readFileAsync(pdfPath);
            const pdfBase64 = pdfBuffer.toString('base64');

            const result = await pythonApi.render({
              pdfData: pdfBase64,
              pageNum: pageNum,
              scale: scale,
              returnBase64: true,
            });

            if (result.success && result.image) {
              imageBuffer = Buffer.from(result.image, 'base64');
            }
          } catch (pythonError) {
            console.error('Python render service failed:', pythonError);
          }
        }
      }

      await cleanupTempFiles(tempFile, tempPdfPath);

      if (!imageBuffer) {
        return NextResponse.json(
          { error: 'Failed to render PDF page - no renderer available' },
          { status: 500 }
        );
      }

      return new NextResponse(new Uint8Array(imageBuffer), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (renderError) {
      await cleanupTempFiles(tempFile, tempPdfPath);
      console.error('Page render error:', renderError);
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
