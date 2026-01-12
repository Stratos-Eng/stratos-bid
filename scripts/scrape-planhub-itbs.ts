/**
 * Scrape PlanHub ITBs (Invitations to Bid)
 *
 * Logs into PlanHub, navigates to ITBs page, and scrapes all bid invitations.
 * This is more reliable than using email tracking URLs which don't preserve project context.
 *
 * Run with: npx tsx scripts/scrape-planhub-itbs.ts
 */

import 'dotenv/config';
import { db } from '../src/db';
import { connections, bids, documents, NewBid, NewDocument } from '../src/db/schema';
import { eq, and } from 'drizzle-orm';
import { PlanHubScraper } from '../src/scrapers/planhub';
import * as fs from 'fs';
import * as path from 'path';

interface ScrapeOptions {
  limit?: number;           // Max bids to process
  skipDownloads?: boolean;  // Skip document downloads
  dryRun?: boolean;         // Don't update DB
}

async function scrapePlanHubITBs(options: ScrapeOptions = {}) {
  const { limit, skipDownloads = false, dryRun = false } = options;

  console.log('\n=== Scraping PlanHub ITBs ===\n');

  // 1. Get PlanHub connection
  console.log('1. Checking PlanHub connection...');
  const [planhubConn] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.platform, 'planhub'),
        eq(connections.status, 'active')
      )
    );

  if (!planhubConn) {
    console.log('   ❌ No active PlanHub connection found!');
    return;
  }
  console.log(`   ✓ Found PlanHub connection for user ${planhubConn.userId}`);

  // 2. Initialize PlanHub scraper
  console.log('\n2. Initializing PlanHub scraper...');
  const scraper = new PlanHubScraper({
    connectionId: planhubConn.id,
    userId: planhubConn.userId,
    headless: false,
  });

  try {
    await scraper.init();
    console.log('   ✓ Browser initialized');

    // 3. Login to PlanHub
    console.log('\n3. Logging into PlanHub...');
    const loggedIn = await scraper.login();

    if (!loggedIn) {
      console.log('   ❌ Failed to login to PlanHub');
      return;
    }
    console.log('   ✓ Logged in successfully');

    // 4. Scrape ITBs
    console.log('\n4. Scraping ITBs...');
    const scrapedBids = await scraper.scrape();

    if (scrapedBids.length === 0) {
      console.log('   No bids found');
      return;
    }

    console.log(`   Found ${scrapedBids.length} bids`);

    // Apply limit if specified
    const bidsToProcess = limit ? scrapedBids.slice(0, limit) : scrapedBids;

    // 5. Save bids to database
    console.log('\n5. Saving bids...');

    let newCount = 0;
    let updatedCount = 0;

    for (const bid of bidsToProcess) {
      // Check if bid already exists
      const existing = await db
        .select()
        .from(bids)
        .where(
          and(
            eq(bids.userId, planhubConn.userId),
            eq(bids.sourcePlatform, 'planhub'),
            eq(bids.sourceBidId, bid.sourceBidId)
          )
        )
        .limit(1);

      if (!dryRun) {
        if (existing.length > 0) {
          // Update existing
          await db
            .update(bids)
            .set({
              title: bid.title,
              description: bid.description,
              projectAddress: bid.projectAddress,
              city: bid.city,
              state: bid.state,
              bidDueDate: bid.bidDueDate,
              sourceUrl: bid.sourceUrl,
              updatedAt: new Date(),
            })
            .where(eq(bids.id, existing[0].id));
          updatedCount++;
        } else {
          // Insert new
          const newBid: NewBid = {
            userId: planhubConn.userId,
            connectionId: planhubConn.id,
            sourcePlatform: 'planhub',
            sourceBidId: bid.sourceBidId,
            title: bid.title,
            description: bid.description,
            projectAddress: bid.projectAddress,
            city: bid.city,
            state: bid.state,
            bidDueDate: bid.bidDueDate,
            sourceUrl: bid.sourceUrl,
            status: 'new',
          };
          await db.insert(bids).values(newBid);
          newCount++;
        }
      }

      console.log(`   ${existing.length > 0 ? '↻' : '+'} "${bid.title.substring(0, 50)}..."`);
    }

    console.log(`\n   New bids: ${newCount}`);
    console.log(`   Updated bids: ${updatedCount}`);

    // 6. Optionally visit each project to get details and documents
    if (!skipDownloads && bidsToProcess.some(b => b.sourceUrl)) {
      console.log('\n6. Fetching project details...');

      for (const bid of bidsToProcess.slice(0, 5)) { // Limit detail fetches
        if (!bid.sourceUrl) continue;

        try {
          console.log(`\n   Fetching: "${bid.title.substring(0, 40)}..."`);
          const fullBid = await scraper.scrapeProjectByUrl(bid.sourceUrl);

          if (fullBid && fullBid.documents?.length) {
            console.log(`   Found ${fullBid.documents.length} documents`);

            if (!dryRun) {
              // Download documents
              const docsDir = path.join('docs', 'planhub', bid.sourceBidId);
              fs.mkdirSync(docsDir, { recursive: true });

              const downloaded = await scraper.downloadDocuments(fullBid);
              console.log(`   Downloaded ${downloaded.length} documents`);
            }
          }
        } catch (error) {
          console.log(`   Error: ${error}`);
        }

        // Delay between requests
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
      }
    }

    // 7. Summary
    console.log('\n=== Scrape Complete ===');
    console.log(`   Total processed: ${bidsToProcess.length}`);
    console.log(`   New: ${newCount}`);
    console.log(`   Updated: ${updatedCount}`);

  } finally {
    console.log('\nCleaning up...');
    await scraper.cleanup();
  }
}

// Parse command line args
const args = process.argv.slice(2);
const options: ScrapeOptions = {};

for (const arg of args) {
  if (arg.startsWith('--limit=')) {
    options.limit = parseInt(arg.split('=')[1], 10);
  }
  if (arg === '--skip-downloads') {
    options.skipDownloads = true;
  }
  if (arg === '--dry-run') {
    options.dryRun = true;
  }
}

scrapePlanHubITBs(options).catch(console.error);
