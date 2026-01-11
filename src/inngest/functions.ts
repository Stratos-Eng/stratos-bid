import { inngest } from './client';
import { db } from '@/db';
import { users, connections, syncJobs, documents, lineItems } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createScraper, createGmailScanner, usesBrowserScraping, type Platform } from '@/scrapers';
import { extractPdfText } from '@/lib/pdf-extractor';
import { extractLineItems } from '@/lib/ai-extractor';
import { generateTilesForPage } from '@/lib/tile-generator';
import { join } from 'path';

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
    const scraper = createScraper(platform as 'planhub' | 'buildingconnected', {
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

// Document extraction - triggered after upload
export const extractDocument = inngest.createFunction(
  {
    id: 'extract-document',
    name: 'Extract Document',
    retries: 2,
  },
  { event: 'document/extract' },
  async ({ event, step }) => {
    const { documentId, bidId } = event.data;

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
    await step.run('set-extracting', async () => {
      await db
        .update(documents)
        .set({ extractionStatus: 'extracting' })
        .where(eq(documents.id, documentId));
    });

    try {
      // Extract text from PDF
      const extraction = await step.run('extract-text', async () => {
        return await extractPdfText(doc.storagePath!);
      });

      // Save extracted text
      await step.run('save-text', async () => {
        await db
          .update(documents)
          .set({
            extractedText: extraction.text,
            pageCount: extraction.pageCount,
          })
          .where(eq(documents.id, documentId));
      });

      // Generate tiles for the document
      const tileResult = await step.run('generate-tiles', async () => {
        const pageCount = extraction.pageCount;
        let firstPageResult = null;

        for (let page = 1; page <= pageCount; page++) {
          const result = await generateTilesForPage({
            documentId,
            pageNumber: page,
            storagePath: doc.storagePath!,
            outputDir: join(process.cwd(), 'tiles')
          });

          if (page === 1) {
            firstPageResult = result;
          }
        }

        return firstPageResult;
      });

      // Save tile config
      await step.run('save-tile-config', async () => {
        await db
          .update(documents)
          .set({ tileConfig: JSON.stringify(tileResult) })
          .where(eq(documents.id, documentId));
      });

      // Run AI extraction for line items
      const aiResult = await step.run('ai-extract', async () => {
        return await extractLineItems(extraction.text, doc.filename);
      });

      // Save line items
      if (aiResult.items.length > 0) {
        await step.run('save-line-items', async () => {
          const itemsToInsert = aiResult.items.map((item) => ({
            bidId,
            documentId,
            category: item.category,
            description: item.description,
            estimatedQty: item.estimatedQty,
            unit: item.unit,
            pageReference: item.pageReference,
            extractionConfidence: item.confidence,
            reviewStatus: 'pending' as const,
          }));

          await db.insert(lineItems).values(itemsToInsert);
        });
      }

      // Mark as completed
      await step.run('set-completed', async () => {
        await db
          .update(documents)
          .set({ extractionStatus: 'completed' })
          .where(eq(documents.id, documentId));
      });

      return {
        documentId,
        itemsExtracted: aiResult.items.length,
        summary: aiResult.summary
      };

    } catch (error) {
      // Mark as failed
      await step.run('set-failed', async () => {
        await db
          .update(documents)
          .set({ extractionStatus: 'failed' })
          .where(eq(documents.id, documentId));
      });

      throw error;
    }
  }
);

// Export all functions for Inngest serve
export const functions = [dailySync, syncUser, syncConnection, extractDocument];
