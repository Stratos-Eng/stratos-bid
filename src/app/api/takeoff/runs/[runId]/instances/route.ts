import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffInstances, takeoffInstanceEvidence, takeoffItems } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { runId } = await params;

  // summary + list in one call; list is limited by default for performance.
  const rows = await db
    .select({
      id: takeoffInstances.id,
      runId: takeoffInstances.runId,
      bidId: takeoffInstances.bidId,
      userId: takeoffInstances.userId,
      typeItemId: takeoffInstances.typeItemId,
      sourceKind: takeoffInstances.sourceKind,
      status: takeoffInstances.status,
      confidence: takeoffInstances.confidence,
      dedupeGroupId: takeoffInstances.dedupeGroupId,
      dedupeRole: takeoffInstances.dedupeRole,
      meta: takeoffInstances.meta,
      createdAt: takeoffInstances.createdAt,
      updatedAt: takeoffInstances.updatedAt,
      typeCode: takeoffItems.code,
      typeDescription: takeoffItems.description,
    })
    .from(takeoffInstances)
    .leftJoin(takeoffItems, eq(takeoffItems.id, takeoffInstances.typeItemId))
    .where(and(eq(takeoffInstances.runId, runId), eq(takeoffInstances.userId, session.user.id)))
    .limit(500);

  // Best-effort: attach one "best" evidence pointer to each instance so the UI can group/navigate by page
  // without fetching evidence for every row.
  const ids = rows.map((r) => r.id);
  const evMap = new Map<string, { documentId: string; pageNumber: number | null }>();
  if (ids.length) {
    const evRows = await db.execute(sql`
      select distinct on (instance_id)
        instance_id,
        document_id,
        page_number
      from takeoff_instance_evidence
      where instance_id = any(${ids}::uuid[])
      order by instance_id, weight desc nulls last, created_at asc
    `);
    const list = ((evRows as any)?.rows ?? evRows ?? []) as any[];
    for (const r of list) {
      evMap.set(String(r.instance_id), { documentId: String(r.document_id), pageNumber: r.page_number == null ? null : Number(r.page_number) });
    }
  }

  const rowsWithEv = rows.map((r) => ({
    ...r,
    evidenceDocId: evMap.get(r.id)?.documentId || null,
    evidencePageNumber: evMap.get(r.id)?.pageNumber ?? null,
  }));

  const summary = await db.execute(sql`
    select
      count(*)::int as total,
      sum(case when status = 'needs_review' then 1 else 0 end)::int as needs_review,
      sum(case when source_kind = 'inferred' then 1 else 0 end)::int as inferred,
      sum(case when status = 'counted' then 1 else 0 end)::int as counted
    from takeoff_instances
    where run_id = ${runId} and user_id = ${session.user.id}
  `);

  const srow = (summary as any)?.rows?.[0] ?? (summary as any)?.[0] ?? null;

  return NextResponse.json({
    summary: srow || { total: 0, needs_review: 0, inferred: 0, counted: 0 },
    instances: rowsWithEv,
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { runId } = await params;
  const body = await req.json().catch(() => null) as any;
  if (!body || !Array.isArray(body.instances)) {
    return NextResponse.json({ error: 'Missing instances[]' }, { status: 400 });
  }

  // Upsert-ish: for now just insert; caller should provide deterministic ids if needed.
  const toInsert = body.instances.map((i: any) => ({
    runId,
    bidId: String(i.bidId),
    userId: session.user.id,
    typeItemId: i.typeItemId ? String(i.typeItemId) : null,
    sourceKind: String(i.sourceKind || 'evidence'),
    status: String(i.status || 'needs_review'),
    confidence: i.confidence ?? null,
    dedupeGroupId: i.dedupeGroupId ? String(i.dedupeGroupId) : null,
    dedupeRole: i.dedupeRole ? String(i.dedupeRole) : null,
    meta: i.meta ?? null,
  }));

  const inserted = await db.insert(takeoffInstances).values(toInsert).returning({ id: takeoffInstances.id });

  // evidence (optional)
  if (Array.isArray(body.evidence) && body.evidence.length > 0) {
    await db.insert(takeoffInstanceEvidence).values(
      body.evidence.map((e: any) => ({
        instanceId: String(e.instanceId),
        documentId: String(e.documentId),
        pageNumber: e.pageNumber ?? null,
        evidenceText: e.evidenceText ?? null,
        evidence: e.evidence ?? null,
        weight: e.weight ?? null,
      }))
    );
  }

  return NextResponse.json({ ok: true, insertedCount: inserted.length });
}
