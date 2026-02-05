import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { takeoffItems } from '@/db/schema';
import { desc, eq, and } from 'drizzle-orm';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { runId } = await ctx.params;

  const rows = await db
    .select()
    .from(takeoffItems)
    .where(and(eq(takeoffItems.runId, runId), eq(takeoffItems.userId, userId)))
    .orderBy(desc(takeoffItems.confidence), takeoffItems.category, takeoffItems.description);

  return NextResponse.json({ items: rows });
}
