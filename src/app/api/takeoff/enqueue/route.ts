import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { bids, documents, takeoffJobs, takeoffJobDocuments, takeoffRuns } from '@/db/schema';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { dirname } from 'path';

/**
 * POST /api/takeoff/enqueue
 *
 * Primary workflow: enqueue takeoff for a bid (project) using all available docs.
 * Also supports explicit documentIds.
 *
 * Body:
 *  { bidId: string, documentIds?: string[], bidFolder?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const bidId = String(body.bidId || '');
    const requestedDocumentIds: string[] = Array.isArray(body.documentIds)
      ? body.documentIds.filter((x: unknown): x is string => typeof x === 'string')
      : [];

    if (!bidId) {
      return NextResponse.json({ error: 'bidId is required' }, { status: 400 });
    }

    // Verify bid ownership
    const [bid] = await db
      .select()
      .from(bids)
      .where(and(eq(bids.id, bidId), eq(bids.userId, session.user.id)))
      .limit(1);

    if (!bid) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 });
    }

    // Cancel any in-flight takeoffs for this bid so we don't spam runs / burn worker time.
    // (We keep history via their finished_at + last_error.)
    await db
      .update(takeoffJobs)
      .set({
        status: 'cancelled',
        finishedAt: new Date(),
        updatedAt: new Date(),
        lastError: 'Cancelled: superseded by a newer takeoff run.',
        lockId: null,
        lockedAt: null,
      } as any)
      .where(and(eq(takeoffJobs.bidId, bidId), eq(takeoffJobs.userId, session.user.id), inArray(takeoffJobs.status, ['queued', 'running'])));

    await db
      .update(takeoffRuns)
      .set({
        status: 'cancelled',
        finishedAt: new Date(),
        updatedAt: new Date(),
        lastError: 'Cancelled: superseded by a newer takeoff run.',
      } as any)
      .where(and(eq(takeoffRuns.bidId, bidId), eq(takeoffRuns.userId, session.user.id), eq(takeoffRuns.status, 'running')));

    // Resolve documents for this job
    const docs = requestedDocumentIds.length > 0
      ? await db
          .select()
          .from(documents)
          .where(and(inArray(documents.id, requestedDocumentIds), eq(documents.bidId, bidId)))
      : await db
          .select()
          .from(documents)
          .where(and(eq(documents.bidId, bidId), isNotNull(documents.storagePath)));

    if (docs.length === 0) {
      return NextResponse.json({ error: 'No eligible documents found' }, { status: 400 });
    }

    // Derive bidFolder (used by existing extraction scoring + local temp layout)
    let bidFolder: string | null = typeof body.bidFolder === 'string' ? body.bidFolder : null;
    if (!bidFolder) {
      const firstWithPath = docs.find((d) => d.storagePath);
      if (firstWithPath?.storagePath) {
        bidFolder = dirname(firstWithPath.storagePath);
      }
    }

    const documentIds = docs.map((d) => d.id);

    // Mark documents queued (UI polls /api/projects/:id for these statuses)
    await db
      .update(documents)
      .set({ extractionStatus: 'queued' })
      .where(inArray(documents.id, documentIds));

    // Create job
    const [job] = await db
      .insert(takeoffJobs)
      .values({
        bidId,
        userId: session.user.id,
        status: 'queued',
        requestedDocumentIds: requestedDocumentIds.length > 0 ? requestedDocumentIds : null,
        bidFolder,
        updatedAt: new Date(),
      })
      .returning();

    await db.insert(takeoffJobDocuments).values(
      documentIds.map((documentId) => ({
        jobId: job.id,
        documentId,
      }))
    );

    return NextResponse.json(
      {
        success: true,
        jobId: job.id,
        bidId,
        queuedDocuments: documentIds,
      },
      { status: 202 }
    );
  } catch (error) {
    console.error('[takeoff/enqueue] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
