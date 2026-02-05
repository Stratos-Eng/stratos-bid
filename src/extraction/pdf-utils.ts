import { execSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

/**
 * Best-effort PDF normalization.
 *
 * Some bid PDFs trigger Poppler errors like:
 *   "Syntax Error: Bad block header in flate stream"
 * which can cause pdftotext/pdfinfo to return empty output.
 *
 * Strategy:
 * 1) qpdf --check
 * 2) qpdf --repair --stream-data=uncompress (in-place via temp file)
 * 3) ghostscript pdfwrite re-distill (fallback)
 */
export function ensurePdfReadableInPlace(pdfPath: string): void {
  // Quick check. If qpdf isn't installed or check fails, we try to repair.
  try {
    execSync(`qpdf --check --no-warn "${pdfPath}"`, {
      stdio: 'ignore',
      timeout: 30_000,
    });
    return;
  } catch {
    // continue to repair
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'stratos-pdf-repair-'));
  const repairedQpdf = join(tempDir, 'repaired-qpdf.pdf');
  const repairedGs = join(tempDir, 'repaired-gs.pdf');

  // 1) qpdf repair
  try {
    execSync(
      `qpdf --repair --stream-data=uncompress "${pdfPath}" "${repairedQpdf}"`,
      { stdio: 'ignore', timeout: 120_000 }
    );
    execSync(`mv -f "${repairedQpdf}" "${pdfPath}"`, { stdio: 'ignore' });
    return;
  } catch {
    // continue to ghostscript
  }

  // 2) ghostscript re-distill
  try {
    execSync(
      `gs -o "${repairedGs}" -sDEVICE=pdfwrite -dPDFSETTINGS=/prepress "${pdfPath}"`,
      { stdio: 'ignore', timeout: 180_000 }
    );
    execSync(`mv -f "${repairedGs}" "${pdfPath}"`, { stdio: 'ignore' });
    return;
  } catch {
    // give up; caller will handle empty extraction
  }
}
