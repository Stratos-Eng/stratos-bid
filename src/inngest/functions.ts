import { inngest } from './client';
import { db } from '@/db';
import { connections, syncJobs, documents, userSettings, uploadSessions, pageText, takeoffSheets } from '@/db/schema';
import { eq, lt, or, sql } from 'drizzle-orm';
import { createScraper, createGmailScanner, usesBrowserScraping, type Platform } from '@/scrapers';
import { extractDocument } from '@/extraction';
import { TradeCode } from '@/lib/trade-definitions';
import { generateThumbnails } from '@/lib/thumbnail-generator';
import { generateInitialTiles, UPLOAD_ZOOM_LEVELS } from '@/lib/tile-generator';
import { downloadFile, uploadFile, getPagePdfPath } from '@/lib/storage';
import { rm } from 'fs/promises';
import { pythonApi, PythonApiNotConfiguredError } from '@/lib/python-api';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

// Daily sync - runs for all users every day at 6 AM
export const dailySync = inngest.createFunction(
  { id: 'daily-sync', name: 'Daily Sync All Users' },
  { cron: '0 6 * * *' },
  async ({ step }) => {
    // Get distinct user IDs from connections table (users who have connections need syncing)
    const userIds = await step.run('get-users-with-connections', async () => {
      const result = await db
        .selectDistinct({ userId: connections.userId })
        .from(connections)
        .where(eq(connections.status, 'active'));
      return result.map(r => r.userId);
    });

    for (const userId of userIds) {
      await step.sendEvent('sync/user', {
        name: 'sync/user',
        data: { userId },
      });
    }

    return { usersQueued: userIds.length };
  }
);

// Sync user - syncs all connections for a single user
export const syncUser = inngest.createFunction(
  { id: 'sync-user', name: 'Sync User Connections' },
  { event: 'sync/user' },
  async ({ event, step }) => {
    const { userId } = event.data;

    const userConnections = await step.run('get-connections', async () => {
      return await db
        .select()
        .from(connections)
        .where(eq(connections.userId, userId));
    });

    const results = [];

    for (const connection of userConnections) {
      if (connection.status !== 'active') continue;

      const result = await step.run(`sync-${connection.platform}`, async () => {
        return await syncConnectionInternal(userId, connection);
      });

      results.push(result);
    }

    return { connectionsSynced: results.length, results };
  }
);

// Sync single connection - triggered manually or by syncUser
export const syncConnection = inngest.createFunction(
  { id: 'sync-connection', name: 'Sync Single Connection' },
  { event: 'sync/connection' },
  async ({ event, step }) => {
    const { userId, connectionId } = event.data;

    const [connection] = await step.run('get-connection', async () => {
      return await db
        .select()
        .from(connections)
        .where(eq(connections.id, connectionId))
        .limit(1);
    });

    if (!connection) {
      throw new Error(`Connection ${connectionId} not found`);
    }

    // Create sync job record
    const [syncJob] = await step.run('create-sync-job', async () => {
      return await db
        .insert(syncJobs)
        .values({
          userId,
          connectionId,
          status: 'running',
          startedAt: new Date(),
        })
        .returning();
    });

    try {
      const result = await step.run('run-sync', async () => {
        return await syncConnectionInternal(userId, connection);
      });

      // Update sync job as completed
      await step.run('complete-sync-job', async () => {
        await db
          .update(syncJobs)
          .set({
            status: 'completed',
            completedAt: new Date(),
            bidsFound: result.bidsFound,
          })
          .where(eq(syncJobs.id, syncJob.id));
      });

      // Update connection last synced
      await step.run('update-connection', async () => {
        await db
          .update(connections)
          .set({ lastSynced: new Date() })
          .where(eq(connections.id, connectionId));
      });

      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Update sync job as failed
      await step.run('fail-sync-job', async () => {
        await db
          .update(syncJobs)
          .set({
            status: 'failed',
            completedAt: new Date(),
            errorMessage,
          })
          .where(eq(syncJobs.id, syncJob.id));
      });

      // Update connection status
      await step.run('update-connection-error', async () => {
        await db
          .update(connections)
          .set({ status: 'error' })
          .where(eq(connections.id, connectionId));
      });

      throw error;
    }
  }
);

