import { execSync } from 'child_process';
import { openclawChatCompletions } from '@/lib/openclaw';

export type EvidenceSnippet = {
  filename: string;
  page: number;
  kind: 'schedule' | 'legend' | 'egress' | 'keynote' | 'code' | 'plan' | 'unknown';
  text: string;
};

export type TakeoffItem = {
  category: string;
  description: string;
  qty: string;
  confidence: number; // 0-1
  sources: Array<{
    filename: string;
    page: number;
    sheetRef?: string;
    evidence: string;
    whyAuthoritative: string;
  }>;
  reviewFlags?: string[];
};

export type EstimatorTakeoffResult = {
  items: TakeoffItem[];
  discrepancyLog: Array<{ issue: string; sources: { filename: string; page: number; evidence: string }[] }>;
  missingItems: string[];
  reviewFlags: string[];
  notes: string;
  verification?: {
    method: string;
    checkedItems: number;
    issuesFound: number;
    notes: string;
  };
};

import { ensurePdfReadableInPlace } from './pdf-utils';

const KEYWORD_SETS: Array<{ kind: EvidenceSnippet['kind']; keywords: RegExp }> = [
  { kind: 'schedule', keywords: /sign(\s|-)schedule|signage\s+schedule|sign\s+type|type\s+schedule|schedule\s+of\s+sign/i },
  { kind: 'legend', keywords: /legend|sign\s+legend/i },
  { kind: 'egress', keywords: /egress|occupant\s+load|exit\s+sign|exit\s+signage/i },
  { kind: 'keynote', keywords: /keynote/i },
  { kind: 'code', keywords: /code\s+requirement|ada|accessib|california\s+building\s+code|cbc\b|health\s+code|pool/i },
  { kind: 'plan', keywords: /floor\s+plan|electrical\s+plan|reflected\s+ceiling|site\s+plan/i },
];

function detectKind(text: string): EvidenceSnippet['kind'] {
  for (const s of KEYWORD_SETS) {
    if (s.keywords.test(text)) return s.kind;
  }
  return 'unknown';
}

