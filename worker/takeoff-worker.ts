#!/usr/bin/env node
/* eslint-disable no-console */

import { createHash, randomUUID } from 'crypto';

function stableUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

import { deriveFindingsFromText } from './finding-utils';
import { extractPageTextWithFallback, getPdfPageCount } from './pdf-artifacts';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { db } from '@/db';
import { documents, lineItems, takeoffJobs, takeoffJobDocuments, takeoffRuns, takeoffArtifacts, takeoffFindings, takeoffItems, takeoffItemEvidence } from '@/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { downloadFile } from '@/lib/storage';
import { scoreAllDocuments, formatScoresForLog, getTopDocument } from '@/extraction/scoring';
import { detectSourceType, extractPdfText, tryFastPathExtraction } from '@/extraction/fast-path';
import { estimatorTakeoffFromLocalPdfs } from '@/extraction/estimator-takeoff';

type JobRow = typeof takeoffJobs.$inferSelect;

const WORKER_ID = process.env.WORKER_ID || `worker-${randomUUID().slice(0, 8)}`;
const POLL_INTERVAL_MS = Number(process.env.TAKEOFF_WORKER_POLL_MS || 2000);
const CLAIM_TIMEOUT_MS = Number(process.env.TAKEOFF_WORKER_CLAIM_TIMEOUT_MS || 30_000);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function claimNextJob(): Promise<JobRow | null> {
  // Use a single SQL statement to atomically claim a job.
  // We treat a job as claimable if:
  // - status = queued
  // - and (locked_at is null or lock is stale)
  const now = new Date();
  const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);

  const result = await db.execute(sql`
    WITH candidate AS (
      SELECT id
      FROM takeoff_jobs
      WHERE status = 'queued'
        AND (locked_at IS NULL OR locked_at < ${staleBefore})
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE takeoff_jobs
    SET lock_id = ${WORKER_ID},
        locked_at = ${now},
        status = 'running',
        attempts = attempts + 1,
        updated_at = ${now},
        started_at = COALESCE(started_at, ${now})
    WHERE id IN (SELECT id FROM candidate)
    RETURNING
      id,
      bid_id as "bidId",
      user_id as "userId",
      status,
      requested_document_ids as "requestedDocumentIds",
      bid_folder as "bidFolder",
      lock_id as "lockId",
      locked_at as "lockedAt",
      attempts,
      last_error as "lastError",
      created_at as "createdAt",
      updated_at as "updatedAt",
      started_at as "startedAt",
      finished_at as "finishedAt";
  `);

  const rows = (result as any)?.rows ? (result as any).rows as JobRow[] : (result as any as JobRow[]);
  return rows?.[0] || null;
}

async function getJobDocuments(jobId: string) {
  const rows = await db
    .select({
      doc: documents,
      link: takeoffJobDocuments,
    })
    .from(takeoffJobDocuments)
    .innerJoin(documents, eq(takeoffJobDocuments.documentId, documents.id))
    .where(eq(takeoffJobDocuments.jobId, jobId));

  return rows.map((r) => r.doc);
}

