import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { takeoffFindings, takeoffRuns } from '@/db/schema';
import { desc, eq, and } from 'drizzle-orm';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { runId } = await ctx.params;

  const rows = await db
    .select({ finding: takeoffFindings })
    .from(takeoffFindings)
    .innerJoin(takeoffRuns, eq(takeoffRuns.id, takeoffFindings.runId))
    .where(and(eq(takeoffFindings.runId, runId), eq(takeoffRuns.userId, userId)))
    .orderBy(desc(takeoffFindings.createdAt));

  return NextResponse.json({ findings: rows.map((r) => r.finding) });
}