function pdftotextPage(pdfPath: string, page: number): string {
  try {
    ensurePdfReadableInPlace(pdfPath);
    return execSync(`pdftotext -layout -f ${page} -l ${page} "${pdfPath}" -`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

function getPdfPageCount(pdfPath: string): number | null {
  try {
    ensurePdfReadableInPlace(pdfPath);
    const out = execSync(`pdfinfo "${pdfPath}"`, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    const m = out.match(/Pages:\s+(\d+)/i);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function pickSnippetsFromPage(text: string, maxSnippets = 2): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 8);

  const scored = lines
    .map((l) => {
      const score =
        (/(qty|quantity|count|no\.|ea\b|each\b)/i.test(l) ? 3 : 0) +
        (/\b(D|P|TS|ID|R)\s?-?\d{1,2}\b/i.test(l) ? 3 : 0) +
        (/sign|exit|egress|ada|tactile/i.test(l) ? 2 : 0) +
        (l.length > 80 ? 1 : 0);
      return { l, score };
    })
    .sort((a, b) => b.score - a.score);

  const picked: string[] = [];
  for (const { l } of scored) {
    if (picked.length >= maxSnippets) break;
    if (picked.some((p) => p === l)) continue;
    picked.push(l.slice(0, 400));
  }

  return picked;
}

function extractLikelySignCodes(items: TakeoffItem[], limit = 25): string[] {
  const codes = new Set<string>();
  const re = /\b([A-Z]{1,3}\s?-?\d{1,2})\b/g;
  for (const it of items) {
    const hay = `${it.description} ${it.sources?.map((s) => s.evidence).join(' ')}`;
    let m: RegExpExecArray | null;
    while (true) {
      m = re.exec(hay);
      if (!m) break;
      const c = m[1].replace(/\s+/g, '').toUpperCase();
      if (c.length >= 2) codes.add(c);
      if (codes.size >= limit) break;
    }
    if (codes.size >= limit) break;
  }
  return [...codes];
}

function countOccurrencesInText(text: string, needle: RegExp): number {
  const m = text.match(needle);
  return m ? m.length : 0;
}

async function buildVerificationEvidence(input: {
  localPdfPaths: Array<{ filename: string; path: string }>;
  codes: string[];
  maxPagesPerDoc: number;
}): Promise<EvidenceSnippet[]> {
  const evidence: EvidenceSnippet[] = [];

  // Second pass uses a different slice of pages: scan later pages too.
  for (const pdf of input.localPdfPaths) {
    const pageCount = getPdfPageCount(pdf.path) ?? 0;
    const scanPages = pageCount > 0 ? Math.min(pageCount, input.maxPagesPerDoc) : input.maxPagesPerDoc;

    // sample pages: first 10 + last 10 within scanPages (non-overlapping)
    const pages = new Set<number>();
    for (let p = 1; p <= Math.min(10, scanPages); p++) pages.add(p);
    for (let p = Math.max(1, scanPages - 9); p <= scanPages; p++) pages.add(p);

    for (const p of [...pages].sort((a, b) => a - b)) {
      const pageText = pdftotextPage(pdf.path, p);
      if (!pageText) continue;

      // Look for explicit codes or exit/egress keywords to confirm counts.
      const codeHits = input.codes.some((c) => new RegExp(`\\b${c.replace(/[-]/g, '[- ]?')}\\b`, 'i').test(pageText));
      const isEgressy = /exit\s+sign|egress|occupant\s+load/i.test(pageText);
      if (!codeHits && !isEgressy) continue;

      const kind = detectKind(pageText);
      const snippets = pickSnippetsFromPage(pageText, 2);
      for (const snip of snippets) {
        evidence.push({ filename: pdf.filename, page: p, kind, text: snip });
      }
    }
  }

  return evidence.slice(0, 80);
}

export async function estimatorTakeoffFromLocalPdfs(input: {
  localPdfPaths: Array<{ filename: string; path: string }>;
  maxPagesPerDoc?: number;
}): Promise<{ evidence: EvidenceSnippet[]; result: EstimatorTakeoffResult }>{
  const maxPagesPerDoc = input.maxPagesPerDoc ?? 40;

  const evidence: EvidenceSnippet[] = [];

  for (const pdf of input.localPdfPaths) {
    const pageCount = getPdfPageCount(pdf.path) ?? 0;
    const scanPages = pageCount > 0 ? Math.min(pageCount, maxPagesPerDoc) : maxPagesPerDoc;

    for (let p = 1; p <= scanPages; p++) {
      const pageText = pdftotextPage(pdf.path, p);
      if (!pageText) continue;

      const kind = detectKind(pageText);
      if (kind === 'unknown') continue;

      const snippets = pickSnippetsFromPage(pageText, 2);
      for (const snip of snippets) {
        evidence.push({ filename: pdf.filename, page: p, kind, text: snip });
      }
    }
  }

  const kindOrder: Record<EvidenceSnippet['kind'], number> = {
    schedule: 1,
    legend: 2,
    egress: 3,
    keynote: 4,
    code: 5,
    plan: 6,
    unknown: 9,
  };
  evidence.sort((a, b) => (kindOrder[a.kind] - kindOrder[b.kind]) || a.filename.localeCompare(b.filename) || a.page - b.page);

  const evidenceForPrompt = evidence.slice(0, 120);

  const system =
    `You are a senior signage estimator assistant. Your job is to produce a signage takeoff from construction bid PDFs.\n` +
    `Rules:\n` +
    `- Prefer authoritative sources (schedules > plans; egress tables for room signage; electrical plans for exit signs; health code for pool signs).\n` +
    `- Every quantity MUST include citations: filename + page + an evidence snippet + why that source is authoritative.\n` +
    `- Flag ambiguities and missing information for human review.\n` +
    `- Output MUST be valid JSON matching the schema. No markdown.\n`;

  const schemaHint = {
    items: [
      {
        category: 'Exit Signs',
        description: 'EXIT SIGN, LED, double-face',
        qty: '12',
        confidence: 0.88,
        sources: [
          {
            filename: 'E1.01 Electrical Plans.pdf',
            page: 42,
            sheetRef: 'E1.01',
            evidence: 'EXIT SIGN TYPE X ... QTY 12',
            whyAuthoritative: 'Exit sign counts are governed by electrical/egress plan callouts',
          },
        ],
        reviewFlags: ['verify sheet ref', 'confirm single vs double face'],
      },
    ],
    discrepancyLog: [
      {
        issue: 'Schedule quantity conflicts with plan tag count for Type D7',
        sources: [
          { filename: 'Signage Schedule.pdf', page: 5, evidence: 'D7 ... QTY 8' },
          { filename: 'A2.11 Plans.pdf', page: 17, evidence: 'D7 tags appear 10 times' },
        ],
      },
    ],
    missingItems: ['No signage legend found for pool regulatory signs'],
    reviewFlags: ['Needs confirmation of authoritative schedule source'],
    notes: 'Summary / assumptions / where to spot-check',
  };

  const user = {
    bidContext: {
      task: 'signage takeoff',
      expectation: 'senior estimator level',
    },
    evidence: evidenceForPrompt,
    outputSchema: schemaHint,
  };

  const completion = await openclawChatCompletions({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(user) },
    ],
    temperature: 0.2,
  });

  const text = completion?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    throw new Error('OpenClaw returned no text content');
  }

  let parsed: EstimatorTakeoffResult;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to parse JSON from OpenClaw response');
    parsed = JSON.parse(match[0]);
  }

  // ======================
  // Second-pass verification
  // ======================
  const codes = extractLikelySignCodes(parsed.items, 25);
  const verificationEvidence = await buildVerificationEvidence({
    localPdfPaths: input.localPdfPaths,
    codes,
    maxPagesPerDoc,
  });

  // Deterministic cross-check: count code occurrences in verification pages and compare with qty when numeric.
  let issuesFound = 0;
  const verificationNotes: string[] = [];

  for (const it of parsed.items.slice(0, 15)) {
    const qtyNum = Number(String(it.qty).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) continue;

    const code = (it.description.match(/\b([A-Z]{1,3}\s?-?\d{1,2})\b/) || [])[1];
    if (!code) continue;

    const re = new RegExp(`\\b${code.replace(/\s+/g, '').replace(/[-]/g, '[- ]?')}\\b`, 'gi');
    const totalHits = verificationEvidence.reduce((s, e) => s + countOccurrencesInText(e.text, re), 0);

    // Only flag when the signal is strong.
    if (totalHits >= 3 && Math.abs(totalHits - qtyNum) / Math.max(1, qtyNum) >= 0.25) {
      issuesFound++;
      parsed.discrepancyLog = parsed.discrepancyLog || [];
      parsed.discrepancyLog.push({
        issue: `Second-pass check: code ${code} appears ~${totalHits}x in sampled pages; takeoff qty=${qtyNum}. Spot-check recommended.`,
        sources: verificationEvidence.slice(0, 4).map((e) => ({ filename: e.filename, page: e.page, evidence: e.text })),
      });
      parsed.reviewFlags = parsed.reviewFlags || [];
      parsed.reviewFlags.push(`Verify quantity for ${code} (second-pass mismatch)`);
    }
  }

  verificationNotes.push(`Second pass scanned ${verificationEvidence.length} evidence snippets.`);
  if (codes.length > 0) verificationNotes.push(`Checked codes: ${codes.slice(0, 10).join(', ')}${codes.length > 10 ? '…' : ''}`);

  parsed.verification = {
    method: 'two-pass: primary evidence scan + targeted later-page sampling + deterministic code hit cross-check',
    checkedItems: Math.min(15, parsed.items.length),
    issuesFound,
    notes: verificationNotes.join(' '),
  };

  return { evidence: [...evidence, ...verificationEvidence], result: parsed };
}