// Internal sync function - uses the scraper factory
async function syncConnectionInternal(
  userId: string,
  connection: { platform: string; id: string }
): Promise<{ bidsFound: number; platform: string }> {
  const platform = connection.platform as Platform;

  if (platform === 'gmail') {
    const scanner = createGmailScanner({
      connectionId: connection.id,
      userId,
    });
    await scanner.init();
    const bids = await scanner.scan();
    const savedCount = await scanner.saveBids(bids);
    return { bidsFound: savedCount, platform };
  }

  if (usesBrowserScraping(platform) && platform !== 'planetbids') {
    const scraper = createScraper(platform as 'buildingconnected', {
      connectionId: connection.id,
      userId,
    });
    await scraper.init();
    try {
      const loggedIn = await scraper.login();
      if (!loggedIn) {
        throw new Error(`Login failed for ${platform}`);
      }
      const bids = await scraper.scrape();
      const savedCount = await scraper.saveBids(bids);
      return { bidsFound: savedCount, platform };
    } finally {
      await scraper.cleanup();
    }
  }

  return { bidsFound: 0, platform };
}

// Signage extraction - triggered after document download or manually
// Uses the orchestrator which SAVES items to the database
export const extractSignageJob = inngest.createFunction(
  {
    id: 'extract-signage',
    name: 'Extract Signage Line Items',
    retries: 2,
  },
  { event: 'extraction/signage' },
  async ({ event, step }) => {
    const { documentId, userId } = event.data;

    // Run extraction via orchestrator - this SAVES items to DB
    const result = await step.run('extract-signage', async () => {
      return await extractDocument(documentId, userId, {
        trades: ['division_10'], // Signage trade
        useVision: false,
        maxPagesForAI: 25,
        concurrency: 3,
      });
    });

    // Extract legend/room info from plugin results if available
    const signagePlugin = result.pluginResults?.find(p => p.pluginId === 'signage-division-10');
    const legendMetadata = signagePlugin?.preProcess?.metadata?.legend as { found?: boolean } | undefined;
    const roomCountsMetadata = signagePlugin?.preProcess?.metadata?.roomCounts as { totalRooms?: number } | undefined;
    const legendFound = legendMetadata?.found ?? false;
    const roomsFound = roomCountsMetadata?.totalRooms ?? 0;

    return {
      documentId,
      jobId: result.jobId,
      itemsExtracted: result.totalItemsExtracted,
      legendFound,
      roomsFound,
      totalTimeMs: result.totalTimeMs,
    };
  }
);

// Generate thumbnails for all pages of a document
export const generateThumbnailsJob = inngest.createFunction(
  {
    id: 'generate-thumbnails',
    name: 'Generate Document Thumbnails',
    retries: 1,
  },
  { event: 'document/generate-thumbnails' },
  async ({ event, step }) => {
    const { documentId } = event.data;

    // Get document info
    const [doc] = await step.run('get-document', async () => {
      return await db
        .select()
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);
    });

    if (!doc || !doc.storagePath) {
      throw new Error(`Document ${documentId} not found or has no storage path`);
    }

    // Generate thumbnails
    const result = await step.run('generate-thumbnails', async () => {
      return await generateThumbnails({
        documentId,
        storagePath: doc.storagePath!,
      });
    });

    // Update document with thumbnail info
    await step.run('update-document', async () => {
      await db
        .update(documents)
        .set({
          thumbnailsGenerated: true,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId));
    });

    return {
      documentId,
      pageCount: result.pageCount,
      thumbnailsGenerated: result.thumbnailsGenerated,
    };
  }
);

// Document extraction - triggered after document download or manually
export const extractDocumentJob = inngest.createFunction(
  {
    id: 'extract-document',
    name: 'Extract Document Line Items',
    retries: 2,
  },
  { event: 'extraction/document' },
  async ({ event, step }) => {
    const { documentId, userId, trades } = event.data;

    // Get user's trade preferences if not specified
    const tradeFilter = trades || await step.run('get-user-trades', async () => {
      const [settings] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);

      return (settings?.trades as TradeCode[]) || ['division_08', 'division_10'];
    });

    // Run extraction
    const result = await step.run('extract-document', async () => {
      return await extractDocument(documentId, userId, {
        trades: tradeFilter,
        useVision: false, // Text-only for now
        concurrency: 3,
      });
    });

    return {
      documentId,
      jobId: result.jobId,
      itemsExtracted: result.totalItemsExtracted,
    };
  }
);

