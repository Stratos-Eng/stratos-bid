import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { takeoffItems, takeoffItemEdits, takeoffRuns } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

function pick<T extends Record<string, any>>(obj: T, keys: Array<keyof T>) {
  const out: Partial<T> = {};
  for (const k of keys) if (k in obj) (out as any)[k] = obj[k];
  return out;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ itemId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { itemId } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  // Allowed fields (intentionally small; we can expand later)
  const allowedKeys = [
    'code',
    'category',
    'description',
    'qtyNumber',
    'qtyText',
    'unit',
    'status',
  ] as const;

  const patch = pick(body, allowedKeys as any) as any;

  if (patch.status) {
    const allowed = new Set(['draft', 'needs_review', 'approved', 'rejected', 'modified']);
    if (!allowed.has(String(patch.status))) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
  }

  if (patch.qtyNumber != null && typeof patch.qtyNumber !== 'number') {
    return NextResponse.json({ error: 'qtyNumber must be a number' }, { status: 400 });
  }

  if (patch.qtyText != null && typeof patch.qtyText !== 'string') {
    return NextResponse.json({ error: 'qtyText must be a string' }, { status: 400 });
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No editable fields provided' }, { status: 400 });
  }

  // Authorize: item must belong to current user via run
  const beforeRows = await db
    .select({ item: takeoffItems, run: takeoffRuns })
    .from(takeoffItems)
    .innerJoin(takeoffRuns, eq(takeoffRuns.id, takeoffItems.runId))
    .where(and(eq(takeoffItems.id, itemId), eq(takeoffRuns.userId, userId)));

  const before = beforeRows[0]?.item;
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await db
    .update(takeoffItems)
    .set({ ...patch, updatedAt: new Date() } as any)
    .where(eq(takeoffItems.id, itemId));

  await db.insert(takeoffItemEdits).values({
    id: randomUUID(),
    itemId,
    editedBy: userId,
    editType: 'edit',
    before: before,
    after: { ...before, ...patch },
    createdAt: new Date(),
  } as any);

  return NextResponse.json({ ok: true });
}
