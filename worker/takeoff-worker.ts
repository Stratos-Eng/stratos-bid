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
import { discoverCodesFromOcrTiles, extractPlacementsFromTiles } from './du39-ocr-takeoff';
import { extractPageTextWithFallback, getPdfPageCount } from './pdf-artifacts';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { db } from '@/db';
import { documents, lineItems, takeoffJobs, takeoffJobDocuments, takeoffRuns, takeoffArtifacts, takeoffFindings, takeoffItems, takeoffItemEvidence, takeoffInstances, takeoffInstanceEvidence } from '@/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { downloadFile } from '@/lib/storage';
import { openclawChatCompletions } from '@/lib/openclaw';
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

  const bidDocs = docs;

  let downloaded = 0;
  for (const doc of bidDocs) {
    if (!doc.storagePath) continue;

    // Keep filenames safe-ish but stable
    const safeName = doc.filename.replace(/[^a-zA-Z0-9._\-()\s]/g, '_');
    const outPath = join(tempDir, safeName);

    try {
      const buf = await downloadFile(doc.storagePath);
      await writeFile(outPath, buf);
      docIdBySafeName.set(safeName, doc.id);
      downloaded += 1;
    } catch (err) {
      console.warn(
        `[takeoff-worker] Failed to download ${doc.filename}:`,
        err instanceof Error ? err.message : String(err)
      );
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
    // Local PDFs available for extraction
    const localPdfPaths = Array.from(docIdBySafeName.keys())
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .map((filename) => ({ filename, path: join(localBidFolder, filename) }));

    // DU39 MVP: accuracy-first placements via tiled OCR (no hardcoded page ranges; only scoped by doc size)
    // For small PDFs (<= 60 pages), run a tiled-OCR discovery+placement pass and persist placements directly.
    // This is the estimator-style path (graphical labels) and should outperform pure text extraction.
    for (const pdf of localPdfPaths) {
      const pageCount = Number(docs.find((d) => d.filename === pdf.filename)?.pageCount || 0);
      if (!pageCount || pageCount > 60) continue;

      try {
        const allTileTexts: string[] = [];
        // lightweight sampling across the doc to discover repeating codes
        const samplePages = Array.from(new Set([1, 2, 3, Math.ceil(pageCount / 2), Math.max(1, pageCount - 2), pageCount]));
        for (const p of samplePages) {
          const tiles = (await import('./tiled-ocr')).ocrTiledPage({ pdfPath: pdf.path, page: p, overlapPx: 20, dpi: 250, rows: 3, cols: 2 });
          for (const t of tiles) if (t.text) allTileTexts.push(t.text);
        }

        const discoveredCodes = discoverCodesFromOcrTiles(allTileTexts);
        if (discoveredCodes.length > 0) {
          console.log(`[takeoff-worker] tiled-ocr discovered codes=${discoveredCodes.length} in ${pdf.filename}`);

          const placementsNoOverlap: any[] = [];
          const placementsOverlap: any[] = [];

          for (let page = 1; page <= pageCount; page++) {
            const noOv = extractPlacementsFromTiles({ pdfPath: pdf.path, page, codes: discoveredCodes, overlapPx: 0, dpi: 300 });
            placementsNoOverlap.push(...noOv);

            const ov = extractPlacementsFromTiles({ pdfPath: pdf.path, page, codes: discoveredCodes, overlapPx: 20, dpi: 300 });
            placementsOverlap.push(...ov);
          }

          // Prefer no-overlap as baseline (no dupes), then add overlap-only placements that look new.
          const key = (pl: any) => `${pl.pageNumber}:${pl.code}:${(pl.evidenceText || '').slice(0, 60)}`;
          const seen = new Set(placementsNoOverlap.map(key));
          const merged = [...placementsNoOverlap];
          for (const pl of placementsOverlap) {
            const k = key(pl);
            if (!seen.has(k)) {
              seen.add(k);
              merged.push(pl);
            }
          }

          // Insert types for this run from discovered codes (UI grouping)
          const typeRows = discoveredCodes.slice(0, 250).map((code) => {
            const itemKey = `code:${code}`;
            return {
              id: randomUUID(),
              runId,
              bidId,
              userId: job.userId,
              tradeCode: 'division_10',
              itemKey,
              code,
              category: 'Signage',
              description: code,
              qtyNumber: null,
              qtyText: null,
              unit: 'EA',
              confidence: 0.6,
              status: 'needs_review',
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          });

          if (typeRows.length > 0) {
            await db.insert(takeoffItems).values(typeRows as any).onConflictDoNothing();
          }

          // Map code -> typeItemId for linking instances
          const typeMapRows = await db
            .select({ id: takeoffItems.id, code: takeoffItems.code })
            .from(takeoffItems)
            .where(eq(takeoffItems.runId, runId));
          const codeToTypeId = new Map<string, string>();
          for (const r of typeMapRows) if (r.code) codeToTypeId.set(String(r.code).toUpperCase(), r.id);

          const documentId = docIdBySafeName.get(pdf.filename) || documentIds[0];

          const instRows: any[] = [];
          const evRows: any[] = [];

          for (const pl of merged.slice(0, 8000)) {
            const typeItemId = codeToTypeId.get(String(pl.code).toUpperCase()) || null;
            const stable = stableUuid(`${runId}:${documentId}:${pl.pageNumber}:${pl.code}:${(pl.evidenceText || '').slice(0, 80)}`);

            instRows.push({
              id: stable,
              runId,
              bidId,
              userId: job.userId,
              typeItemId,
              sourceKind: 'evidence',
              status: 'needs_review',
              confidence: 0.65,
              meta: { ...pl.meta, code: pl.code },
              createdAt: new Date(),
              updatedAt: new Date(),
            });

            evRows.push({
              instanceId: stable,
              documentId,
              pageNumber: pl.pageNumber,
              evidenceText: String(pl.evidenceText || '').slice(0, 900),
              evidence: { filename: pdf.filename, code: pl.code, ...pl.meta?.tile },
              weight: 1,
              createdAt: new Date(),
            });
          }

          if (instRows.length > 0) {
            await db.insert(takeoffInstances).values(instRows).onConflictDoNothing();
            await db.insert(takeoffInstanceEvidence).values(evRows).onConflictDoNothing();
            console.log(`[takeoff-worker] tiled-ocr inserted placements=${instRows.length} for ${pdf.filename}`);
          }
        }
      } catch (e) {
        console.warn('[takeoff-worker] tiled-ocr pass failed (non-fatal):', e instanceof Error ? e.message : String(e));
      }
    }

    // OpenClaw agentic extraction (types/schedule-derived quantities)

    // IMPORTANT: the model cannot access local files directly. Provide extracted text.
    // We intentionally cap pages/chars to avoid pathological runtimes and token blowups.
    // For DU40 (very large plan set), we target known signage schedule ranges (reference from estimator).
    const docTexts: Array<{ filename: string; pageRange: string; text: string }> = [];

    const chooseRanges = (filename: string, pageCount: number) => {
      const lower = filename.toLowerCase();

      // MSF IDR 85% set (DU40): schedules live deep in the set.
      if (lower.includes('du40') || lower.includes('msf_idr-cr_85p')) {
        const ranges: Array<[number, number]> = [];

        // Seed with a deep slice known to often contain schedules on this project,
        // but also add additional discovery windows so we don't overfit to one band.
        if (pageCount >= 857) ranges.push([814, 857]);
        else if (pageCount >= 851) ranges.push([814, 851]);
        else if (pageCount >= 830) ranges.push([814, 830]);

        // Add evenly spaced discovery windows (20 pages each) across the document.
        // This helps catch schedules/legends that land elsewhere.
        const win = 20;
        const candidates = [
          Math.max(1, Math.floor(pageCount * 0.25)),
          Math.max(1, Math.floor(pageCount * 0.50)),
          Math.max(1, Math.floor(pageCount * 0.75)),
        ];
        for (const start0 of candidates) {
          const start = Math.max(1, start0);
          const end = Math.min(pageCount || start + win - 1, start + win - 1);
          if (end >= start) ranges.push([start, end]);
        }

        // Add small front-matter slice for legends/notes
        ranges.push([1, Math.min(25, Math.max(1, pageCount || 25))]);

        // De-dupe overlapping ranges
        const seen = new Set<string>();
        return ranges.filter(([a, b]) => {
          const k = `${a}-${b}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }

      // Default: first 30 pages
      const endPage = Math.max(1, Math.min(Number(pageCount) || 30, 30));
      return [[1, endPage]] as Array<[number, number]>;
    };

    for (const pdf of localPdfPaths) {
      const pageCount = Number(docs.find((d) => d.filename === pdf.filename)?.pageCount || 0);
      const ranges = chooseRanges(pdf.filename, pageCount);

      for (const [start, end] of ranges) {
        const text = await extractPdfText(pdf.path, start, end);
        const trimmed = (text || '').slice(0, 140_000);
        docTexts.push({ filename: pdf.filename, pageRange: `${start}-${end}`, text: trimmed });
      }
    }

    const attemptLogRel = `attempt_logs/${bidId}/${runId}.jsonl`;

    const system = `You are the Stratos signage takeoff extraction agent.

GOAL: Detect signage quantities comprehensively from the provided bid PDFs (plans + schedules), with strong recall.

You are provided extracted PDF TEXT (not the PDF files themselves). Use it to produce a takeoff.

Reference note: DU40 is a very large set and signage schedules/legends may appear deep in the page range (not necessarily near the front). Treat any provided deep page-range text as high-signal schedule content, but do NOT assume specific categories/codes are the only items.

CRITICAL OUTPUT REQUIREMENTS:
- Maximize recall: enumerate ALL schedule rows / sign codes you can find across the provided text ranges, not just a few examples.
- Prefer schedule-derived quantities over scattered plan callouts when schedules exist.
- Include sources with filename + pageRange and sheetRef where possible.

Return ONLY valid JSON with schema: {items:[{category,description,qty,unit,confidence,reviewFlags,sources:[{filename,page,sheetRef,evidence,whyAuthoritative}]}],discrepancyLog,missingItems,reviewFlags}`;

    const user = { bidId, runId, trade: 'division_10', localBidFolder, localPdfPaths, docTexts, attemptLogRel };

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
        pageNumber: (() => {
          const p = sources?.[0]?.page;
          const n = typeof p === 'number' ? p : Number(p);
          return Number.isFinite(n) ? n : null;
        })(),
        pageReference: sources?.[0]?.sheetRef ? String(sources[0].sheetRef) : null,
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

    // Also persist into takeoff_items because the UI "Items found" counters are computed from takeoff_items.
    const itemRows = items.map((item: any) => {
      const category = String(item?.category || 'Signage');
      const description = String(item?.description || item?.category || 'Signage');
      const qty = item?.qty != null ? Number(item.qty) : null;

      // Stable-ish key per run: hash(category|description|unit)
      const keyBase = `${category}|${description}|${item?.unit ?? ''}`;
      const itemKey = `division_10:${createHash('sha256').update(keyBase).digest('hex').slice(0, 16)}`;

      // Try to infer a short code (e.g. C1, D2, WS-01) from description.
      // Don't anchor to start; schedules often embed codes mid-string.
      const m = /\b([A-Z]{1,3}-?\d{1,4})\b/.exec(description);
      const code = m?.[1] ? String(m[1]) : null;

      return {
        id: randomUUID(),
        runId,
        bidId,
        userId: job.userId,
        tradeCode: 'division_10',
        itemKey,
        code,
        category,
        description,
        qtyNumber: Number.isFinite(qty as any) ? (qty as number) : null,
        qtyText: null,
        unit: item?.unit ? String(item.unit) : null,
        confidence: item?.confidence != null ? Number(item.confidence) : null,
        status: item?.confidence != null && Number(item.confidence) < 0.8 ? 'needs_review' : 'draft',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });

    if (itemRows.length > 0) {
      await db
        .insert(takeoffItems)
        .values(itemRows as any)
        // avoid unique collisions in retries
        .onConflictDoNothing();
    }

    // Mine placements (instances) from the PDFs using the type codes we just stored.
    // This is what drives "hundreds of placements" and enables estimator-style counting.
    try {
      const mined = await mineTakeoffInstances({
        runId,
        bidId,
        userId: job.userId,
        localBidFolder,
        docIdBySafeName,
        budgetMs: 18 * 60 * 1000,
      });
      console.log(`[takeoff-worker] instance-miner inserted~${mined.inserted} scannedPages=${mined.scannedPages} codes=${mined.codes}`);
    } catch (e) {
      console.warn('[takeoff-worker] instance-miner failed (non-fatal):', e instanceof Error ? e.message : String(e));
    }

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

    const [typeCountRow] = await db.select({ c: sql<number>`count(*)` }).from(takeoffItems).where(eq(takeoffItems.runId, runId));
    const [instCountRow] = await db.select({ c: sql<number>`count(*)` }).from(takeoffInstances).where(eq(takeoffInstances.runId, runId));
    console.log(`[takeoff-worker] OpenClaw agentic extraction complete for bid ${bidId}: ${items.length} types; placements=${Number(instCountRow?.c ?? 0)}`);
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
