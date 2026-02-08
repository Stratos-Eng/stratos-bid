import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { ensurePdfReadableInPlace } from '@/extraction/pdf-utils';

export function getPdfPageCount(pdfPath: string): number {
  try {
    ensurePdfReadableInPlace(pdfPath);
    const out = execSync(`pdfinfo "${pdfPath}"`, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    const m = out.match(/Pages:\s+(\d+)/i);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

export function pdftotextPage(pdfPath: string, page: number): string {
  const t0 = Date.now();
  try {
    ensurePdfReadableInPlace(pdfPath);
    const out = execSync(`pdftotext -layout -f ${page} -l ${page} "${pdfPath}" -`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 25_000,
    });
    if (Date.now() - t0 > 4000) {
      // eslint-disable-next-line no-console
      console.log(`[pdf-artifacts] slow pdftotext p${page} ${Date.now() - t0}ms: ${path.basename(pdfPath)}`);
    }
    return out;
  } catch {
    return '';
  }
}

export function ocrPage(pdfPath: string, page: number): string {
  const t0 = Date.now();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'takeoff-ocr-'));
  try {
    ensurePdfReadableInPlace(pdfPath);
    const outBase = path.join(dir, 'page');
    // Render just one page to PNG (single output file)
    // -singlefile avoids page-numbered output naming differences across poppler versions.
    execSync(`pdftoppm -f ${page} -l ${page} -png -r 200 -singlefile "${pdfPath}" "${outBase}"`, {
      stdio: 'ignore',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 45_000,
    });

    const pngPath = `${outBase}.png`;
    // tesseract to stdout
    const txt = execSync(`tesseract "${pngPath}" stdout -l eng`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });
    if (Date.now() - t0 > 8000) {
      // eslint-disable-next-line no-console
      console.log(`[pdf-artifacts] slow ocr p${page} ${Date.now() - t0}ms: ${path.basename(pdfPath)}`);
    }
    return txt || '';
  } catch (e) {
    // Avoid noisy tesseract/pdftoppm errors; caller will treat as empty OCR.
    return '';
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function extractPageTextWithFallback(input: {
  pdfPath: string;
  page: number;
  ocrMinChars?: number;
}): { method: 'pdftotext' | 'ocr' | 'none'; text: string; meta: { textLength: number } } {
  const ocrMinChars = input.ocrMinChars ?? 30;

  const text0 = pdftotextPage(input.pdfPath, input.page);
  const t0 = (text0 || '').trim();
  if (t0.length >= ocrMinChars) {
    return { method: 'pdftotext', text: t0, meta: { textLength: t0.length } };
  }

  const text1 = ocrPage(input.pdfPath, input.page);
  const t1 = (text1 || '').trim();
  if (t1.length > 0) {
    return { method: 'ocr', text: t1, meta: { textLength: t1.length } };
  }

  return { method: 'none', text: '', meta: { textLength: 0 } };
}
