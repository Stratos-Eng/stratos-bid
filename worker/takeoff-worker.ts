#!/usr/bin/env node
/* eslint-disable no-console */

import { createHash, randomUUID } from 'crypto';

function stableUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

import { deriveFindingsFromText } from './finding-utils';
import { mineSignageEvidence, hashText } from './signage-evidence-miner';
import { mineTakeoffInstances } from './instance-miner';
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
      WHERE status IN ('queued','running')
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

async function downloadBidPdfsToTemp(input: {
  bidId: string;
  docs: Array<{ id: string; filename: string; storagePath: string | null; pageCount: number | null }>;
}): Promise<{ tempDir: string; docIdBySafeName: Map<string, string> }> {
  const { bidId, docs } = input;
  const tempDir = await mkdtemp(join(tmpdir(), `stratos-bid-${bidId}-`));
  const docIdBySafeName = new Map<string, string>();

  // IMPORTANT: only download the documents requested by the takeoff job.
  // Large folders may have hundreds/thousands of PDFs.
  const bidDocs = docs;

  let downloaded = 0;
  for (const doc of bidDocs) {
    if (!doc.storagePath) continue;
    try {
    // Agentic extraction via OpenClaw (single source of truth).
    // We intentionally remove the local PDF scoring / OCR / estimator pipeline here.
    // The OpenClaw agent will:
    // - self-heal through multiple extraction strategies
    // - write an internal attempt log in its *bid agent workspace*
    // - return structured takeoff items with traceable sources

    const localPdfPaths = Array.from(docIdBySafeName.keys())
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .map((filename) => ({ filename, path: join(localBidFolder, filename) }));

    const attemptLogRel = `attempt_logs/${bidId}/${runId}.jsonl`;

    const system = `You are the Stratos signage takeoff extraction agent.

GOAL: Detect signage quantities comprehensively from the provided bid PDFs (plans + schedules), with strong recall.

CRITICAL: You MUST write an internal attempt log to the bid agent workspace at:
- ${attemptLogRel}
Log JSONL lines for each attempt, with: {ts, kind, input, outputSummary, ok, error, durationMs}.

You are allowed to use tools (filesystem + shell) to inspect PDFs and extract text, render pages, OCR, repair, etc. Try multiple strategies when one fails, and record what you tried.

Return ONLY valid JSON (no markdown, no commentary) with this schema:
{
  "items": [
    {
      "category": string,
      "description": string,
      "qty": number,
      "unit": string|null,
      "confidence": number,
      "reviewFlags": string[]|null,
      "sources": [
        {"filename": string, "page": number|null, "sheetRef": string|null, "evidence": string|null, "whyAuthoritative": string|null}
      ]
    }
  ],
  "discrepancyLog": string[]|null,
  "missingItems": string[]|null,
  "reviewFlags": string[]|null
}`;

    const user = {
      bidId,
      runId,
      trade: 'division_10',
      localBidFolder,
      localPdfPaths,
      attemptLogRel,
      constraints: {
        prioritizeRecall: true,
        maxRuntimeMinutes: 20,
      },
    };

    const resp = await openclawChatCompletions({
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    });

    const content = resp?.choices?.[0]?.message?.content as string | undefined;
    if (!content) throw new Error('OpenClaw returned empty extraction');

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`OpenClaw returned non-JSON: ${content.slice(0, 400)}`);
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    if (items.length === 0) {
      throw new Error('OpenClaw produced 0 items (extraction failed or schedule not found)');
    }

    // Persist line items (UI)
    const values = items.map((item: any, idx: number) => {
      const qty = Number(item?.qty ?? 0);
      const sources = Array.isArray(item?.sources) ? item.sources : [];
      const notes = [
        ...(item?.confidence != null && Number(item.confidence) < 0.8 ? ['LOW_CONFIDENCE: review recommended'] : []),
        ...((item?.reviewFlags || []).map((f: string) => `FLAG: ${f}`)),
        ...sources.slice(0, 3).map((s: any) => `Source: ${s.filename} p${s.page ?? ''} — ${s.whyAuthoritative ?? ''}`.trim()),
      ].join(' | ');

      return {
        documentId: documentIds[0],
        bidId,
        userId: job.userId,
        tradeCode: 'division_10',
        category: String(item?.category || 'Signage'),
        description: String(item?.description || item?.category || 'Signage'),
        estimatedQty: String(Number.isFinite(qty) ? qty : 0),
        unit: item?.unit ? String(item.unit) : 'EA',
        notes,
        pageNumber: sources?.[0]?.page ?? null,
        pageReference: sources?.[0]?.sheetRef ?? null,
        extractionConfidence: item?.confidence != null ? Number(item.confidence) : null,
        extractionModel: 'openclaw:agentic-pdf-extraction',
        rawExtractionJson: {
          itemIndex: idx,
          item,
          discrepancyLog: parsed?.discrepancyLog ?? null,
          missingItems: parsed?.missingItems ?? null,
          reviewFlags: parsed?.reviewFlags ?? null,
          attemptLogRel,
        },
        reviewStatus: 'pending',
        extractedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    if (values.length > 0) await db.insert(lineItems).values(values);

    // v2 items table (best-effort; keep simple keys)
    const itemRows = items.map((item: any) => {
      const keyBase = String(item?.description || item?.category || 'signage')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .slice(0, 80);
      const itemKey = `division_10:${keyBase}`;
      return {
        id: randomUUID(),
        runId,
        bidId,
        userId: job.userId,
        tradeCode: 'division_10',
        itemKey,
        code: null,
        category: String(item?.category || 'Signage'),
        description: String(item?.description || item?.category || 'Signage'),
        qtyNumber: item?.qty != null ? Number(item.qty) : null,
        qtyText: null,
        unit: item?.unit ? String(item.unit) : 'EA',
        confidence: item?.confidence != null ? Number(item.confidence) : null,
        status: (item?.confidence != null && Number(item.confidence) < 0.8) ? 'needs_review' : 'draft',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    if (itemRows.length > 0) await db.insert(takeoffItems).values(itemRows as any);

    await db
      .update(documents)
      .set({
        extractionStatus: 'completed',
        lineItemCount: values.length,
        signageLegend: {
          agenticExtraction: true,
          attemptLogRel,
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

    console.log(`[takeoff-worker] OpenClaw agentic extraction complete for bid ${bidId}: ${items.length} items`);
  } catch (err) {
      console.warn(`[takeoff-worker] Failed to download ${doc.filename}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[takeoff-worker] Downloaded ${downloaded}/${bidDocs.length} PDFs to ${tempDir}`);
  return { tempDir, docIdBySafeName };
}

async function runJob(job: JobRow) {
  const bidId = job.bidId;

  let cancelled = false;
  let lastCancelCheckMs = 0;
  const checkCancelled = async () => {
    if (cancelled) return true;
    const now = Date.now();
    if (now - lastCancelCheckMs < 15_000) return false;
    lastCancelCheckMs = now;
    try {
      const [row] = await db
        .select({ status: takeoffJobs.status })
        .from(takeoffJobs)
        .where(eq(takeoffJobs.id, job.id))
        .limit(1);
      if (row?.status === 'cancelled') cancelled = true;
    } catch {
      // ignore
    }
    return cancelled;
  };

  // Keep the lock fresh so other workers (or restarts) don't steal a legitimately running job.
  const heartbeat = setInterval(async () => {
    try {
      // If the user started a newer run, stop doing work.
      await checkCancelled();
      if (cancelled) return;

      await db
        .update(takeoffJobs)
        .set({ lockedAt: new Date(), updatedAt: new Date() } as any)
        .where(eq(takeoffJobs.id, job.id));
    } catch {
      // ignore
    }
  }, 10_000);


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

  const { tempDir: localBidFolder, docIdBySafeName } = await downloadBidPdfsToTemp({
    bidId,
    docs: docs.map((d) => ({
      id: d.id,
      filename: d.filename,
      storagePath: d.storagePath,
      pageCount: d.pageCount,
    })),
  });

  try {
    // OpenClaw agentic extraction (single source of truth)
    const localPdfPaths = Array.from(docIdBySafeName.keys())
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .map((filename) => ({ filename, path: join(localBidFolder, filename) }));

    const attemptLogRel = `attempt_logs/${bidId}/${runId}.jsonl`;

    const system = `You are the Stratos signage takeoff extraction agent.

GOAL: Detect signage quantities comprehensively from the provided bid PDFs (plans + schedules), with strong recall.

CRITICAL: Write an internal attempt log to the bid agent workspace at ${attemptLogRel} (JSONL: {ts, kind, input, outputSummary, ok, error, durationMs}).

Return ONLY valid JSON with schema: {items:[{category,description,qty,unit,confidence,reviewFlags,sources:[{filename,page,sheetRef,evidence,whyAuthoritative}]}],discrepancyLog,missingItems,reviewFlags}`;

    const user = { bidId, runId, trade: 'division_10', localBidFolder, localPdfPaths, attemptLogRel };

    const resp = await openclawChatCompletions({
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    });

    const content = resp?.choices?.[0]?.message?.content as string | undefined;
    if (!content) throw new Error('OpenClaw returned empty extraction');

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`OpenClaw returned non-JSON: ${content.slice(0, 400)}`);
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    if (items.length === 0) throw new Error('OpenClaw produced 0 items');

    const values = items.map((item: any, idx: number) => {
      const qty = Number(item?.qty ?? 0);
      const sources = Array.isArray(item?.sources) ? item.sources : [];
      const notes = [
        ...(item?.confidence != null && Number(item.confidence) < 0.8 ? ['LOW_CONFIDENCE: review recommended'] : []),
        ...((item?.reviewFlags || []).map((f: string) => `FLAG: ${f}`)),
        ...sources.slice(0, 3).map((s: any) => `Source: ${s.filename} p${s.page ?? ''} — ${s.whyAuthoritative ?? ''}`.trim()),
      ].join(' | ');

      return {
        documentId: documentIds[0],
        bidId,
        userId: job.userId,
        tradeCode: 'division_10',
        category: String(item?.category || 'Signage'),
        description: String(item?.description || item?.category || 'Signage'),
        estimatedQty: String(Number.isFinite(qty) ? qty : 0),
        unit: item?.unit ? String(item.unit) : 'EA',
        notes,
        pageNumber: sources?.[0]?.page ?? null,
        pageReference: sources?.[0]?.sheetRef ?? null,
        extractionConfidence: item?.confidence != null ? Number(item.confidence) : null,
        extractionModel: 'openclaw:agentic-pdf-extraction',
        rawExtractionJson: { itemIndex: idx, item, attemptLogRel },
        reviewStatus: 'pending',
        extractedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    await db.insert(lineItems).values(values);

    await db
      .update(documents)
      .set({ extractionStatus: 'completed', lineItemCount: values.length } as any)
      .where(inArray(documents.id, documentIds));

    await db
      .update(takeoffJobs)
      .set({ status: 'succeeded', updatedAt: new Date(), finishedAt: new Date() } as any)
      .where(eq(takeoffJobs.id, job.id));

    await db
      .update(takeoffRuns)
      .set({ status: 'succeeded', updatedAt: new Date(), finishedAt: new Date() } as any)
      .where(eq(takeoffRuns.id, runId));

    console.log(`[takeoff-worker] OpenClaw agentic extraction complete for bid ${bidId}: ${items.length} items`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg === 'cancelled') {
      await db
        .update(takeoffJobs)
        .set({
          status: 'cancelled',
          lastError: 'Cancelled: superseded by a newer takeoff run.',
          updatedAt: new Date(),
          finishedAt: new Date(),
        } as any)
        .where(eq(takeoffJobs.id, job.id));

      await db
        .update(takeoffRuns)
        .set({
          status: 'cancelled',
          lastError: 'Cancelled: superseded by a newer takeoff run.',
          updatedAt: new Date(),
          finishedAt: new Date(),
        } as any)
        .where(eq(takeoffRuns.id, runId));

      console.warn('[takeoff-worker] Job cancelled:', job.id);
      return;
    }

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
    clearInterval(heartbeat);
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
