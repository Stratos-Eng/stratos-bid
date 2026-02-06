import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { documents, takeoffArtifacts, takeoffItems, takeoffItemEvidence, takeoffRuns } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';

// GET /api/takeoff/runs/:runId/coverage
// Summary + "top candidate" pages from the index pass (meta.phase="index").
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { runId } = await ctx.params;

  const [run] = await db
    .select({ id: takeoffRuns.id, bidId: takeoffRuns.bidId })
    .from(takeoffRuns)
    .where(and(eq(takeoffRuns.id, runId), eq(takeoffRuns.userId, userId)))
    .limit(1);

  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const [{ totalItems }] = await db
    .select({ totalItems: sql<number>`count(*)` })
    .from(takeoffItems)
    .where(and(eq(takeoffItems.runId, runId), eq(takeoffItems.userId, userId)));

  const [{ needsReviewItems }] = await db
    .select({ needsReviewItems: sql<number>`count(*)` })
    .from(takeoffItems)
    .where(
      and(
        eq(takeoffItems.runId, runId),
        eq(takeoffItems.userId, userId),
        eq(takeoffItems.status, 'needs_review')
      )
    );

  const [{ itemsNoEvidence }] = await db
    .select({
      itemsNoEvidence: sql<number>`count(*)`,
    })
    .from(takeoffItems)
    .leftJoin(takeoffItemEvidence, eq(takeoffItemEvidence.itemId, takeoffItems.id))
    .where(and(eq(takeoffItems.runId, runId), eq(takeoffItems.userId, userId)))
    .having(sql`count(${takeoffItemEvidence.id}) = 0`);

  type Row = Record<string, unknown>;

  const idxRows = (await db.execute(sql`
    with idx as (
      select document_id, page_number, (meta->>'score')::int as score
      from ${takeoffArtifacts}
      where run_id = ${runId}::uuid
        and coalesce(meta->>'phase','') = 'index'
    )
    select
      count(*)::int as sampled_pages,
      count(distinct document_id)::int as docs_indexed,
      coalesce(max(score),0)::int as max_score
    from idx;
  `)) as Row[];

  const idxSummary = idxRows[0] || {};

  const deepRows = (await db.execute(sql`
    select
      count(*)::int as deep_pages,
      count(distinct document_id)::int as deep_docs
    from ${takeoffArtifacts}
    where run_id = ${runId}::uuid
      and (meta is null or meta->>'phase' is null);
  `)) as Row[];

  const deepSummary = deepRows[0] || {};

  // Top candidates = docs with highest index score + their best page
  const top = (await db.execute(sql`
    with idx as (
      select document_id, page_number, (meta->>'score')::int as score
      from ${takeoffArtifacts}
      where run_id = ${runId}::uuid
        and coalesce(meta->>'phase','') = 'index'
    ), best as (
      select distinct on (document_id)
        document_id,
        page_number as best_page,
        score as best_score
      from idx
      order by document_id, score desc nulls last, page_number asc
    ), agg as (
      select
        i.document_id,
        max(i.score)::int as score,
        count(*)::int as sampled_pages
      from idx i
      group by i.document_id
    )
    select
      d.id as document_id,
      d.filename,
      coalesce(a.score,0)::int as score,
      coalesce(b.best_page,1)::int as best_page,
      coalesce(a.sampled_pages,0)::int as sampled_pages
    from agg a
    join best b on b.document_id = a.document_id
    join ${documents} d on d.id = a.document_id
    order by a.score desc, a.sampled_pages desc
    limit 50;
  `)) as Row[];

  const num = (v: unknown, fallback = 0) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return NextResponse.json({
    runId,
    bidId: run.bidId,
    items: {
      total: num(totalItems, 0),
      needsReview: num(needsReviewItems, 0),
      noEvidence: num(itemsNoEvidence, 0),
    },
    index: {
      docsIndexed: num(idxSummary['docs_indexed'], 0),
      sampledPages: num(idxSummary['sampled_pages'], 0),
      maxScore: num(idxSummary['max_score'], 0),
    },
    deep: {
      docsProcessed: num(deepSummary['deep_docs'], 0),
      pagesProcessed: num(deepSummary['deep_pages'], 0),
    },
    topCandidates: top.map((r) => ({
      documentId: String(r['document_id'] || ''),
      filename: String(r['filename'] || ''),
      score: num(r['score'], 0),
      bestPage: num(r['best_page'], 1),
      sampledPages: num(r['sampled_pages'], 0),
    })),
  });
}