// Batch extraction - extract all documents for a bid
export const extractBidDocuments = inngest.createFunction(
  {
    id: 'extract-bid-documents',
    name: 'Extract All Bid Documents',
    retries: 1,
  },
  { event: 'extraction/bid' },
  async ({ event, step }) => {
    const { bidId, userId, trades } = event.data;

    // Get all documents for this bid
    const bidDocuments = await step.run('get-documents', async () => {
      return await db
        .select()
        .from(documents)
        .where(eq(documents.bidId, bidId));
    });

    // Filter to only PDFs that haven't been extracted
    const docsToProcess = bidDocuments.filter(
      doc => doc.storagePath &&
             doc.extractionStatus !== 'completed' &&
             doc.storagePath.toLowerCase().endsWith('.pdf')
    );

    // Queue extraction for each document
    for (const doc of docsToProcess) {
      await step.sendEvent('queue-extraction', {
        name: 'extraction/document',
        data: { documentId: doc.id, userId, trades },
      });
    }

    return {
      bidId,
      documentsQueued: docsToProcess.length,
      documentIds: docsToProcess.map(d => d.id),
    };
  }
);

// Auto-extract after document download (if user has auto_extract enabled)
export const autoExtractOnDownload = inngest.createFunction(
  {
    id: 'auto-extract-on-download',
    name: 'Auto Extract After Download',
  },
  { event: 'document/downloaded' },
  async ({ event, step }) => {
    const { documentId, userId } = event.data;

    // Check if user has auto-extract enabled
    const shouldExtract = await step.run('check-auto-extract', async () => {
      const [settings] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);

      return settings?.autoExtract !== false; // Default to true
    });

    if (!shouldExtract) {
      return { skipped: true, reason: 'auto_extract_disabled' };
    }

    // Get user's trade preferences to determine which extractions to run
    const trades = await step.run('get-user-trades', async () => {
      const [settings] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);

      return (settings?.trades as TradeCode[]) || ['division_08', 'division_10'];
    });

    const queued: string[] = [];

    // Queue signage extraction if division_10 is in user's trades
    if (trades.includes('division_10')) {
      await step.sendEvent('queue-signage-extraction', {
        name: 'extraction/signage',
        data: { documentId, userId },
      });
      queued.push('signage');
    }

    // Queue general extraction for other trades
    const otherTrades = trades.filter(t => t !== 'division_10');
    if (otherTrades.length > 0) {
      await step.sendEvent('queue-general-extraction', {
        name: 'extraction/document',
        data: { documentId, userId, trades: otherTrades },
      });
      queued.push('general');
    }

    // Always queue thumbnail generation
    await step.sendEvent('queue-thumbnails', {
      name: 'document/generate-thumbnails',
      data: { documentId },
    });
    queued.push('thumbnails');

    return { queued: true, documentId, extractionTypes: queued };
  }
);

// Extract text from PDF for search indexing
export const extractTextJob = inngest.createFunction(
  {
    id: 'extract-text',
    name: 'Extract Text for Search',
    retries: 2,
  },
  { event: 'document/extract-text' },
  async ({ event, step }) => {
    const { documentId } = event.data;

    // Get document info
    const [doc] = await step.run('get-document', async () => {
      return await db
        .select()
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);
    });

    if (!doc || !doc.storagePath) {
      throw new Error(`Document ${documentId} not found or has no storage path`);
    }

    // Update status to extracting
    await step.run('update-status-extracting', async () => {
      await db
        .update(documents)
        .set({ textExtractionStatus: 'extracting' })
        .where(eq(documents.id, documentId));
    });

    try {
      // Call Python service for text extraction
      const result = await step.run('extract-text', async () => {
        // Check if Python API is configured
        if (!pythonApi.isConfigured()) {
          throw new PythonApiNotConfiguredError();
        }

        const storagePath = doc.storagePath!;

        // Use URL-based extraction for Blob URLs (memory efficient)
        // This avoids downloading the entire PDF into Node.js memory
        if (storagePath.startsWith('https://')) {
          return await pythonApi.extractTextFromUrl({ pdfUrl: storagePath });
        }

        // Fallback for local files: download and send as base64
        const pdfBuffer = await downloadFile(storagePath);
        const pdfBase64 = pdfBuffer.toString('base64');
        return await pythonApi.extractText({ pdfData: pdfBase64 });
      });

      if (!result.success) {
        throw new Error(result.error || 'Text extraction failed');
      }

      // Save extracted text to database
      let pagesNeedingOcr = 0;
      await step.run('save-page-text', async () => {
        for (const page of result.pages) {
          if (page.needsOcr) pagesNeedingOcr++;

          // Upsert page text
          await db
            .insert(pageText)
            .values({
              documentId,
              pageNumber: page.page,
              rawText: page.text,
              extractionMethod: 'pymupdf',
              needsOcr: page.needsOcr,
            })
            .onConflictDoUpdate({
              target: [pageText.documentId, pageText.pageNumber],
              set: {
                rawText: page.text,
                extractionMethod: 'pymupdf',
                needsOcr: page.needsOcr,
              },
            });
        }
      });

      // Update document status
      await step.run('update-status-completed', async () => {
        await db
          .update(documents)
          .set({
            textExtractionStatus: 'completed',
            updatedAt: new Date(),
          })
          .where(eq(documents.id, documentId));
      });

      return {
        documentId,
        pagesExtracted: result.totalPages,
        pagesNeedingOcr,
      };
    } catch (error) {
      // Update status to failed
      await step.run('update-status-failed', async () => {
        await db
          .update(documents)
          .set({
            textExtractionStatus: 'failed',
            updatedAt: new Date(),
          })
          .where(eq(documents.id, documentId));
      });

      throw error;
    }
  }
);

