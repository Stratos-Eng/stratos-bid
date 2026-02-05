import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { takeoffItems, takeoffRuns } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const runA = url.searchParams.get('runA');
  const runB = url.searchParams.get('runB');
  if (!runA || !runB) return NextResponse.json({ error: 'Missing runA/runB' }, { status: 400 });

  const runs = await db.query.takeoffRuns.findMany({
    where: and(eq(takeoffRuns.userId, userId), inArray(takeoffRuns.id, [runA, runB])),
  });
  if (runs.length !== 2) return NextResponse.json({ error: 'Runs not found' }, { status: 404 });

  const [itemsA, itemsB] = await Promise.all([
    db.query.takeoffItems.findMany({ where: and(eq(takeoffItems.userId, userId), eq(takeoffItems.runId, runA)) }),
    db.query.takeoffItems.findMany({ where: and(eq(takeoffItems.userId, userId), eq(takeoffItems.runId, runB)) }),
  ]);

  const mapA = new Map(itemsA.map((i) => [i.itemKey, i] as const));
  const mapB = new Map(itemsB.map((i) => [i.itemKey, i] as const));
  const keys = new Set<string>([...mapA.keys(), ...mapB.keys()]);

  const added: any[] = [];
  const removed: any[] = [];
  const changed: any[] = [];

  for (const k of [...keys].sort()) {
    const a = mapA.get(k);
    const b = mapB.get(k);
    if (!a && b) added.push({ itemKey: k, item: b });
    else if (a && !b) removed.push({ itemKey: k, item: a });
    else if (a && b) {
      const diff: Record<string, { a: any; b: any }> = {};
      for (const field of ['code', 'category', 'description', 'qtyNumber', 'qtyText', 'unit', 'confidence', 'status'] as const) {
        if ((a as any)[field] !== (b as any)[field]) diff[field] = { a: (a as any)[field], b: (b as any)[field] };
      }
      if (Object.keys(diff).length > 0) changed.push({ itemKey: k, a, b, diff });
    }
  }

  return NextResponse.json({ runA, runB, added, removed, changed });
}