async function downloadBidPdfsToTemp(
  bidId: string
): Promise<{ tempDir: string; docIdBySafeName: Map<string, string> }> {
  const tempDir = await mkdtemp(join(tmpdir(), `stratos-bid-${bidId}-`));
  const docIdBySafeName = new Map<string, string>();

  const bidDocs = await db
    .select({ id: documents.id, filename: documents.filename, storagePath: documents.storagePath, pageCount: documents.pageCount })
    .from(documents)
    .where(eq(documents.bidId, bidId));

  let downloaded = 0;
  for (const doc of bidDocs) {
    if (!doc.storagePath) continue;
    try {
      const buffer = await downloadFile(doc.storagePath);
      const safeName = doc.filename.replace(/[^a-zA-Z0-9._()-]/g, '_');
      const localPath = join(tempDir, safeName);
      await writeFile(localPath, buffer);
      docIdBySafeName.set(safeName, doc.id);
      downloaded++;

      // If pageCount was deferred at upload time, fill it in now (cheap) using local pdfinfo.
      if (doc.pageCount == null) {
        const pc = getPdfPageCount(localPath);
        if (pc > 0) {
          try {
            await db.update(documents).set({ pageCount: pc }).where(eq(documents.id, doc.id));
          } catch (e) {
            console.warn(`[takeoff-worker] Failed to update pageCount for ${doc.filename}:`, e instanceof Error ? e.message : e);
          }
        }
      }
    } catch (err) {
      console.warn(`[takeoff-worker] Failed to download ${doc.filename}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[takeoff-worker] Downloaded ${downloaded}/${bidDocs.length} PDFs to ${tempDir}`);
  return { tempDir, docIdBySafeName };
}

async function runJob(job: JobRow) {
  const bidId = job.bidId;

  // Load documents
  const docs = await getJobDocuments(job.id);
  const documentIds = docs.map((d) => d.id);

  // Create a takeoff run (v2 workspace)
  const runId = randomUUID();
  await db.insert(takeoffRuns).values({
    id: runId,
    jobId: job.id,
    bidId,
    userId: job.userId,
    status: 'running',
    workerId: WORKER_ID,
    extractorVersion: process.env.GIT_SHA || null,
    model: 'openclaw:Stratos-bid',
    startedAt: new Date(),
    updatedAt: new Date(),
  } as any);

  // Update doc statuses to extracting
  await db
    .update(documents)
    .set({ extractionStatus: 'extracting' })
    .where(inArray(documents.id, documentIds));

  const { tempDir: localBidFolder, docIdBySafeName } = await downloadBidPdfsToTemp(bidId);

  try {
    // STEP 1: score docs
    const scoredDocs = await scoreAllDocuments(localBidFolder, 'division_10', false);
    console.log(`[takeoff-worker] Document scores:\n${formatScoresForLog(scoredDocs)}`);

    // STEP 2: fast-path
    const topDoc = getTopDocument(scoredDocs, 80);
    if (topDoc) {
      const text = await extractPdfText(topDoc.path);
      if (text && text.length >= 100) {
        const sourceType = detectSourceType(text);
        if (sourceType) {
          const fp = tryFastPathExtraction(text, sourceType);
          if (fp && fp.confidence >= 0.85) {
            // Save line items
            const values = fp.entries.map((entry) => ({
              documentId: documentIds[0],
              bidId,
              userId: job.userId,
              tradeCode: 'division_10',
              category: entry.name,
              description: `${entry.name}${entry.roomNumber ? ` (${entry.roomNumber})` : ''}`,
              estimatedQty: String(entry.quantity),
              unit: 'EA',
              notes: `Source: ${fp.source}`,
              pageNumber: entry.pageNumbers[0],
              pageReference: entry.sheetRefs.join(', '),
              extractionConfidence: entry.confidence,
              extractionModel: 'signage-fast-path',
              rawExtractionJson: {
                id: entry.id,
                identifier: entry.identifier,
                source: entry.source,
                isGrouped: entry.isGrouped,
                signTypeCode: entry.signTypeCode,
              },
              // UI expects: pending|approved|rejected|modified. Keep pending and encode review needs in notes/flags.
              reviewStatus: 'pending',
              extractedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            }));

            if (values.length > 0) {
              await db.insert(lineItems).values(values);

              // Also write v2 takeoff items (best-effort)
              const itemRows = fp.entries.map((entry) => {
                const code = entry.signTypeCode || entry.identifier;
                const itemKey = `division_10:${code}:${String(entry.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
                return {
                  id: randomUUID(),
                  runId,
                  bidId,
                  userId: job.userId,
                  tradeCode: 'division_10',
                  itemKey,
                  code,
                  category: entry.name,
                  description: `${entry.name}${entry.roomNumber ? ` (${entry.roomNumber})` : ''}`,
                  qtyNumber: entry.quantity,
                  qtyText: null,
                  unit: 'EA',
                  confidence: entry.confidence,
                  status: entry.confidence >= 0.8 ? 'draft' : 'needs_review',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                };
              });
              if (itemRows.length > 0) await db.insert(takeoffItems).values(itemRows as any);
            }

            await db
              .update(documents)
              .set({
                extractionStatus: 'completed',
                lineItemCount: fp.entries.length,
                signageLegend: {
                  fastPathExtraction: true,
                  skippedAI: true,
                  totalCount: fp.totalCount,
                  confidence: fp.confidence,
                  source: fp.source,
                  issues: fp.issues,
                  notes: fp.notes,
                  extractedAt: new Date().toISOString(),
                  tokenUsage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
                },
              })
              .where(inArray(documents.id, documentIds));

            await db
              .update(takeoffJobs)
              .set({
                status: 'succeeded',
                updatedAt: new Date(),
                finishedAt: new Date(),
              })
              .where(eq(takeoffJobs.id, job.id));

            await db
              .update(takeoffRuns)
              .set({ status: 'succeeded', updatedAt: new Date(), finishedAt: new Date() } as any)
              .where(eq(takeoffRuns.id, runId));

            console.log(`[takeoff-worker] Fast-path complete for bid ${bidId}: ${fp.entries.length} items`);
            return;
          }
        }
      }
    }

    // STEP 3: estimator-grade takeoff (OpenClaw) + second-pass verification
    const localPdfPaths = scoredDocs
      .slice(0, 5)
      .map((d) => ({ filename: d.filename, path: d.path }));

    // STEP 3a: page-level extraction coverage + OCR escalation (artifacts)
    try {
      const artifactRows: any[] = [];
      for (const pdf of localPdfPaths) {
        const documentId = docIdBySafeName.get(pdf.filename) ?? documentIds[0];
        const pageCount = getPdfPageCount(pdf.path);
        const scanPages = pageCount > 0 ? Math.min(pageCount, 60) : 60;

        for (let p = 1; p <= scanPages; p++) {
          // Smart OCR: always possible, but avoid OCRing every thin page blindly.
          // Heuristic: OCR thin pages only if early/late in set OR page looks schedule-ish.
          const extracted0 = extractPageTextWithFallback({ pdfPath: pdf.path, page: p, ocrMinChars: Number.POSITIVE_INFINITY });
          const t0 = (extracted0.text || '').trim();

          const looksScheduley = /schedule|legend|sign\s+type|type\s+code|qty|quantity|signage/i.test(t0);
          const isEarly = p <= 15;
          const isLate = pageCount > 0 ? p >= Math.max(1, scanPages - 9) : false;

          const doOcr = process.env.TAKEOFF_OCR_MODE === 'full'
            ? t0.length < 30
            : t0.length < 30 && (looksScheduley || isEarly || isLate);

          const extracted = doOcr
            ? extractPageTextWithFallback({ pdfPath: pdf.path, page: p, ocrMinChars: 30 })
            : { method: 'pdftotext' as const, text: t0, meta: { textLength: t0.length } };

          artifactRows.push({
            runId,
            bidId,
            documentId,
            pageNumber: p,
            method: extracted.method,
            rawText: extracted.text ? extracted.text.slice(0, 10_000) : null,
            meta: { ...extracted.meta, ocrMode: process.env.TAKEOFF_OCR_MODE || 'smart' },
            createdAt: new Date(),
          });
        }
      }

      // insert in chunks to avoid giant single statement
      const chunkSize = 200;
      for (let i = 0; i < artifactRows.length; i += chunkSize) {
        const chunk = artifactRows.slice(i, i + chunkSize);
        if (chunk.length > 0) await db.insert(takeoffArtifacts).values(chunk as any);
      }
    } catch (err) {
      console.warn('[takeoff-worker] artifacts write failed (non-fatal):', err);
    }

    const { result, evidence } = await estimatorTakeoffFromLocalPdfs({
      localPdfPaths,
      maxPagesPerDoc: 60,
    });

    const values = result.items.map((item, idx) => ({
      documentId: documentIds[0],
      bidId,
      userId: job.userId,
      tradeCode: 'division_10',
      category: item.category,
      description: item.description,
      estimatedQty: item.qty,
      unit: 'EA',
      notes: [
        ...(item.confidence < 0.8 ? ['LOW_CONFIDENCE: review recommended'] : []),
        ...((item.reviewFlags || []).map((f) => `FLAG: ${f}`)),
        ...item.sources.slice(0, 3).map((s) => `Source: ${s.filename} p${s.page} — ${s.whyAuthoritative}`),
      ].join(' | '),
      pageNumber: item.sources?.[0]?.page,
      pageReference: item.sources?.[0]?.sheetRef,
      extractionConfidence: item.confidence,
      extractionModel: 'openclaw:Stratos-bid',
      rawExtractionJson: {
        itemIndex: idx,
        item,
        discrepancyLog: result.discrepancyLog,
        missingItems: result.missingItems,
        reviewFlags: result.reviewFlags,
        verification: result.verification,
        evidenceSample: evidence.slice(0, 120),
      },
      // UI expects: pending|approved|rejected|modified. Keep pending and encode review needs in flags.
      reviewStatus: 'pending',
      extractedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    if (values.length > 0) await db.insert(lineItems).values(values);

    // v2 workspace: write findings + items + evidence links
    // NOTE: Neon HTTP driver does not support transactions. We rely on idempotent inserts + ordering.
    {
      const findingRows: any[] = [];
      const findingIdByKey = new Map<string, string>();

      // Evidence snippets (pass2) as findings
      for (const snip of evidence.slice(0, 500)) {
        const fid = randomUUID();
        const key = `${snip.filename}|${snip.page}|${snip.text}`;
        findingIdByKey.set(key, fid);
        findingRows.push({
          id: fid,
          runId,
          bidId,
          documentId: docIdBySafeName.get(snip.filename) ?? documentIds[0],
          pageNumber: snip.page,
          type: 'snippet',
          confidence: null,
          data: { kind: snip.kind },
          evidenceText: snip.text,
          evidence: { filename: snip.filename, page: snip.page },
          createdAt: new Date(),
        });
      }

      // Sources cited by items as findings (deduped)
      for (const it of result.items) {
        for (const s of (it.sources || []).slice(0, 20)) {
          const key = `${s.filename}|${s.page}|${s.evidence}`;
          if (findingIdByKey.has(key)) continue;
          const fid = randomUUID();
          findingIdByKey.set(key, fid);
          findingRows.push({
            id: fid,
            runId,
            bidId,
            documentId: docIdBySafeName.get(s.filename) ?? documentIds[0],
            pageNumber: s.page,
            type: 'source',
            confidence: it.confidence ?? null,
            data: { whyAuthoritative: s.whyAuthoritative, sheetRef: s.sheetRef },
            evidenceText: s.evidence,
            evidence: { filename: s.filename, page: s.page, sheetRef: s.sheetRef },
            createdAt: new Date(),
          });
        }
      }

      // Derived findings from evidence snippets/sources (header/schedule/callout/code_hit)
      const derivedRows: any[] = [];
      for (const fr of findingRows) {
        const t = String(fr.evidenceText || '');
        if (!t) continue;
        for (const d of deriveFindingsFromText(t)) {
          derivedRows.push({
            id: randomUUID(),
            runId,
            bidId,
            documentId: fr.documentId,
            pageNumber: fr.pageNumber,
            type: d.type,
            confidence: fr.confidence,
            data: d.data,
            evidenceText: fr.evidenceText,
            evidence: fr.evidence,
            createdAt: new Date(),
          });
        }
      }

      const insertChunked = async (rows: any[], chunkSize: number) => {
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          if (chunk.length > 0) await db.insert(takeoffFindings).values(chunk as any);
        }
      };

      if (findingRows.length > 0) {
        await insertChunked(findingRows, 200);
      }
      if (derivedRows.length > 0) {
        await insertChunked(derivedRows, 200);
      }

      const itemRows: any[] = [];
      const evidenceLinks: any[] = [];

      // Also compile items from derived schedule_row findings when they include explicit qty
      for (const dr of derivedRows) {
        if (dr.type !== 'schedule_row') continue;
        const code = dr.data?.code ? String(dr.data.code) : null;
        const desc = dr.data?.description ? String(dr.data.description) : '';
        const qty = typeof dr.data?.qty === 'number' ? dr.data.qty : null;
        if (!code || !desc || qty == null) continue;

        const itemKey = `division_10:${code}:${desc.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 220);
        const itemId = stableUuid(`${runId}|${itemKey}`);

        itemRows.push({
          id: itemId,
          runId,
          bidId,
          userId: job.userId,
          tradeCode: 'division_10',
          itemKey,
          code,
          category: 'Schedule',
          description: desc,
          qtyNumber: qty,
          qtyText: null,
          unit: 'EA',
          confidence: dr.confidence ?? null,
          status: 'draft',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // link evidence to the source finding (best-effort)
        evidenceLinks.push({
          id: randomUUID(),
          itemId,
          findingId: dr.id,
          weight: null,
          note: 'derived from schedule_row',
          createdAt: new Date(),
        });
      }

      for (const it of result.items) {
        const codeMatch = (it.description || '').match(/\b([A-Z]{1,3}\s?-?\d{1,2})\b/);
        const code = codeMatch ? codeMatch[1].replace(/\s+/g, '').toUpperCase() : null;
        const itemKey = `division_10:${code || 'NA'}:${String(it.description || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 220);
        const itemId = stableUuid(`${runId}|${itemKey}`);

        itemRows.push({
          id: itemId,
          runId,
          bidId,
          userId: job.userId,
          tradeCode: 'division_10',
          itemKey,
          code,
          category: it.category || 'Uncategorized',
          description: it.description || '',
          qtyNumber: null,
          qtyText: it.qty,
          unit: 'EA',
          confidence: it.confidence ?? null,
          status: (it.confidence ?? 0) >= 0.8 ? 'draft' : 'needs_review',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        for (const s of (it.sources || []).slice(0, 10)) {
          const key = `${s.filename}|${s.page}|${s.evidence}`;
          const fid = findingIdByKey.get(key);
          if (!fid) continue;
          evidenceLinks.push({
            id: randomUUID(),
            itemId,
            findingId: fid,
            weight: null,
            note: null,
            createdAt: new Date(),
          });
        }
      }

      // Write items + evidence links with best-effort idempotency
      if (itemRows.length > 0) {
        await db
          .insert(takeoffItems)
          .values(itemRows as any)
          .onConflictDoNothing({ target: [takeoffItems.runId, takeoffItems.itemKey] } as any);
      }

      if (evidenceLinks.length > 0) {
        // De-dupe in-memory + insert in chunks to avoid large statement failures.
        const seen = new Set<string>();
        const deduped = evidenceLinks.filter((r) => {
          const k = `${r.itemId}|${r.findingId}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });

        const chunkSize = 100;
        for (let i = 0; i < deduped.length; i += chunkSize) {
          const chunk = deduped.slice(i, i + chunkSize);
          await db
            .insert(takeoffItemEvidence)
            .values(chunk as any)
            .onConflictDoNothing({ target: [takeoffItemEvidence.itemId, takeoffItemEvidence.findingId] } as any);
        }
      }
    }

    await db
      .update(documents)
      .set({
        extractionStatus: 'completed',
        lineItemCount: result.items.length,
        signageLegend: {
          estimatorTakeoff: true,
          confidence: Math.max(0, Math.min(1, result.items.reduce((s, it) => s + (it.confidence || 0), 0) / Math.max(1, result.items.length))),
          totalCount: result.items.length,
          discrepancyCount: result.discrepancyLog.length,
          missingItems: result.missingItems,
          reviewFlags: result.reviewFlags,
          verification: result.verification,
          notes: result.notes,
          extractedAt: new Date().toISOString(),
        },
      })
      .where(inArray(documents.id, documentIds));

    await db
      .update(takeoffJobs)
      .set({
        status: 'succeeded',
        updatedAt: new Date(),
        finishedAt: new Date(),
      })
      .where(eq(takeoffJobs.id, job.id));

    await db
      .update(takeoffRuns)
      .set({ status: 'succeeded', updatedAt: new Date(), finishedAt: new Date() } as any)
      .where(eq(takeoffRuns.id, runId));

    console.log(`[takeoff-worker] Estimator takeoff complete for bid ${bidId}: ${result.items.length} items`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    await db
      .update(documents)
      .set({ extractionStatus: 'failed' })
      .where(inArray(documents.id, documentIds));

    await db
      .update(takeoffJobs)
      .set({
        status: 'failed',
        lastError: msg,
        updatedAt: new Date(),
        finishedAt: new Date(),
      })
      .where(eq(takeoffJobs.id, job.id));

    await db
      .update(takeoffRuns)
      .set({ status: 'failed', lastError: msg, updatedAt: new Date(), finishedAt: new Date() } as any)
      .where(eq(takeoffRuns.id, runId));

    console.error('[takeoff-worker] Job failed:', msg);
  } finally {
    try {
      await rm(localBidFolder, { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  console.log(`[takeoff-worker] starting workerId=${WORKER_ID}`);

  // Sanity: DB should be reachable
  // and inference configured (OpenClaw env vars required).

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const job = await claimNextJob();
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(`[takeoff-worker] claimed job ${job.id} bid=${job.bidId}`);
      await runJob(job);
    } catch (err) {
      console.error('[takeoff-worker] loop error:', err);
      await sleep(2000);
    }
  }
}

main().catch((err) => {
  console.error('[takeoff-worker] fatal:', err);
  process.exit(1);
});
