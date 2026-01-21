import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { thumbnailExistsInBlob, getThumbnailBlobPath } from '@/lib/thumbnail-generator';

// GET /api/documents/[id]/thumbnails - Get all thumbnail URLs for a document
// Returns Blob URLs for generated thumbnails, null for pending ones
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
    const thumbnailUrls: (string | null)[] = [];

    // If thumbnails have been generated, construct Blob URLs
    if (doc.document.thumbnailsGenerated) {
      // Check first thumbnail to get the base URL pattern
      const firstUrl = await thumbnailExistsInBlob(id, 1);

      if (firstUrl) {
        // Extract base URL and construct all URLs
        // URL format: https://{storeId}.public.blob.vercel-storage.com/thumbnails/{docId}/{page}.webp
        const baseUrl = firstUrl.replace(/\/\d+\.webp$/, '');

        for (let i = 1; i <= pageCount; i++) {
          thumbnailUrls.push(`${baseUrl}/${i}.webp`);
        }
      } else {
        // Thumbnails marked as generated but first one doesn't exist - check each
        for (let i = 1; i <= pageCount; i++) {
          thumbnailUrls.push(await thumbnailExistsInBlob(id, i));
        }
      }
    } else {
      // Thumbnails not generated - return null for all (client should use fallback API)
      for (let i = 0; i < pageCount; i++) {
        thumbnailUrls.push(null);
      }
    }

    return NextResponse.json({
      documentId: id,
      pageCount,
      thumbnailsReady: doc.document.thumbnailsGenerated || false,
      urls: thumbnailUrls,
    }, {
      headers: {
        'Cache-Control': 'public, max-age=60', // Cache for 1 minute (thumbnails might still be generating)
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
