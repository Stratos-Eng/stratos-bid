import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, pageText, lineItems, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { extractSignageV2, getExtractionSummary } from '@/extraction/signage';
import type { ParsedPage } from '@/extraction/pdf-parser';

// Force Node.js runtime for extraction
export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes for large documents

// POST /api/extraction - Extract signage from a document using V2 system
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

    // Get stored page text and convert to ParsedPage format
    const storedPages = await db
      .select()
      .from(pageText)
      .where(eq(pageText.documentId, documentId))
      .orderBy(pageText.pageNumber);

    if (storedPages.length === 0) {
      return NextResponse.json(
        { error: 'No text extracted for this document. Please re-upload.' },
        { status: 400 }
      );
    }

    // Convert to ParsedPage[] format for the V2 extractor
    const pages: ParsedPage[] = storedPages.map(p => ({
      pageNumber: p.pageNumber,
      text: p.rawText || '',
      hasContent: (p.rawText?.length || 0) > 50,
    }));

    // Update status to extracting
    await db.update(documents)
      .set({ extractionStatus: 'extracting' })
      .where(eq(documents.id, documentId));

    console.log(`[extraction-v2] Starting extraction for document ${documentId} (${pages.length} pages)`);

    // Run the V2 extraction system
    const result = await extractSignageV2(pages);

    console.log(`[extraction-v2] ${getExtractionSummary(result)}`);

    // Save extracted entries to database as line items
    console.log(`[extraction-v2] Saving ${result.entries.length} entries to database`);

    for (const entry of result.entries) {
      await db.insert(lineItems).values({
        documentId,
        bidId,
        userId: session.user.id,
        tradeCode: 'division_10',
        category: entry.name, // Use room/sign name as category
        description: `${entry.name}${entry.roomNumber ? ` (${entry.roomNumber})` : ''}`,
        estimatedQty: String(entry.quantity),
        unit: 'EA',
        notes: buildNotes(entry),
        pageNumber: entry.pageNumbers[0], // Primary page
        pageReference: entry.sheetRefs.join(', '),
        extractionConfidence: entry.confidence,
        extractionModel: 'signage-extraction-v2',
        rawExtractionJson: {
          id: entry.id,
          identifier: entry.identifier,
          source: entry.source,
          isGrouped: entry.isGrouped,
          groupRange: entry.groupRange,
          allPages: entry.pageNumbers,
          allSheetRefs: entry.sheetRefs,
        },
        reviewStatus: entry.confidence >= 0.8 ? 'pending' : 'needs_review',
        extractedAt: new Date(),
      });
    }

    // Store extraction metadata on document
    await db.update(documents)
      .set({
        extractionStatus: 'completed',
        lineItemCount: result.entries.length,
        signageLegend: {
          // V2 extraction metadata
          v2Extraction: true,
          primarySource: result.primarySource,
          sourcesUsed: result.sourcesUsed,
          totalCount: result.totalCount,
          confidence: result.confidence,
          converged: result.converged,
          iterations: result.iterations,
          discrepancies: result.discrepancies.map(d => ({
            type: d.type,
            description: d.description,
            autoResolvable: d.autoResolvable,
          })),
          clarifications: result.clarifications.map(c => ({
            priority: c.priority,
            category: c.category,
            question: c.question,
            suggestedRFI: c.suggestedRFI,
          })),
          warnings: result.warnings,
          extractedAt: new Date().toISOString(),
        },
      })
      .where(eq(documents.id, documentId));

    console.log(`[extraction-v2] Completed for document ${documentId}: ${result.entries.length} items, ${result.confidence * 100}% confidence`);

    return NextResponse.json({
      success: true,
      documentId,
      itemCount: result.entries.length,
      totalCount: result.totalCount,
      confidence: result.confidence,
      primarySource: result.primarySource,
      sourcesUsed: result.sourcesUsed,
      converged: result.converged,
      clarificationsCount: result.clarifications.length,
      discrepanciesCount: result.discrepancies.length,
      warnings: result.warnings,
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

/**
 * Build notes string from SignageEntry
 */
function buildNotes(entry: {
  source: string;
  isGrouped: boolean;
  groupRange?: [number, number];
  notes?: string;
  sheetRefs: string[];
}): string {
  const parts: string[] = [];

  if (entry.isGrouped && entry.groupRange) {
    parts.push(`Grouped entry (${entry.groupRange[0]}-${entry.groupRange[1]})`);
  }

  parts.push(`Source: ${entry.source}`);

  if (entry.sheetRefs.length > 0) {
    parts.push(`Sheets: ${entry.sheetRefs.join(', ')}`);
  }

  if (entry.notes) {
    parts.push(entry.notes);
  }

  return parts.join(' | ');
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

    // Get document status
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Extract V2 metadata if available
    const v2Metadata = doc.signageLegend as {
      v2Extraction?: boolean;
      primarySource?: string;
      sourcesUsed?: string[];
      confidence?: number;
      converged?: boolean;
      clarifications?: Array<{ priority: string; question: string }>;
      discrepancies?: Array<{ type: string; description: string }>;
      warnings?: string[];
    } | null;

    return NextResponse.json({
      document: {
        id: doc.id,
        extractionStatus: doc.extractionStatus,
        lineItemCount: doc.lineItemCount,
        // V2 extraction info
        v2Extraction: v2Metadata?.v2Extraction || false,
        primarySource: v2Metadata?.primarySource,
        sourcesUsed: v2Metadata?.sourcesUsed,
        confidence: v2Metadata?.confidence,
        converged: v2Metadata?.converged,
        clarificationsCount: v2Metadata?.clarifications?.length || 0,
        discrepanciesCount: v2Metadata?.discrepancies?.length || 0,
        warnings: v2Metadata?.warnings,
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
