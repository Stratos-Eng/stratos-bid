import { inngest } from './client';
import { db } from '@/db';
import { connections, syncJobs, uploadSessions, documents, lineItems, pageText } from '@/db/schema';
import { eq, lt, or, inArray } from 'drizzle-orm';
import { downloadFile } from '@/lib/storage';
import { extractPdfPageByPageFromBuffer } from '@/extraction/pdf-parser';
import { createScraper, createGmailScanner, usesBrowserScraping, type Platform } from '@/scrapers';
import { rm, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runExtractionLoop } from '@/extraction/agentic';
import type { DocumentInfo } from '@/extraction/agentic';
import { scoreAllDocuments, getTopDocument, formatScoresForLog } from '@/extraction/scoring';
import { tryFastPathExtraction, extractPdfText, detectSourceType } from '@/extraction/fast-path';
import { generateIssueSummary } from '@/extraction/review';

// ========================================
// SYNC FUNCTIONS - Keep for bid scraping
// ========================================

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

// ========================================
// HOUSEKEEPING FUNCTIONS
// ========================================

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

// ========================================
// EXTRACTION FUNCTIONS
// ========================================

/**
 * Sanitize text for PostgreSQL UTF-8 storage
 * Removes null bytes and control characters that cause encoding errors
 */
function sanitizeTextForPostgres(text: string): string {
  return text
    .replace(/\x00/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\uFFFD/g, '');
}

/**
 * Background text extraction - runs after upload to populate pageText table
 *
 * This was previously synchronous in /api/upload/complete-blob and blocked
 * uploads for 30-100+ seconds on large PDFs. Now runs in background.
 *
 * Event data:
 * - documentId: string - The document to extract text from
 * - blobUrl: string - Storage URL to download the PDF
 */
export const extractDocumentText = inngest.createFunction(
  {
    id: 'extract-document-text',
    name: 'Extract Document Text',
    retries: 2,
  },
  { event: 'extraction/text-extract' },
  async ({ event, step }) => {
    const { documentId, blobUrl } = event.data;

    await step.run('set-text-extracting', async () => {
      await db
        .update(documents)
        .set({ textExtractionStatus: 'extracting' })
        .where(eq(documents.id, documentId));
    });

    await step.run('extract-and-store-text', async () => {
      const pdfBuffer = await downloadFile(blobUrl);
      const pages = await extractPdfPageByPageFromBuffer(pdfBuffer);

      const pageTextValues = pages.map(page => ({
        documentId,
        pageNumber: page.pageNumber,
        rawText: sanitizeTextForPostgres(page.text),
        extractionMethod: 'unpdf' as const,
        needsOcr: !page.hasContent,
      }));

      if (pageTextValues.length > 0) {
        await db.insert(pageText).values(pageTextValues);
      }

      await db
        .update(documents)
        .set({ textExtractionStatus: 'completed' })
        .where(eq(documents.id, documentId));

      console.log(`[text-extract] Extracted ${pages.length} pages for document ${documentId}`);
    });

    return { documentId, success: true };
  }
);

/**
 * Agentic Signage Extraction - runs the tool loop for a bid's documents
 *
 * Processes an entire bid in ONE job (not per-document):
 * 1. Download all bid PDFs once
 * 2. Score documents (FREE, deterministic) - find best targets
 * 3. Try fast-path (no AI) - if schedule/legend is clear
 * 4. Fall back to agentic loop if fast-path fails or low confidence
 * 5. Save results and mark ALL documents as completed
 *
 * Event data:
 * - bidId: string - The bid ID
 * - documentIds: string[] - Documents in this bid to mark for status tracking
 * - bidFolder: string - (legacy, ignored) Original blob folder path
 * - userId: string - User who triggered extraction
 */
