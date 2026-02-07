import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffInstanceEvidence, takeoffInstances, documents } from '@/db/schema';
import { and, eq, desc } from 'drizzle-orm';

export async function GET(_req: Request, { params }: { params: Promise<{ instanceId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { instanceId } = await params;

  // Ensure ownership
  const [inst] = await db
    .select({ id: takeoffInstances.id })
    .from(takeoffInstances)
    .where(and(eq(takeoffInstances.id, instanceId), eq(takeoffInstances.userId, session.user.id)))
    .limit(1);

  if (!inst) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rows = await db
    .select({
      id: takeoffInstanceEvidence.id,
      documentId: takeoffInstanceEvidence.documentId,
      pageNumber: takeoffInstanceEvidence.pageNumber,
      evidenceText: takeoffInstanceEvidence.evidenceText,
      evidence: takeoffInstanceEvidence.evidence,
      weight: takeoffInstanceEvidence.weight,
      createdAt: takeoffInstanceEvidence.createdAt,
      filename: documents.filename,
    })
    .from(takeoffInstanceEvidence)
    .leftJoin(documents, eq(documents.id, takeoffInstanceEvidence.documentId))
    .where(eq(takeoffInstanceEvidence.instanceId, instanceId))
    .orderBy(desc(takeoffInstanceEvidence.weight));

  return NextResponse.json({ evidence: rows });
}
