#!/usr/bin/env node
/* eslint-disable no-console */

import { randomUUID } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { db } from '@/db';
import { documents, lineItems, takeoffJobs, takeoffJobDocuments } from '@/db/schema';
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
    RETURNING *;
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

async function downloadBidPdfsToTemp(bidId: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), `stratos-bid-${bidId}-`));

  const bidDocs = await db
    .select({ id: documents.id, filename: documents.filename, storagePath: documents.storagePath })
    .from(documents)
    .where(eq(documents.bidId, bidId));

  let downloaded = 0;
  for (const doc of bidDocs) {
    if (!doc.storagePath) continue;
    try {
      const buffer = await downloadFile(doc.storagePath);
      const safeName = doc.filename.replace(/[^a-zA-Z0-9._()-]/g, '_');
      await writeFile(join(tempDir, safeName), buffer);
      downloaded++;
    } catch (err) {
      console.warn(`[takeoff-worker] Failed to download ${doc.filename}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[takeoff-worker] Downloaded ${downloaded}/${bidDocs.length} PDFs to ${tempDir}`);
  return tempDir;
}

async function runJob(job: JobRow) {
  const bidId = job.bidId;

  // Load documents
  const docs = await getJobDocuments(job.id);
  const documentIds = docs.map((d) => d.id);

  // Update doc statuses to extracting
  await db
    .update(documents)
    .set({ extractionStatus: 'extracting' })
    .where(inArray(documents.id, documentIds));

  const localBidFolder = await downloadBidPdfsToTemp(bidId);

  try {
    // STEP 1: score docs
    const scoredDocs = await scoreAllDocuments(localBidFolder, 'division_10');
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
              reviewStatus: entry.confidence >= 0.8 ? 'pending' : 'needs_review',
              extractedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            }));

            if (values.length > 0) await db.insert(lineItems).values(values);

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
        ...((item.reviewFlags || []).map((f) => `FLAG: ${f}`)),
        ...item.sources.slice(0, 3).map((s) => `Source: ${s.filename} p${s.page} — ${s.whyAuthoritative} — ${s.evidence}`),
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
      reviewStatus: item.confidence >= 0.8 ? 'pending' : 'needs_review',
      extractedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    if (values.length > 0) await db.insert(lineItems).values(values);

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
