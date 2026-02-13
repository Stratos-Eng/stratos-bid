import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import * as XLSX from 'xlsx';
import { db } from '@/db';
import { documents, takeoffFindings, takeoffItemEvidence, takeoffItems, takeoffRuns, takeoffInstances } from '@/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { runId } = await ctx.params;

  const run = await db.query.takeoffRuns.findFirst({
    where: and(eq(takeoffRuns.id, runId), eq(takeoffRuns.userId, userId)),
  });
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  const items = await db.query.takeoffItems.findMany({
    where: and(eq(takeoffItems.runId, runId), eq(takeoffItems.userId, userId)),
    orderBy: (t, { asc }) => [asc(t.tradeCode), asc(t.code), asc(t.category), asc(t.description)],
  });

  const itemIds = items.map((i) => i.id);
  const evidenceRows = itemIds.length
    ? await db
        .select({
          itemId: takeoffItemEvidence.itemId,
          finding: takeoffFindings,
          doc: documents,
        })
        .from(takeoffItemEvidence)
        .innerJoin(takeoffFindings, eq(takeoffFindings.id, takeoffItemEvidence.findingId))
        .leftJoin(documents, eq(documents.id, takeoffFindings.documentId))
        .where(inArray(takeoffItemEvidence.itemId, itemIds))
    : [];

  const citationsByItem = new Map<string, string[]>();
  for (const r of evidenceRows) {
    const ev: any = (r.finding as any).evidence || {};
    const filename = r.doc?.filename || ev.filename || 'file';
    const page = r.finding.pageNumber ?? ev.page;
    const sheetRef = ev.sheetRef || (r.finding.data as any)?.sheetRef;
    const cite = `${filename} p${page ?? '—'}${sheetRef ? ` (${sheetRef})` : ''}`;
    const arr = citationsByItem.get(r.itemId) || [];
    if (!arr.includes(cite)) arr.push(cite);
    citationsByItem.set(r.itemId, arr);
  }

  const rows = items.map((it) => ({
    trade: it.tradeCode,
    code: it.code || '',
    category: it.category,
    description: it.description,
    qtyNumber: it.qtyNumber ?? '',
    qtyText: it.qtyText ?? '',
    unit: it.unit ?? '',
    confidence: it.confidence ?? '',
    status: it.status,
    citations: (citationsByItem.get(it.id) || []).join(' | '),
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Takeoff Items');

  // Placements (instances) grouped by type for estimator workflows
  const placementAgg = await db.execute(sql`
    select
      ti.trade_code as trade,
      coalesce(ti.code, '') as code,
      ti.category as category,
      ti.description as description,
      count(*)::int as placements_total,
      sum(case when inst.status = 'counted' then 1 else 0 end)::int as counted,
      sum(case when inst.status = 'needs_review' then 1 else 0 end)::int as needs_review,
      sum(case when inst.source_kind = 'inferred' then 1 else 0 end)::int as inferred
    from takeoff_instances inst
    left join takeoff_items ti on ti.id = inst.type_item_id
    where inst.run_id = ${runId} and inst.user_id = ${userId}
    group by ti.trade_code, ti.code, ti.category, ti.description
    order by ti.trade_code asc, ti.code asc, ti.category asc, ti.description asc
  `);

  const placementRows = ((placementAgg as any)?.rows ?? placementAgg ?? []).map((r: any) => ({
    trade: r.trade || '',
    code: r.code || '',
    category: r.category || '',
    description: r.description || '',
    placementsTotal: r.placements_total ?? r.placementsTotal ?? '',
    counted: r.counted ?? '',
    needsReview: r.needs_review ?? r.needsReview ?? '',
    inferred: r.inferred ?? '',
  }));

  const ws2 = XLSX.utils.json_to_sheet(placementRows);
  XLSX.utils.book_append_sheet(wb, ws2, 'Placements');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="takeoff-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      // Note: intentionally omit internal ids from the filename for estimator-friendly UX.
    },
  });
}
