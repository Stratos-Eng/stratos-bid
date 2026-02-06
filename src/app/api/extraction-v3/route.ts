import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { takeoffJobs, takeoffJobDocuments } from '@/db/schema';
import { dirname } from 'path';

/**
 * POST /api/extraction-v3 - Extract signage using Agentic extraction system
 *
 * Accepts either:
 *   { documentId: string }           — single document (legacy)
 *   { documentIds: string[] }        — batch of documents (preferred)
 *
 * Enqueues a takeoff job (DB-backed) for the droplet worker.
 * Returns immediately.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    // Normalise to an array
    const ids: string[] = body.documentIds
      ? body.documentIds
      : body.documentId
        ? [body.documentId]
        : [];

    if (ids.length === 0) {
      return NextResponse.json(
        { error: 'documentId or documentIds is required' },
        { status: 400 }
      );
    }

    // Validate inference config before doing any work
    // - Direct Anthropic: ANTHROPIC_API_KEY
    // - OpenClaw gateway: INFERENCE_API_KEY (+ INFERENCE_BASE_URL)
    if (!process.env.ANTHROPIC_API_KEY && !process.env.INFERENCE_API_KEY) {
      return NextResponse.json(
        { error: 'Extraction service unavailable: inference not configured' },
        { status: 503 }
      );
    }

    // Fetch all documents + verify ownership in one query
    const docs = await db
      .select({
        document: documents,
        bid: bids,
      })
      .from(documents)
      .innerJoin(bids, eq(documents.bidId, bids.id))
      .where(inArray(documents.id, ids));

    const ownedDocs = docs.filter((d) => d.bid.userId === session.user!.id);

    if (ownedDocs.length === 0) {
      return NextResponse.json({ error: 'No documents found' }, { status: 404 });
    }

    // Group by bid (primary workflow is 1 job per bid)
    const docsByBid = new Map<string, { bidId: string; documentIds: string[]; bidFolder: string | null }>();
    const queuedIds: string[] = [];
    const skipped: string[] = [];

    for (const doc of ownedDocs) {
      if (!doc.document.bidId) {
        skipped.push(doc.document.id);
        continue;
      }

      let bidFolder: string | null = typeof body.bidFolder === 'string' ? body.bidFolder : null;
      if (!bidFolder && doc.document.storagePath) {
        bidFolder = dirname(doc.document.storagePath);
      }

      const existing = docsByBid.get(doc.document.bidId);
      if (existing) {
        existing.documentIds.push(doc.document.id);
      } else {
        docsByBid.set(doc.document.bidId, {
          bidId: doc.document.bidId,
          documentIds: [doc.document.id],
          bidFolder,
        });
      }
      queuedIds.push(doc.document.id);
    }

    if (queuedIds.length === 0) {
      return NextResponse.json(
        { error: 'No documents eligible for extraction' },
        { status: 400 }
      );
    }

    // Batch update statuses (UI polls these)
    await db.update(documents)
      .set({ extractionStatus: 'queued' })
      .where(inArray(documents.id, queuedIds));

    // Create ONE job per bid
    const jobs = [] as { id: string; bidId: string; documentIds: string[] }[];

    for (const bid of docsByBid.values()) {
      const [job] = await db
        .insert(takeoffJobs)
        .values({
          bidId: bid.bidId,
          userId: session.user!.id,
          status: 'queued',
          requestedDocumentIds: bid.documentIds,
          bidFolder: bid.bidFolder,
          updatedAt: new Date(),
        })
        .returning();

      await db.insert(takeoffJobDocuments).values(
        bid.documentIds.map((documentId) => ({
          jobId: job.id,
          documentId,
        }))
      );

      jobs.push({ id: job.id, bidId: bid.bidId, documentIds: bid.documentIds });
    }

    console.log(`[extraction-v3] Started takeoff: ${queuedIds.length} file(s) across ${jobs.length} project(s)`);

    return NextResponse.json(
      {
        success: true,
        message: `Takeoff started for ${queuedIds.length} file(s)`,
        jobs,
        queued: queuedIds,
        skipped,
      },
      { status: 202 }
    );

  } catch (error) {
    console.error('[extraction-v3] Error:', error);

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET /api/extraction-v3?documentId=xxx - Get extraction status
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

    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const metadata = doc.signageLegend as {
      agenticExtraction?: boolean;
      totalCount?: number;
      confidence?: number;
      iterationsUsed?: number;
      toolCallsCount?: number;
      notes?: string;
      extractedAt?: string;
    } | null;

    return NextResponse.json({
      document: {
        id: doc.id,
        extractionStatus: doc.extractionStatus,
        lineItemCount: doc.lineItemCount,
        // Agentic extraction info
        agenticExtraction: metadata?.agenticExtraction || false,
        totalCount: metadata?.totalCount,
        confidence: metadata?.confidence,
        iterationsUsed: metadata?.iterationsUsed,
        toolCallsCount: metadata?.toolCallsCount,
        notes: metadata?.notes,
        extractedAt: metadata?.extractedAt,
      },
    });
  } catch (error) {
    console.error('[extraction-v3] Status API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
