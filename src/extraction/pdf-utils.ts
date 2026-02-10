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
 * IMPORTANT: Do NOT blindly "repair" every PDF — it is expensive on large plan sets
 * (hundreds of MB / thousands of pages) and can time out even when the PDF is actually
 * readable. We first do a cheap health check, and only run repair if that fails.
 *
 * Strategy:
 * 0) quick check (qpdf --check)
 * 1) qpdf --repair --stream-data=uncompress (in-place via temp file)
 * 2) ghostscript pdfwrite re-distill (fallback)
 */
const repaired = new Set<string>();
const repairFailed = new Set<string>();
const checkedOk = new Set<string>();

export function ensurePdfReadableInPlace(pdfPath: string): void {
  const t0 = Date.now();

  // If we've already verified this PDF is OK, skip any work.
  if (checkedOk.has(pdfPath)) return;

  // Avoid repeatedly rewriting the same file in a single run.
  if (repaired.has(pdfPath)) return;

  // If repair already failed once, don't keep retrying (it can be very expensive).
  if (repairFailed.has(pdfPath)) return;

  // Cheap sanity check: if qpdf --check passes quickly, treat it as readable.
  try {
    execSync(`qpdf --check "${pdfPath}"`, { stdio: 'ignore', timeout: 2_000 });
    checkedOk.add(pdfPath);
    return;
  } catch {
    // fall through to repair attempts
  }

  repaired.add(pdfPath);

  const tempDir = mkdtempSync(join(tmpdir(), 'stratos-pdf-repair-'));
  const repairedQpdf = join(tempDir, 'repaired-qpdf.pdf');
  const repairedGs = join(tempDir, 'repaired-gs.pdf');

  // Try qpdf repair first (fast, often fixes poppler stream issues)
  try {
    execSync(
      `qpdf --repair --stream-data=uncompress "${pdfPath}" "${repairedQpdf}"`,
      { stdio: 'ignore', timeout: 30_000 }
    );
    // eslint-disable-next-line no-console
    console.log(`[pdf-utils] qpdf repair ok in ${Date.now() - t0}ms: ${pdfPath}`);
    execSync(`mv -f "${repairedQpdf}" "${pdfPath}"`, { stdio: 'ignore' });
    return;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[pdf-utils] qpdf repair failed in ${Date.now() - t0}ms: ${pdfPath}`);
    // continue
  }

  // Fallback: ghostscript re-distill
  try {
    execSync(
      `gs -o "${repairedGs}" -sDEVICE=pdfwrite -dPDFSETTINGS=/prepress "${pdfPath}"`,
      { stdio: 'ignore', timeout: 60_000 }
    );
    // eslint-disable-next-line no-console
    console.log(`[pdf-utils] gs repair ok in ${Date.now() - t0}ms: ${pdfPath}`);
    execSync(`mv -f "${repairedGs}" "${pdfPath}"`, { stdio: 'ignore' });
    return;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[pdf-utils] gs repair failed in ${Date.now() - t0}ms: ${pdfPath}`);
    repairFailed.add(pdfPath);
    // give up; caller will handle empty extraction
  }
}