export const extractSignageAgentic = inngest.createFunction(
  {
    id: 'extract-signage-agentic',
    name: 'Extract Signage (Agentic)',
    retries: 1,
    concurrency: {
      limit: 2, // Prevent rate-limiting the Anthropic API
    },
  },
  { event: 'extraction/signage-agentic' },
  async ({ event, step }) => {
    const { bidId, documentIds, userId } = event.data;

    // Update status to extracting for ALL documents in this bid
    await step.run('set-extracting', async () => {
      await db
        .update(documents)
        .set({ extractionStatus: 'extracting' })
        .where(inArray(documents.id, documentIds));
    });

    // Download all bid PDFs to a temp directory so CLI tools (pdftotext, pdftoppm)
    // can access them. Files are stored in DigitalOcean Spaces (cloud URLs) but the
    // extraction tools require local filesystem paths.
    const localBidFolder = await step.run('download-bid-pdfs', async () => {
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
          console.warn(`[agentic] Failed to download ${doc.filename}:`, err instanceof Error ? err.message : err);
        }
      }

      console.log(`[agentic] Downloaded ${downloaded}/${bidDocs.length} PDFs to ${tempDir}`);
      return tempDir;
    });

    try {
      // ========================================
      // STEP 1: Score documents (FREE, deterministic)
      // ========================================
      const scoredDocs = await step.run('score-documents', async () => {
        const scores = await scoreAllDocuments(localBidFolder, 'division_10');
        console.log(`[agentic] Document scores:\n${formatScoresForLog(scores)}`);
        return scores;
      });

      // ========================================
      // STEP 2: Try fast-path extraction (no AI)
      // ========================================
      const fastPathResult = await step.run('try-fast-path', async () => {
        const topDoc = getTopDocument(scoredDocs, 80);
        if (!topDoc) {
          console.log('[agentic] No high-score document found, skipping fast-path');
          return null;
        }

        console.log(`[agentic] Top document: ${topDoc.path} (score: ${topDoc.score})`);

        // Extract text from top document
        const text = await extractPdfText(topDoc.path);
        if (!text || text.length < 100) {
          console.log('[agentic] Could not extract text from top document');
          return null;
        }

        // Detect source type
        const sourceType = detectSourceType(text);
        if (!sourceType) {
          console.log('[agentic] Could not detect source type');
          return null;
        }

        console.log(`[agentic] Detected source type: ${sourceType}`);

        // Try fast-path extraction
        const result = tryFastPathExtraction(text, sourceType);
        if (result && result.confidence >= 0.85) {
          console.log(`[agentic] Fast-path success: ${result.entries.length} entries, confidence ${result.confidence}`);
          return result;
        }

        console.log('[agentic] Fast-path confidence too low, falling back to agentic');
        return null;
      });

      // If fast-path succeeded with high confidence, use it
      if (fastPathResult && fastPathResult.confidence >= 0.85) {
        // Save line items from fast-path (batch insert — linked to bid, not individual docs)
        await step.run('save-line-items-fast', async () => {
          const values = fastPathResult.entries.map(entry => ({
            documentId: documentIds[0], // Primary document for line item association
            bidId,
            userId,
            tradeCode: 'division_10',
            category: entry.name,
            description: `${entry.name}${entry.roomNumber ? ` (${entry.roomNumber})` : ''}`,
            estimatedQty: String(entry.quantity),
            unit: 'EA',
            notes: `Source: ${fastPathResult.source}`,
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
          }));
          if (values.length > 0) {
            await db.insert(lineItems).values(values);
          }
        });

        // Update ALL documents in the bid as completed
        await step.run('update-documents-fast', async () => {
          await db
            .update(documents)
            .set({
              extractionStatus: 'completed',
              lineItemCount: fastPathResult.entries.length,
              signageLegend: {
                fastPathExtraction: true,
                skippedAI: true,
                totalCount: fastPathResult.totalCount,
                confidence: fastPathResult.confidence,
                source: fastPathResult.source,
                issues: fastPathResult.issues,
                notes: fastPathResult.notes,
                extractedAt: new Date().toISOString(),
                tokenUsage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
              },
            })
            .where(inArray(documents.id, documentIds));
        });

        console.log(`[agentic] Fast-path complete for bid ${bidId}: ${fastPathResult.entries.length} items, $0.00 cost (skipped AI)`);

        return {
          success: true,
          method: 'fast_path',
          bidId,
          documentCount: documentIds.length,
          itemCount: fastPathResult.entries.length,
          totalCount: fastPathResult.totalCount,
          confidence: fastPathResult.confidence,
          skippedAI: true,
          tokenUsage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        };
      }

      // ========================================
      // STEP 3: Fall back to agentic loop
      // ========================================

      // Build doc info for top-scoring document (Claude will investigate from there)
      const topDocInfo = await step.run('get-top-doc-info', async () => {
        // Use the highest-scored document as the starting point for Claude
        const topScored = scoredDocs[0];
        if (!topScored) throw new Error('No documents found in bid folder');

        return {
          id: topScored.documentId,
          name: topScored.filename,
          path: topScored.path,
          pageCount: undefined,
        } as DocumentInfo;
      });

      const result = await step.run('extract-agentic', async () => {
        return await runExtractionLoop(localBidFolder, [topDocInfo]);
      });

      // Save line items to database (batch insert — linked to bid)
      await step.run('save-line-items', async () => {
        const values = result.entries.map(entry => ({
          documentId: documentIds[0], // Primary document for line item association
          bidId,
          userId,
          tradeCode: 'division_10',
          category: entry.name,
          description: `${entry.name}${entry.roomNumber ? ` (${entry.roomNumber})` : ''}`,
          estimatedQty: String(entry.quantity),
          unit: 'EA',
          notes: buildExtractionNotes(entry),
          pageNumber: entry.pageNumbers[0],
          pageReference: entry.sheetRefs.join(', '),
          extractionConfidence: entry.confidence,
          extractionModel: 'signage-agentic-v3',
          rawExtractionJson: {
            id: entry.id,
            identifier: entry.identifier,
            source: entry.source,
            isGrouped: entry.isGrouped,
            groupRange: entry.groupRange,
            signTypeCode: entry.signTypeCode,
          },
          reviewStatus: entry.confidence >= 0.8 ? 'pending' : 'needs_review',
          extractedAt: new Date(),
        }));
        if (values.length > 0) {
          await db.insert(lineItems).values(values);
        }
      });

      // Update ALL documents in the bid as completed
      await step.run('update-documents', async () => {
        await db
          .update(documents)
          .set({
            extractionStatus: 'completed',
            lineItemCount: result.entries.length,
            signageLegend: {
              agenticExtraction: true,
              totalCount: result.totalCount,
              confidence: result.confidence,
              iterationsUsed: result.iterationsUsed,
              toolCallsCount: result.toolCallsCount,
              notes: result.notes,
              extractedAt: new Date().toISOString(),
              tokenUsage: result.tokenUsage,
            },
          })
          .where(inArray(documents.id, documentIds));
      });

      console.log(`[agentic] Extraction complete for bid ${bidId}: ${result.entries.length} items, $${result.tokenUsage.estimatedCostUsd.toFixed(4)} est. cost`);

      return {
        success: true,
        method: 'agentic',
        bidId,
        documentCount: documentIds.length,
        itemCount: result.entries.length,
        totalCount: result.totalCount,
        confidence: result.confidence,
        iterationsUsed: result.iterationsUsed,
        skippedAI: false,
        tokenUsage: result.tokenUsage,
      };
    } catch (error) {
      // Update ALL documents as failed
      await step.run('set-failed', async () => {
        await db
          .update(documents)
          .set({ extractionStatus: 'failed' })
          .where(inArray(documents.id, documentIds));
      });

      throw error;
    } finally {
      // Clean up temp directory
      await step.run('cleanup-temp', async () => {
        try {
          await rm(localBidFolder, { recursive: true, force: true });
          console.log(`[agentic] Cleaned up temp dir: ${localBidFolder}`);
        } catch (err) {
          console.warn(`[agentic] Failed to clean up temp dir:`, err instanceof Error ? err.message : err);
        }
      });
    }
  }
);

/**
 * Build notes string from extracted entry
 */
function buildExtractionNotes(entry: {
  source: string;
  isGrouped: boolean;
  groupRange?: [number, number];
  notes?: string;
  sheetRefs: string[];
}): string {
  const parts: string[] = [];

  if (entry.isGrouped && entry.groupRange) {
    parts.push(`Grouped entry (${entry.groupRange[0]}-${entry.groupRange[1]})`);
  }

  parts.push(`Source: ${entry.source}`);

  if (entry.sheetRefs.length > 0) {
    parts.push(`Sheets: ${entry.sheetRefs.join(', ')}`);
  }

  if (entry.notes) {
    parts.push(entry.notes);
  }

  return parts.join(' | ');
}

// Export all functions for Inngest serve
export const functions = [
  dailySync,
  syncUser,
  syncConnection,
  cleanupUploadSessions,
  extractDocumentText,
  extractSignageAgentic,
];
