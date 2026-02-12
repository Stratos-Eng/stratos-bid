/* eslint-disable no-console */

import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

import { ensurePdfReadableInPlace } from '@/extraction/pdf-utils';

export type OcrTile = {
  row: number;
  col: number;
  overlapPx: number;
  dpi: number;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
};

function safeExec(cmd: string, opts: { timeoutMs: number; maxBufferMb: number; stdio?: any } ) {
  return execSync(cmd, {
    encoding: 'utf-8',
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBufferMb * 1024 * 1024,
    stdio: opts.stdio ?? 'ignore',
  });
}

export function getPdfPageSizePts(pdfPath: string, page = 1): { widthPts: number; heightPts: number } | null {
  try {
    ensurePdfReadableInPlace(pdfPath);
    const out = execSync(`pdfinfo -f ${page} -l ${page} "${pdfPath}"`, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    const m = out.match(/Page\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/i);
    if (!m) return null;
    return { widthPts: Number(m[1]), heightPts: Number(m[2]) };
  } catch {
    return null;
  }
}

export function normalizeOcrText(raw: string): string {
  let t = (raw || '').replace(/\r/g, '\n');
  // normalize dash variants common in OCR output
  t = t.replace(/[—–−_]/g, '-');
  // normalize weird whitespace
  t = t.replace(/\u00A0/g, ' ');
  return t;
}

export function extractCodeCandidatesFromText(text: string): string[] {
  const t = normalizeOcrText(text).toUpperCase();
  const out: string[] = [];

  const patterns: RegExp[] = [
    // Broad hyphenated family (MUTCD-like + custom facility)
    /\b([A-Z]{1,4}\d{0,3}-[A-Z]?\d{1,4}[A-Z]?)\b/g,
    // Pure alphanumeric (R81, W48, etc.)
    /\b([A-Z]{1,2}\d{2,3}[A-Z]?)\b/g,
    // WS / PS / ES style
    /\b([A-Z]{2,4}-\d{2,3})\b/g,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const tok = m[1];
      if (!tok) continue;
      if (tok.length < 2 || tok.length > 12) continue;
      out.push(tok);
    }
  }

  return out;
}

export function ocrTiledPage(input: {
  pdfPath: string;
  page: number;
  dpi?: number;
  rows?: number;
  cols?: number;
  overlapPx?: number;
}): OcrTile[] {
  const dpi = input.dpi ?? 300;
  const rows = input.rows ?? 3;
  const cols = input.cols ?? 2;
  const overlapPx = input.overlapPx ?? 20;

  ensurePdfReadableInPlace(input.pdfPath);

  const sz = getPdfPageSizePts(input.pdfPath, input.page);
  if (!sz) return [];

  const pageWpx = Math.max(1, Math.round((sz.widthPts / 72) * dpi));
  const pageHpx = Math.max(1, Math.round((sz.heightPts / 72) * dpi));

  const tileW = Math.ceil(pageWpx / cols);
  const tileH = Math.ceil(pageHpx / rows);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'takeoff-tile-ocr-'));
  const tiles: OcrTile[] = [];

  try {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = Math.max(0, c * tileW - overlapPx);
        const y0 = Math.max(0, r * tileH - overlapPx);
        const x1 = Math.min(pageWpx, (c + 1) * tileW + overlapPx);
        const y1 = Math.min(pageHpx, (r + 1) * tileH + overlapPx);
        const w = Math.max(1, x1 - x0);
        const h = Math.max(1, y1 - y0);

        const outBase = path.join(dir, `p${input.page}_r${r}_c${c}`);

        // pdftoppm crop coords are in pixels at the target resolution
        // -singlefile ensures a stable output name.
        safeExec(
          `pdftoppm -f ${input.page} -l ${input.page} -png -r ${dpi} -x ${x0} -y ${y0} -W ${w} -H ${h} -singlefile "${input.pdfPath}" "${outBase}"`,
          { timeoutMs: 90_000, maxBufferMb: 50 }
        );

        const pngPath = `${outBase}.png`;
        const raw = safeExec(`tesseract "${pngPath}" stdout -l eng`, { timeoutMs: 90_000, maxBufferMb: 10, stdio: undefined });
        const text = normalizeOcrText(raw || '').trim();

        tiles.push({ row: r, col: c, overlapPx, dpi, x: x0, y: y0, w, h, text });
      }
    }

    return tiles;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
