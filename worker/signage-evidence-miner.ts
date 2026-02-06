import { createHash } from 'crypto';

export type EvidenceHit = {
  category: 'ADA' | 'Wayfinding' | 'Construction' | 'Regulatory' | 'General';
  kind: 'note' | 'callout';
  excerpt: string;
  score: number;
};

function clip(s: string, max = 380) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

export function hashText(s: string) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function mineSignageEvidence(text: string): EvidenceHit[] {
  const t = (text || '').trim();
  if (!t) return [];

  const lower = t.toLowerCase();

  // quick reject: if none of these appear, skip
  if (!/(sign|signage|ada|braille|tactile|wayfinding|exit|egress|fire|room\s*id|identification|directional|parking|notice|warning|construction)/i.test(lower)) {
    return [];
  }

  const lines = t
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const hits: EvidenceHit[] = [];

  for (const line of lines) {
    const l = line.toLowerCase();
    let score = 0;
    let category: EvidenceHit['category'] = 'General';
    let kind: EvidenceHit['kind'] = 'note';

    if (/(ada|tactile|braille)/.test(l)) {
      category = 'ADA';
      score += 30;
    }

    if (/(wayfinding|directional|identification|room\s*id)/.test(l)) {
      category = category === 'General' ? 'Wayfinding' : category;
      score += 20;
    }

    if (/(construction|temp\b|temporary)/.test(l)) {
      category = category === 'General' ? 'Construction' : category;
      score += 15;
    }

    if (/(exit|egress|fire|stair|elevator|parking|notice|warning)/.test(l)) {
      category = category === 'General' ? 'Regulatory' : category;
      score += 12;
    }

    if (/(signage|\bsign\b)/.test(l)) score += 10;
    if (/(provide|furnish|install|place|mount)/.test(l)) score += 8;

    // crude sign callout patterns: S-101, S1, W-12, ID-3 etc.
    if (/\b([a-z]{1,3}-?\d{1,4})\b/i.test(line) && /(sign|signage|type)/.test(l)) {
      kind = 'callout';
      score += 10;
    }

    if (score >= 18) {
      hits.push({ category, kind, excerpt: clip(line), score });
    }
  }

  // Keep best few per page
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 8);
}
