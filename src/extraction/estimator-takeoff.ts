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
};

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
    // -layout helps schedules; keep buffer high.
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

  // Prefer lines with quantities or sign-ish tokens
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

  // Sort: schedules/legends first
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

  // Limit evidence to keep prompt bounded
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
    // Sometimes the model returns leading text; try to extract JSON object.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Failed to parse JSON from OpenClaw response');
    parsed = JSON.parse(match[0]);
  }

  return { evidence, result: parsed };
}