// Cleanup stale upload sessions - runs every 6 hours
export const cleanupUploadSessions = inngest.createFunction(
  { id: 'cleanup-upload-sessions', name: 'Cleanup Stale Upload Sessions' },
  { cron: '0 */6 * * *' },
  async ({ step }) => {
    const now = new Date();

    // Find expired or stale sessions
    const staleSessions = await step.run('get-stale-sessions', async () => {
      return await db
        .select()
        .from(uploadSessions)
        .where(
          or(
            // Expired sessions
            lt(uploadSessions.expiresAt, now),
            // Failed sessions older than 1 hour
            lt(uploadSessions.updatedAt, new Date(now.getTime() - 60 * 60 * 1000))
          )
        );
    });

    let cleanedCount = 0;
    let errorCount = 0;

    for (const session of staleSessions) {
      // Skip completed sessions with a finalPath (these are valid)
      if (session.status === 'completed' && session.finalPath) {
        continue;
      }

      // Clean up temp directory
      await step.run(`cleanup-temp-${session.id}`, async () => {
        try {
          if (session.tempDir) {
            await rm(session.tempDir, { recursive: true, force: true });
          }
          cleanedCount++;
        } catch (err) {
          console.error(`Failed to cleanup temp dir for session ${session.id}:`, err);
          errorCount++;
        }
      });

      // Delete session record
      await step.run(`delete-session-${session.id}`, async () => {
        await db.delete(uploadSessions).where(eq(uploadSessions.id, session.id));
      });
    }

    return {
      sessionsFound: staleSessions.length,
      cleanedCount,
      errorCount,
    };
  }
);

// Generate tiles for a takeoff sheet
export const generateSheetTilesJob = inngest.createFunction(
  {
    id: 'generate-sheet-tiles',
    name: 'Generate Sheet Tiles',
    retries: 2,
  },
  { event: 'sheet/generate-tiles' },
  async ({ event, step }) => {
    const { sheetId, documentId, pageNumber } = event.data;

    // Get document for storage path
    const [doc] = await step.run('get-document', async () => {
      return await db
        .select()
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);
    });

    if (!doc || !doc.storagePath) {
      throw new Error(`Document ${documentId} not found or has no storage path`);
    }

    // Generate initial tiles (zoom 0-1)
    const result = await step.run('generate-tiles', async () => {
      return await generateInitialTiles(sheetId, doc.storagePath!, pageNumber);
    });

    // Update sheet with tile info
    await step.run('update-sheet', async () => {
      await db
        .update(takeoffSheets)
        .set({
          tilesReady: true,
          maxZoomGenerated: Math.max(...UPLOAD_ZOOM_LEVELS),
          tileUrlTemplate: result.tileUrlTemplate,
        })
        .where(eq(takeoffSheets.id, sheetId));
    });

    return {
      sheetId,
      tilesGenerated: result.tilesGenerated,
      tileUrlTemplate: result.tileUrlTemplate,
    };
  }
);

// === Page-Level Architecture ===
// Split PDFs into individual pages for memory-efficient rendering

const PAGE_BATCH_SIZE = 10; // Process 10 pages per batch

/**
 * Orchestrator: Queue batch processing jobs for a document
 * This is the entry point for page-level processing after upload
 */
