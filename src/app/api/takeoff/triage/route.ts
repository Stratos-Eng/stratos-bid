import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { db } from '@/db';
import { bids, documents } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

// POST /api/takeoff/triage
// Given a bidId + candidate documentIds, return a smaller set of "likely relevant" docs.
// Goal: scale to huge folders without downloading/processing everything.
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const bidId = body?.bidId as string | undefined;
  const documentIds = (body?.documentIds as string[] | undefined) || [];

  if (!bidId) return NextResponse.json({ error: 'Missing bidId' }, { status: 400 });
  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    return NextResponse.json({ selectedDocumentIds: [], reasons: [] });
  }

  const [bid] = await db
    .select()
    .from(bids)
    .where(and(eq(bids.id, bidId), eq(bids.userId, userId)))
    .limit(1);
  if (!bid) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const docs = await db
    .select({ id: documents.id, filename: documents.filename, docType: documents.docType })
    .from(documents)
    .where(and(eq(documents.bidId, bidId), inArray(documents.id, documentIds)));

  const scoreDoc = (fn: string) => {
    const f = fn.toLowerCase();
    let score = 0;
    if (/(schedule|legend|exhibit)/.test(f)) score += 50;
    if (/(signage|signs|wayfinding|ada|tactile|braille)/.test(f)) score += 30;
    if (/(spec|specification|division\s*10|10\s*d|10d1)/.test(f)) score += 20;
    if (/(addendum|rfi|bulletin)/.test(f)) score += 10;
    // prefer PDFs that look like plansets
    if (/(a\d|s\d|e\d|p\d|g\d)/.test(f)) score += 5;
    return score;
  };

  const ranked = docs
    .map((d) => ({
      ...d,
      score: scoreDoc(d.filename || ''),
    }))
    .sort((a, b) => b.score - a.score);

  // Select strategy:
  // - Always include top schedule/legend/exhibit hits
  // - Cap total to keep worker bounded
  const cap = Math.min(25, Math.max(8, Math.ceil(documentIds.length * 0.12)));
  const selected = ranked.filter((r) => r.score > 0).slice(0, cap);

  // If nothing scored, just take the first few
  const finalSel = selected.length > 0 ? selected : ranked.slice(0, Math.min(8, ranked.length));

  return NextResponse.json({
    selectedDocumentIds: finalSel.map((d) => d.id),
    reasons: finalSel.map((d) => ({ id: d.id, filename: d.filename, score: d.score })),
    cap,
    total: docs.length,
  });
}
