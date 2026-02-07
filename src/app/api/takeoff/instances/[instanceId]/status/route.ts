import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffInstances } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

export async function POST(req: Request, { params }: { params: Promise<{ instanceId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { instanceId } = await params;
  const body = (await req.json().catch(() => null)) as any;
  const status = String(body?.status || '');
  if (!status) return NextResponse.json({ error: 'Missing status' }, { status: 400 });

  const [row] = await db
    .update(takeoffInstances)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(takeoffInstances.id, instanceId), eq(takeoffInstances.userId, session.user.id)))
    .returning({ id: takeoffInstances.id, status: takeoffInstances.status });

  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true, instance: row });
}
