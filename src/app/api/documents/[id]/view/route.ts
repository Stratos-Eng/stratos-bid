import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { downloadFile, fileExists, isBlobUrl } from '@/lib/storage';

// GET /api/documents/[id]/view - Serve PDF file for viewing
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

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

    // Get file path - could be a Vercel Blob URL or local path
    const storagePath = doc.document.storagePath;

    if (!storagePath) {
      return NextResponse.json(
        { error: 'Document file path not available' },
        { status: 404 }
      );
    }

    // For Vercel Blob URLs, redirect to the blob URL directly for better performance
    if (isBlobUrl(storagePath)) {
      return NextResponse.redirect(storagePath);
    }

    // For local files, check existence and serve
    const exists = await fileExists(storagePath);
    if (!exists) {
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 }
      );
    }

    // Download and serve the file
    const fileBuffer = await downloadFile(storagePath);
    const filename = doc.document.filename || 'document.pdf';

    // Check for page parameter (for deep linking to specific page)
    // Note: This is handled client-side via #page=N fragment, but we include
    // the Open-In-Browser headers for PDF viewer compatibility

    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
        'Cache-Control': 'private, max-age=3600', // Cache for 1 hour
      },
    });
  } catch (error) {
    console.error('Document view error:', error);
    return NextResponse.json(
      { error: 'Failed to retrieve document' },
      { status: 500 }
    );
  }
}
