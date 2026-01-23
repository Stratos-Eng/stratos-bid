import { inngest } from './client';
import { db } from '@/db';
import { connections, syncJobs, uploadSessions } from '@/db/schema';
import { eq, lt, or } from 'drizzle-orm';
import { createScraper, createGmailScanner, usesBrowserScraping, type Platform } from '@/scrapers';
import { rm } from 'fs/promises';

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
// REMOVED FUNCTIONS (now synchronous)
// ========================================
// - extractSignageJob: Now handled by /api/extraction (sync)
// - generateThumbnailsJob: Now client-side PDF.js
// - generateSheetTilesJob: Now client-side PDF.js
// - extractDocumentJob: Now handled by /api/extraction (sync)
// - extractBidDocuments: Now handled by /api/extraction (sync)
// - autoExtractOnDownload: No longer needed
// - extractTextJob: Now sync in /api/upload/complete-blob
// - processDocumentPages: Server rendering removed
// - processPageBatch: Server rendering removed
// - processPage: Server rendering removed

// Export all functions for Inngest serve
export const functions = [
  dailySync,
  syncUser,
  syncConnection,
  cleanupUploadSessions,
];
