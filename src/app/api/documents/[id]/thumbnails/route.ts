import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getAllThumbnailUrls } from '@/lib/thumbnail-generator';

// GET /api/documents/[id]/thumbnails - Get all thumbnail URLs for a document
// Returns direct Blob CDN URLs for generated thumbnails, null for pending ones
// Single auth call - images load directly from Blob (no further auth needed)
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

    const pageCount = doc.document.pageCount || 1;

    // Get all thumbnail URLs from Blob storage (single list() call)
    // Returns direct Blob CDN URLs - no auth needed to load these images
    const thumbnailUrls = await getAllThumbnailUrls(id, pageCount);

    // Check if all thumbnails are ready
    const allReady = thumbnailUrls.every(url => url !== null);

    return NextResponse.json({
      documentId: id,
      pageCount,
      thumbnailsReady: allReady,
      urls: thumbnailUrls, // Direct Blob URLs or null
    }, {
      headers: {
        // Cache longer if all thumbnails ready, shorter if still generating
        'Cache-Control': allReady ? 'public, max-age=3600' : 'public, max-age=30',
      },
    });
  } catch (error) {
    console.error('Thumbnails batch error:', error);
    return NextResponse.json(
      { error: 'Failed to get thumbnails' },
      { status: 500 }
    );
  }
}