export const processDocumentPages = inngest.createFunction(
  {
    id: 'process-document-pages',
    name: 'Process Document Pages',
    retries: 1,
  },
  { event: 'document/process-pages' },
  async ({ event, step }) => {
    const { documentId, pdfUrl, pageCount } = event.data;

    // Queue batch jobs instead of individual page jobs
    // This reduces Inngest invocations from N to ceil(N/10)
    const batchCount = Math.ceil(pageCount / PAGE_BATCH_SIZE);
    const events = Array.from({ length: batchCount }, (_, i) => {
      const startPage = i * PAGE_BATCH_SIZE + 1;
      const endPage = Math.min((i + 1) * PAGE_BATCH_SIZE, pageCount);
      const pages = Array.from(
        { length: endPage - startPage + 1 },
        (_, j) => startPage + j
      );

      return {
        name: 'page/process-batch' as const,
        data: {
          documentId,
          pdfUrl,
          pages,
          totalPages: pageCount,
          batchIndex: i,
          totalBatches: batchCount,
        },
      };
    });

    // Send all batch events
    await step.sendEvent('queue-batches', events);

    return { documentId, batchesQueued: batchCount, pageCount };
  }
);

/**
 * Process a batch of pages: extract from PDF and generate thumbnails
 *
 * IMPORTANT: PDF splitting is done in Node.js (Vercel, 1GB RAM) using pdf-lib,
 * NOT in Python (Render, 512MB RAM). This prevents Python OOM errors on large PDFs.
 *
 * Python is only used for rendering thumbnails from small single-page PDFs (~2MB each).
 */
export const processPageBatch = inngest.createFunction(
  {
    id: 'process-page-batch',
    name: 'Process Page Batch',
    retries: 3,
    concurrency: {
      limit: 1, // Serialize to avoid multiple large PDF downloads
    },
  },
  { event: 'page/process-batch' },
  async ({ event, step }) => {
    const { documentId, pdfUrl, pages, totalPages, batchIndex, totalBatches } = event.data;

    // Step 1: Download PDF and split pages using pdf-lib (Node.js, not Python)
    // This runs on Vercel with 1GB+ RAM, avoiding Python memory limits
    const pageData = await step.run('split-pages-nodejs', async () => {
      console.log(`[batch ${batchIndex}] Downloading PDF for pages ${pages.join(',')}`);
      const pdfBuffer = await downloadFile(pdfUrl);
      const pdfDoc = await PDFDocument.load(pdfBuffer);

      const results: { pageNumber: number; data: string }[] = [];

      for (const pageNumber of pages) {
        const pageIndex = pageNumber - 1;
        if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) {
          console.warn(`[batch ${batchIndex}] Invalid page number ${pageNumber}`);
          continue;
        }

        // Create single-page PDF
        const singlePageDoc = await PDFDocument.create();
        const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [pageIndex]);
        singlePageDoc.addPage(copiedPage);

        // Get bytes and encode as base64
        const pageBytes = await singlePageDoc.save();
        const pageBase64 = Buffer.from(pageBytes).toString('base64');

        results.push({ pageNumber, data: pageBase64 });
      }

      // Return only metadata, not the full data (to avoid output_too_large)
      // We'll process the data inline before returning
      return { pageCount: results.length, pages: results.map(r => r.pageNumber) };
    });

    // Unfortunately we can't pass the page data between steps (too large)
    // So we need to re-download and split for upload
    // But this is still better than using Python for splitting

    const processed: number[] = [];
    const failed: number[] = [];

    // Step 2: Process each page - upload and generate thumbnail
    for (const pageNumber of pages) {
      const result = await step.run(`page-${pageNumber}`, async () => {
        try {
          // Re-extract this specific page (pdf-lib is fast, this is acceptable)
          const pdfBuffer = await downloadFile(pdfUrl);
          const pdfDoc = await PDFDocument.load(pdfBuffer);

          const pageIndex = pageNumber - 1;
          if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) {
            return { success: false, pageNumber, error: 'Invalid page number' };
          }

          // Create single-page PDF
          const singlePageDoc = await PDFDocument.create();
          const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [pageIndex]);
          singlePageDoc.addPage(copiedPage);
          const pageBytes = await singlePageDoc.save();

          // Upload single-page PDF to Blob
          const pathname = getPagePdfPath(documentId, pageNumber);
          const { url: pageUrl } = await uploadFile(Buffer.from(pageBytes), pathname, {
            contentType: 'application/pdf',
          });

          // Generate thumbnail using Python (now only processing ~2MB single-page PDF)
          if (pythonApi.isConfigured()) {
            try {
              const renderResult = await pythonApi.render({
                pdfUrl: pageUrl,
                pageNum: 1,
                scale: 0.2,
                returnBase64: true,
              });

              if (renderResult.success && renderResult.image) {
                const thumbnail = await sharp(Buffer.from(renderResult.image, 'base64'))
                  .resize(150)
                  .webp({ quality: 75 })
                  .toBuffer();

                await uploadFile(thumbnail, `thumbnails/${documentId}/${pageNumber}.webp`, {
                  contentType: 'image/webp',
                });
              }
            } catch (renderError) {
              console.warn(`[page ${pageNumber}] Thumbnail render failed:`, renderError);
              // Continue without thumbnail - it can be generated on-demand
            }
          }

          return { success: true, pageNumber, pageUrl };
        } catch (error) {
          console.error(`[page ${pageNumber}] Error:`, error);
          return { success: false, pageNumber, error: String(error) };
        }
      });

      if (result.success) {
        processed.push(pageNumber);
      } else {
        failed.push(pageNumber);
      }
    }

    // Step 3: Mark pages ready if this is the last batch
    const isLastBatch = batchIndex === totalBatches - 1;
    if (isLastBatch) {
      await step.run('mark-pages-ready', async () => {
        await db
          .update(documents)
          .set({
            pagesReady: true,
            thumbnailsGenerated: true,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, documentId));
      });
    }

    return {
      documentId,
      batchIndex,
      pagesProcessed: processed.length,
      pagesFailed: failed,
    };
  }
);

