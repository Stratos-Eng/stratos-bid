/* eslint-disable no-console */

import { createHash, randomUUID } from 'crypto';

import { ocrTiledPage, extractCodeCandidatesFromText, normalizeOcrText } from './tiled-ocr';

export type Placement = {
  code: string;
  pageNumber: number;
  evidenceText: string;
  meta: any;
};

function sha16(s: string) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function clipContext(text: string, idx: number, len: number, radius = 140) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + len + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

export function discoverCodesFromOcrTiles(tileTexts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of tileTexts) {
    for (const tok of extractCodeCandidatesFromText(t)) {
      counts.set(tok, (counts.get(tok) || 0) + 1);
    }
  }

  // keep tokens that repeat (filters a lot of OCR noise)
  const tokens = Array.from(counts.entries())
    .filter(([tok, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([tok]) => tok);

  return tokens.slice(0, 250);
}

export function extractPlacementsFromTiles(input: {
  pdfPath: string;
  page: number;
  codes: string[];
  overlapPx: number;
  dpi?: number;
}): Placement[] {
  const tiles = ocrTiledPage({ pdfPath: input.pdfPath, page: input.page, overlapPx: input.overlapPx, dpi: input.dpi ?? 300, rows: 3, cols: 2 });
  if (tiles.length === 0) return [];

  const set = new Set(input.codes.map((c) => c.toUpperCase()));

  const placements: Placement[] = [];

  for (const tile of tiles) {
    if (!tile.text) continue;
    const up = normalizeOcrText(tile.text).toUpperCase();

    // Fast scan for any known code tokens
    // NOTE: This is intentionally conservative: exact token match only.
    for (const code of set) {
      // token boundary match
      const re = new RegExp(`\\b${code.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(up))) {
        const ctx = clipContext(up, m.index, code.length);
        placements.push({
          code,
          pageNumber: input.page,
          evidenceText: ctx,
          meta: {
            method: 'tiled_ocr',
            overlapPx: input.overlapPx,
            dpi: tile.dpi,
            tile: { row: tile.row, col: tile.col, x: tile.x, y: tile.y, w: tile.w, h: tile.h },
          },
        });
        // guard against pathological loops
        if (placements.length > 6000) return placements;
      }
    }
  }

  return placements;
}

export function reconcileCounts(input: {
  textQty: number;
  primaryQty: number;
  verifyQty: number;
}): number {
  const { textQty, primaryQty, verifyQty } = input;
  const base = Math.round(verifyQty * 1.15);
  let best = Math.max(textQty, base);
  if (primaryQty > 0) best = Math.min(best, primaryQty);
  if (verifyQty === 0 && textQty === 0 && primaryQty > 0) best = Math.max(1, Math.round(primaryQty * 0.4));
  return best;
}

export function makeTypeRowsFromPlacements(codes: string[], countsByCode: Map<string, number>) {
  return codes.map((code) => ({
    id: randomUUID(),
    itemKey: `code:${code}`,
    code,
    category: 'Signage',
    description: code,
    qtyNumber: countsByCode.get(code) || 0,
    unit: 'EA',
    confidence: 0.6,
  }));
}
