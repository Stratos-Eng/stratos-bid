import { inngest } from './client';
import { db } from '@/db';
import { users, connections, syncJobs, documents, userSettings, uploadSessions } from '@/db/schema';
import { eq, lt, or } from 'drizzle-orm';
import { createScraper, createGmailScanner, usesBrowserScraping, type Platform } from '@/scrapers';
import { extractDocument } from '@/extraction';
import { TradeCode } from '@/lib/trade-definitions';
import { generateThumbnails } from '@/lib/thumbnail-generator';
import { rm } from 'fs/promises';

// Daily sync - runs for all users every day at 6 AM
export const dailySync = inngest.createFunction(
  { id: 'daily-sync', name: 'Daily Sync All Users' },
  { cron: '0 6 * * *' },
  async ({ step }) => {
    const allUsers = await step.run('get-users', async () => {
      return await db.select().from(users);
    });

    for (const user of allUsers) {
      await step.sendEvent('sync/user', {
        name: 'sync/user',
        data: { userId: user.id },
      });
    }

    return { usersQueued: allUsers.length };
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

// Export all functions for Inngest serve
export const functions = [
  dailySync,
  syncUser,
  syncConnection,
  extractSignageJob,
  generateThumbnailsJob,
  extractDocumentJob,
  extractBidDocuments,
  autoExtractOnDownload,
  cleanupUploadSessions,
];
