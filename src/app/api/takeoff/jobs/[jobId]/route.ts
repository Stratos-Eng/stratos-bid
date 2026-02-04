import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffJobs, takeoffJobDocuments, documents, bids } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { jobId } = await params;

    const [job] = await db
      .select()
      .from(takeoffJobs)
      .where(and(eq(takeoffJobs.id, jobId), eq(takeoffJobs.userId, session.user.id)))
      .limit(1);

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    const docs = await db
      .select({
        documentId: documents.id,
        filename: documents.filename,
        extractionStatus: documents.extractionStatus,
      })
      .from(takeoffJobDocuments)
      .innerJoin(documents, eq(takeoffJobDocuments.documentId, documents.id))
      .where(eq(takeoffJobDocuments.jobId, jobId));

    // Optional: include bid title for convenience
    const [bid] = await db
      .select({ id: bids.id, title: bids.title })
      .from(bids)
      .where(eq(bids.id, job.bidId))
      .limit(1);

    return NextResponse.json({
      job: {
        id: job.id,
        bidId: job.bidId,
        bidTitle: bid?.title,
        status: job.status,
        attempts: job.attempts,
        lastError: job.lastError,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      },
      documents: docs,
    });
  } catch (error) {
    console.error('[takeoff/jobs] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
