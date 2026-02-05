import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { takeoffItems, takeoffItemEvidence, takeoffFindings, takeoffRuns } from '@/db/schema';
import { and, desc, eq } from 'drizzle-orm';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ itemId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { itemId } = await ctx.params;

  // Authorize: item must belong to current user
  const itemRows = await db
    .select({ item: takeoffItems, run: takeoffRuns })
    .from(takeoffItems)
    .innerJoin(takeoffRuns, eq(takeoffRuns.id, takeoffItems.runId))
    .where(and(eq(takeoffItems.id, itemId), eq(takeoffRuns.userId, userId)));

  if (!itemRows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const evidence = await db
    .select({
      link: takeoffItemEvidence,
      finding: takeoffFindings,
    })
    .from(takeoffItemEvidence)
    .innerJoin(takeoffFindings, eq(takeoffFindings.id, takeoffItemEvidence.findingId))
    .where(eq(takeoffItemEvidence.itemId, itemId))
    .orderBy(desc(takeoffFindings.createdAt));

  return NextResponse.json({
    item: itemRows[0].item,
    evidence: evidence.map((r) => ({
      finding: r.finding,
      link: r.link,
    })),
  });
}
