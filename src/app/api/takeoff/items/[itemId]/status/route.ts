import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { takeoffItems, takeoffItemEdits } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ itemId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { itemId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const status = String(body.status || 'draft');
  const allowed = new Set(['draft', 'needs_review', 'approved', 'rejected', 'modified']);
  if (!allowed.has(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const before = await db.select().from(takeoffItems).where(and(eq(takeoffItems.id, itemId), eq(takeoffItems.userId, userId)));
  if (!before[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await db
    .update(takeoffItems)
    .set({ status, updatedAt: new Date() } as any)
    .where(and(eq(takeoffItems.id, itemId), eq(takeoffItems.userId, userId)));

  await db.insert(takeoffItemEdits).values({
    id: randomUUID(),
    itemId,
    editedBy: userId,
    editType: 'status_change',
    before: { status: before[0].status },
    after: { status },
    createdAt: new Date(),
  } as any);

  return NextResponse.json({ ok: true });
}