// Single-page processor using pdf-lib (Node.js) for splitting
export const processPage = inngest.createFunction(
  {
    id: 'process-page',
    name: 'Process Single Page',
    retries: 3,
    concurrency: {
      limit: 1,
    },
  },
  { event: 'page/process' },
  async ({ event, step }) => {
    const { documentId, pdfUrl, pageNumber, totalPages } = event.data;

    // Extract and upload page using pdf-lib (Node.js, not Python)
    const pageUrl = await step.run('extract-and-upload', async () => {
      const pdfBuffer = await downloadFile(pdfUrl);
      const pdfDoc = await PDFDocument.load(pdfBuffer);

      const pageIndex = pageNumber - 1;
      if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) {
        throw new Error(`Invalid page number ${pageNumber}`);
      }

      // Create single-page PDF
      const singlePageDoc = await PDFDocument.create();
      const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [pageIndex]);
      singlePageDoc.addPage(copiedPage);
      const pageBytes = await singlePageDoc.save();

      // Upload to Blob
      const pathname = getPagePdfPath(documentId, pageNumber);
      const { url } = await uploadFile(Buffer.from(pageBytes), pathname, {
        contentType: 'application/pdf',
      });
      return url;
    });

    // Generate thumbnail using Python (small single-page PDF only)
    await step.run('generate-thumbnail', async () => {
      if (!pythonApi.isConfigured()) {
        console.warn('Python API not configured, skipping thumbnail');
        return;
      }

      const result = await pythonApi.render({
        pdfUrl: pageUrl,
        pageNum: 1,
        scale: 0.2,
        returnBase64: true,
      });

      if (!result.success || !result.image) {
        console.warn(`Failed to render page ${pageNumber}: ${result.error}`);
        return; // Don't fail the whole job, thumbnail can be generated on-demand
      }

      const thumbnail = await sharp(Buffer.from(result.image, 'base64'))
        .resize(150)
        .webp({ quality: 75 })
        .toBuffer();

      await uploadFile(thumbnail, `thumbnails/${documentId}/${pageNumber}.webp`, {
        contentType: 'image/webp',
      });
    });

    if (pageNumber === totalPages) {
      await step.run('mark-pages-ready', async () => {
        await db
          .update(documents)
          .set({
            pagesReady: true,
            thumbnailsGenerated: true,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, documentId));
      });
    }

    return { documentId, pageNumber, pageUrl };
  }
);

// Export all functions for Inngest serve
export const functions = [
  dailySync,
  syncUser,
  syncConnection,
  extractSignageJob,
  generateThumbnailsJob,
  generateSheetTilesJob,
  extractDocumentJob,
  extractBidDocuments,
  autoExtractOnDownload,
  extractTextJob,
  cleanupUploadSessions,
  processDocumentPages,
  processPageBatch,
  processPage,
];
