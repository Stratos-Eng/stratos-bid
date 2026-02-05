import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { takeoffRuns } from '@/db/schema';
import { takeoffRunPublishes } from '@/db/schema-takeoff-publish';
import { and, eq } from 'drizzle-orm';

export async function POST(req: Request, ctx: { params: Promise<{ bidId: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { bidId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const runId = body?.runId as string | undefined;
  if (!runId) return NextResponse.json({ error: 'Missing runId' }, { status: 400 });

  const run = await db.query.takeoffRuns.findFirst({
    where: and(eq(takeoffRuns.id, runId), eq(takeoffRuns.bidId, bidId), eq(takeoffRuns.userId, userId)),
  });
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  // upsert preferred run for this bid+user
  await db
    .insert(takeoffRunPublishes)
    .values({ bidId, runId, userId })
    .onConflictDoUpdate({
      target: [takeoffRunPublishes.bidId, takeoffRunPublishes.userId],
      set: { runId, createdAt: new Date() },
    } as any);

  return NextResponse.json({ ok: true, bidId, runId });
}

export async function GET(_req: Request, ctx: { params: Promise<{ bidId: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { bidId } = await ctx.params;

  const rows = await db
    .select()
    .from(takeoffRunPublishes)
    .where(and(eq(takeoffRunPublishes.bidId, bidId), eq(takeoffRunPublishes.userId, userId)))
    .limit(1);

  return NextResponse.json({ published: rows[0] || null });
}
