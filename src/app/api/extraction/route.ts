import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, pageText, lineItems, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { analyzePageText, ExtractedLineItem } from '@/extraction/claude-analyzer';

// Force Node.js runtime for Claude API calls
export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes for large documents (requires Vercel Pro, otherwise 60s)

// POST /api/extraction - Extract signage from a document (synchronous)
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { documentId } = body;

    if (!documentId) {
      return NextResponse.json(
        { error: 'documentId is required' },
        { status: 400 }
      );
    }

    // Get document and verify ownership
    const [doc] = await db
      .select({
        document: documents,
        bid: bids,
      })
      .from(documents)
      .innerJoin(bids, eq(documents.bidId, bids.id))
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!doc || doc.bid.userId !== session.user.id) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Ensure document has a bidId (required for line items)
    if (!doc.document.bidId) {
      return NextResponse.json(
        { error: 'Document is not associated with a project' },
        { status: 400 }
      );
    }

    const bidId = doc.document.bidId;

    // Get stored page text
    const pages = await db
      .select()
      .from(pageText)
      .where(eq(pageText.documentId, documentId))
      .orderBy(pageText.pageNumber);

    if (pages.length === 0) {
      return NextResponse.json(
        { error: 'No text extracted for this document. Please re-upload.' },
        { status: 400 }
      );
    }

    // Update status to extracting
    await db.update(documents)
      .set({ extractionStatus: 'extracting' })
      .where(eq(documents.id, documentId));

    console.log(`[extraction] Starting extraction for document ${documentId} (${pages.length} pages)`);

    // Extract signage from each page with text
    const allItems: Array<ExtractedLineItem & { pageNumber: number }> = [];
    let processedPages = 0;

    for (const page of pages) {
      // Skip pages with no text or flagged as needing OCR
      if (!page.rawText || page.rawText.length < 100) {
        console.log(`[extraction] Skipping page ${page.pageNumber} - insufficient text`);
        continue;
      }

      try {
        const result = await analyzePageText(
          page.rawText,
          page.pageNumber,
          'division_10' // Signage
        );

        for (const item of result.items) {
          allItems.push({ ...item, pageNumber: page.pageNumber });
        }

        processedPages++;
        console.log(`[extraction] Page ${page.pageNumber}: found ${result.items.length} items`);
      } catch (pageError) {
        console.error(`[extraction] Error on page ${page.pageNumber}:`, pageError);
        // Continue with other pages
      }
    }

    // Save extracted items to database
    console.log(`[extraction] Saving ${allItems.length} items to database`);

    for (const item of allItems) {
      await db.insert(lineItems).values({
        documentId,
        bidId,
        userId: session.user.id,
        tradeCode: 'division_10',
        category: item.category,
        description: item.description,
        estimatedQty: item.estimatedQty,
        unit: item.unit,
        notes: item.notes,
        specifications: item.specifications,
        pageNumber: item.pageNumber,
        pageReference: item.pageReference,
        extractionConfidence: item.confidence,
        extractionModel: 'claude-sonnet-4-20250514',
        reviewStatus: 'pending',
        extractedAt: new Date(),
      });
    }

    // Update document status
    await db.update(documents)
      .set({
        extractionStatus: 'completed',
        lineItemCount: allItems.length,
      })
      .where(eq(documents.id, documentId));

    console.log(`[extraction] Completed for document ${documentId}: ${allItems.length} items`);

    return NextResponse.json({
      success: true,
      documentId,
      itemCount: allItems.length,
      processedPages,
      totalPages: pages.length,
    });

  } catch (error) {
    console.error('Extraction API error:', error);

    // Try to update status to failed
    try {
      const body = await request.clone().json();
      if (body.documentId) {
        await db.update(documents)
          .set({ extractionStatus: 'failed' })
          .where(eq(documents.id, body.documentId));
      }
    } catch {}

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET /api/extraction?documentId=xxx - Get extraction status
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const documentId = searchParams.get('documentId');

    if (!documentId) {
      return NextResponse.json(
        { error: 'documentId query parameter is required' },
        { status: 400 }
      );
    }

    // Get document status (no more background jobs - just document state)
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    return NextResponse.json({
      document: {
        id: doc.id,
        extractionStatus: doc.extractionStatus,
        lineItemCount: doc.lineItemCount,
      },
    });
  } catch (error) {
    console.error('Extraction status API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
