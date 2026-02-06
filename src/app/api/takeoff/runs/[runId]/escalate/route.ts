import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { takeoffArtifacts, takeoffJobDocuments, takeoffJobs, takeoffRuns } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';

// POST /api/takeoff/runs/:runId/escalate
// Create a follow-up takeoff job that expands the document set based on index scores,
// aimed at improving completeness when evidence coverage is weak.
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { runId } = await ctx.params;

  const [run] = await db
    .select({ id: takeoffRuns.id, bidId: takeoffRuns.bidId, userId: takeoffRuns.userId })
    .from(takeoffRuns)
    .where(and(eq(takeoffRuns.id, runId), eq(takeoffRuns.userId, userId)))
    .limit(1);

  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  type Row = Record<string, unknown>;

  // Pick next tranche of docs: highest index score docs not yet deeply processed.
  const candidates = (await db.execute(sql`
    with idx as (
      select document_id, max((meta->>'score')::int) as score
      from ${takeoffArtifacts}
      where run_id = ${runId}::uuid
        and coalesce(meta->>'phase','') = 'index'
      group by document_id
    ), deep as (
      select distinct document_id
      from ${takeoffArtifacts}
      where run_id = ${runId}::uuid
        and (meta is null or meta->>'phase' is null)
    )
    select idx.document_id, idx.score
    from idx
    left join deep on deep.document_id = idx.document_id
    where deep.document_id is null
    order by idx.score desc nulls last
    limit 12;
  `)) as Row[];

  const docIds = candidates
    .map((r) => String(r['document_id'] || ''))
    .filter((x) => x);

  if (docIds.length === 0) {
    return NextResponse.json({ error: 'No additional candidate documents to process' }, { status: 400 });
  }

  const [job] = await db
    .insert(takeoffJobs)
    .values({
      bidId: run.bidId,
      userId,
      status: 'queued',
      requestedDocumentIds: docIds,
      updatedAt: new Date(),
    } as any)
    .returning({ id: takeoffJobs.id });

  const jobId = job?.id;
  if (!jobId) return NextResponse.json({ error: 'Failed to create job' }, { status: 500 });

  await db.insert(takeoffJobDocuments).values(
    docIds.map((documentId) => ({
      jobId,
      documentId,
      createdAt: new Date(),
    })) as any
  );

  const [newRun] = await db
    .insert(takeoffRuns)
    .values({
      jobId,
      bidId: run.bidId,
      userId,
      status: 'running',
      summary: { escalatedFromRunId: runId, kind: 'escalation', pickedDocs: docIds.length },
      updatedAt: new Date(),
    } as any)
    .returning({ id: takeoffRuns.id });

  return NextResponse.json({ jobId, runId: newRun?.id, addedDocumentIds: docIds });
}
