/* eslint-disable no-console */

import { createHash } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';

import { db } from '@/db';
import { takeoffInstances, takeoffInstanceEvidence, takeoffItems } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

import { extractPageTextWithFallback, getPdfPageCount } from './pdf-artifacts';
import { openclawChatCompletions } from '@/lib/openclaw';

function stableId(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type TypeRow = { id: string; code: string | null; description: string };

type Candidate = {
  idx: number;
  documentId: string;
  filename: string;
  pageNumber: number;
  match: string;
  context: string;
};

type Classified = {
  idx: number;
  isInstance: boolean;
  normalizedCode: string | null;
  confidence: number | null;
  note?: string | null;
  dedupeHint?: string | null;
};

export async function mineTakeoffInstances(input: {
  runId: string;
  bidId: string;
  userId: string;
  localBidFolder: string;
  docIdBySafeName: Map<string, string>;
  budgetMs?: number;
}) {
  const budgetMs = input.budgetMs ?? 25 * 60 * 1000;
  const tStart = Date.now();

  // Load type dictionary from takeoff_items (these are the known sign types)
  const types = (await db
    .select({ id: takeoffItems.id, code: takeoffItems.code, description: takeoffItems.description })
    .from(takeoffItems)
    .where(and(eq(takeoffItems.runId, input.runId), eq(takeoffItems.bidId, input.bidId)))) as TypeRow[];

  const codes = Array.from(
    new Set(
      types
        .map((t) => (t.code || '').trim())
        .filter((c) => c.length >= 2 && c.length <= 12)
    )
  );

  if (codes.length === 0) {
    console.log('[instance-miner] No type codes; skipping instance mining');
    return { inserted: 0, scannedPages: 0, codes: 0 };
  }

  // Build a regex to find any known code as a token.
  // This intentionally does NOT try to encode every possible formatting rule.
  // The agent will decide which matches are actual sign instances vs false positives.
  const union = codes.map(escapeRegex).join('|');
  const re = new RegExp(`\\b(?:${union})\\b`, 'g');

  const pdfPaths = readdirSync(input.localBidFolder)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .map((f) => join(input.localBidFolder, f));

  let scannedPages = 0;
  let candidateIdx = 0;
  const candidates: Candidate[] = [];

  for (const pdfPath of pdfPaths) {
    const filename = pdfPath.split('/').slice(-1)[0];
    const documentId = input.docIdBySafeName.get(filename);
    if (!documentId) continue;

    const pageCount = getPdfPageCount(pdfPath) || 0;
    const maxPages = pageCount > 0 ? pageCount : 2000;

    for (let page = 1; page <= maxPages; page++) {
      if (Date.now() - tStart > budgetMs) break;

      const extracted = extractPageTextWithFallback({
        pdfPath,
        page,
        // Smart default: keep embedded PDF text when it exists; OCR only when text is too thin.
        // (Passing Infinity would force OCR on every page, which is slow and can yield empty text.)
        ocrMinChars: 30,
      });

      if (!extracted.text) {
        // If text extraction fails, keep going; pageCount bounds us.
        continue;
      }

      scannedPages++;

      const text = extracted.text;
      if (!re.test(text)) {
        re.lastIndex = 0;
        continue;
      }
      re.lastIndex = 0;

      // Light logging for visibility
      if (scannedPages % 50 === 0) {
        console.log(`[instance-miner] scannedPages=${scannedPages} candidates=${candidates.length}`);
      }

      let m: RegExpExecArray | null;
      let perPage = 0;
      while ((m = re.exec(text))) {
        perPage++;
        if (perPage > 40) break;
        const match = m[0];
        const start = Math.max(0, m.index - 120);
        const end = Math.min(text.length, m.index + match.length + 120);
        const context = text.slice(start, end).replace(/\s+/g, ' ').trim();

        candidates.push({
          idx: candidateIdx++,
          documentId,
          filename,
          pageNumber: page,
          match,
          context,
        });
      }

      if (candidates.length >= 2000) break;
    }

    if (Date.now() - tStart > budgetMs) break;
    if (candidates.length >= 2000) break;
  }

  if (candidates.length === 0) {
    console.log('[instance-miner] No candidates found');
    return { inserted: 0, scannedPages, codes: codes.length };
  }

  console.log(`[instance-miner] Found ${candidates.length} candidates across ${scannedPages} pages (codes=${codes.length}). Classifying...`);

  // Classify candidates with OpenClaw (agentic decision per plan set)
  const system = `You are a signage takeoff agent.\n\nGoal: Decide if a candidate text hit represents a REAL PHYSICAL SIGN INSTANCE placement in drawings/specs.\n\nWe are scanning plan text/OCR for known sign TYPE codes (like D7, P1). Many hits are false positives (schedule rows, detail references like 2.D8.10, sheet references, etc.).\n\nRules:\n- Return isInstance=true ONLY if this looks like a placement/callout of a sign type on a drawing/spec that implies a physical sign exists.\n- If it is a schedule row/table row, legend entry, or detail reference, return isInstance=false.\n- normalizedCode should be one of the known codes when possible (exact match) else null.\n- confidence 0..1.\n- Keep notes short.\n\nOutput MUST be valid JSON: {"results": [{"idx": number, "isInstance": boolean, "normalizedCode": string|null, "confidence": number|null, "note": string|null}]}\nNo extra text.`;

  const user = {
    codes,
    candidates: candidates.slice(0, 1200),
  };

  const resp = await openclawChatCompletions({
    temperature: 0.1,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(user) },
    ],
  });

  const content = resp?.choices?.[0]?.message?.content as string | undefined;
  if (!content) throw new Error('OpenClaw returned empty classification');

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`OpenClaw returned non-JSON: ${content.slice(0, 200)}`);
  }

  const results: Classified[] = Array.isArray(parsed?.results) ? parsed.results : [];
  const byIdx = new Map<number, Classified>();
  for (const r of results) {
    if (typeof r?.idx === 'number') byIdx.set(r.idx, r);
  }

  const codeToTypeId = new Map<string, string>();
  for (const t of types) {
    if (t.code) codeToTypeId.set(t.code.trim(), t.id);
  }

  const instancesToInsert: any[] = [];
  const evidenceToInsert: any[] = [];

  for (const c of candidates) {
    const r = byIdx.get(c.idx);
    if (!r || !r.isInstance) continue;

    const normalized = (r.normalizedCode || c.match).trim();
    const typeItemId = codeToTypeId.get(normalized) || null;

    const id = stableId(`${input.runId}:${c.documentId}:${c.pageNumber}:${normalized}:${c.context.slice(0, 80)}`);

    instancesToInsert.push({
      id,
      runId: input.runId,
      bidId: input.bidId,
      userId: input.userId,
      typeItemId,
      sourceKind: 'evidence',
      status: 'needs_review',
      confidence: r.confidence ?? null,
      meta: {
        normalizedCode: normalized,
        note: r.note || null,
        match: c.match,
      },
      updatedAt: new Date(),
      createdAt: new Date(),
    });

    evidenceToInsert.push({
      instanceId: id,
      documentId: c.documentId,
      pageNumber: c.pageNumber,
      evidenceText: c.context,
      evidence: {
        filename: c.filename,
        code: normalized,
      },
      weight: 1,
      createdAt: new Date(),
    });
  }

  if (instancesToInsert.length === 0) {
    console.log('[instance-miner] Agent rejected all candidates');
    return { inserted: 0, scannedPages, codes: codes.length };
  }

  // Insert (best-effort) – ignore conflicts by inserting with stable ids
  await db.insert(takeoffInstances).values(instancesToInsert).onConflictDoNothing();
  await db.insert(takeoffInstanceEvidence).values(evidenceToInsert).onConflictDoNothing();

  console.log(`[instance-miner] Inserted ~${instancesToInsert.length} instances (needs_review)`);
  return { inserted: instancesToInsert.length, scannedPages, codes: codes.length };
}
