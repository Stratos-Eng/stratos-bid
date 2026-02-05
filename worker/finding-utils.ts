export type DerivedFinding =
  | { type: 'page_header'; data: { symbol: string; title?: string } }
  | { type: 'schedule_row'; data: { code: string; description: string; qty?: number } }
  | { type: 'callout'; data: { callout: string } }
  | { type: 'code_hit'; data: { code: string } };

const RE_CALLOUT = /\b\d+\.[A-Z]{1,3}\d{1,2}\.\d+\b/g;
const RE_SYMBOL = /\b([A-Z]\d{1,2}\.\d)\b/g;
const RE_CODE = /\b([A-Z]{1,3}\s?-?\d{1,2})\b/g;

// Schedule-ish row: CODE ... QTY (very heuristic)
const RE_SCHEDULE_ROW = /\b([A-Z]{1,3}\s?-?\d{1,2})\b\s+([A-Za-z][A-Za-z0-9\s\-"'&/()]{3,80}?)\s+(\d{1,4})\b/;

export function deriveFindingsFromText(text: string): DerivedFinding[] {
  const out: DerivedFinding[] = [];

  // callouts
  const callouts = new Set((text.match(RE_CALLOUT) || []).map((s) => s.trim()));
  for (const c of callouts) out.push({ type: 'callout', data: { callout: c } });

  // symbols (like D12.1)
  const symbols = new Set((text.match(RE_SYMBOL) || []).map((s) => s.trim()));
  for (const sym of symbols) {
    // promote to header only if there are likely section words nearby
    if (/signage|schedule|legend|parking|site/i.test(text)) {
      out.push({ type: 'page_header', data: { symbol: sym } });
    }
  }

  // schedule rows
  const m = text.match(RE_SCHEDULE_ROW);
  if (m) {
    const code = m[1].replace(/\s+/g, '').toUpperCase();
    out.push({
      type: 'schedule_row',
      data: { code, description: m[2].trim(), qty: Number(m[3]) },
    });
  }

  // code hits
  const codes = new Set(
    (text.match(RE_CODE) || [])
      .map((s) => s.replace(/\s+/g, '').toUpperCase())
      .filter((s) => s.length >= 2)
  );
  for (const code of codes) out.push({ type: 'code_hit', data: { code } });

  return out;
}
