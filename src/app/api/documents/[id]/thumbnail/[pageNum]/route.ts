import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getThumbnail } from '@/lib/thumbnail-generator';

// GET /api/documents/[id]/thumbnail/[pageNum] - Get a thumbnail for a specific page
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

    if (!doc.document.storagePath) {
      return NextResponse.json(
        { error: 'Document file path not available' },
        { status: 404 }
      );
    }

    // Check page number bounds if we have pageCount
    if (doc.document.pageCount && pageNum > doc.document.pageCount) {
      return NextResponse.json(
        { error: `Invalid page number. Document has ${doc.document.pageCount} pages.` },
        { status: 400 }
      );
    }

    // Determine effective storage path based on page-level architecture
    // If pagesReady is true, use the pre-split single-page PDF
    const pagesReady = doc.document.pagesReady ?? false;
    let effectiveStoragePath = doc.document.storagePath;
    let effectivePageNum = pageNum;

    if (pagesReady) {
      // Use single-page PDF URL for memory efficiency
      const baseUrl = new URL(doc.document.storagePath);
      baseUrl.pathname = `/pages/${id}/${pageNum}.pdf`;
      effectiveStoragePath = baseUrl.toString();
      effectivePageNum = 1; // Single-page PDF, always page 1
    }

    // Get thumbnail (from Blob or generate on-demand)
    const { url, buffer } = await getThumbnail(
      id,
      effectiveStoragePath,
      effectivePageNum,
      pagesReady ? pageNum : undefined // Pass original page num for storage path
    );

    // Redirect to Blob URL for better caching
    // Or return the image directly if needed
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable', // Cache for 1 year
        'X-Thumbnail-Url': url, // Include URL in header for reference
      },
    });
  } catch (error) {
    console.error('Thumbnail error:', error);
    return NextResponse.json(
      { error: 'Failed to get thumbnail' },
      { status: 500 }
    );
  }
}
