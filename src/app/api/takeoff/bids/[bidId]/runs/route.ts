import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { takeoffRuns, takeoffItems } from '@/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ bidId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { bidId } = await ctx.params;

  // Return runs with item counts
  const rows = await db
    .select({
      run: takeoffRuns,
      itemCount: sql<number>`count(${takeoffItems.id})`.as('item_count'),
    })
    .from(takeoffRuns)
    .leftJoin(takeoffItems, eq(takeoffItems.runId, takeoffRuns.id))
    .where(and(eq(takeoffRuns.bidId, bidId), eq(takeoffRuns.userId, userId)))
    .groupBy(takeoffRuns.id)
    .orderBy(desc(takeoffRuns.startedAt));

  return NextResponse.json({
    runs: rows.map((r) => ({ ...r.run, itemCount: Number(r.itemCount || 0) })),
  });
}
