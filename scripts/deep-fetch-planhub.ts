/**
 * Deep Fetch PlanHub Bids
 *
 * Takes Gmail-sourced bids with PlanHub URLs and:
 * 1. Logs into PlanHub
 * 2. Navigates to each bid URL
 * 3. Scrapes full bid details (due date, description, GC info)
 * 4. Downloads bid documents
 * 5. Updates the bid in the database
 *
 * Run with: npx tsx scripts/deep-fetch-planhub.ts
 */

import 'dotenv/config';
import { db } from '../src/db';
import { connections, bids, documents, NewDocument } from '../src/db/schema';
import { eq, and, like, or, isNull } from 'drizzle-orm';
import { PlanHubScraper } from '../src/scrapers/planhub';
import * as fs from 'fs';
import * as path from 'path';

interface DeepFetchOptions {
  limit?: number;           // Max bids to process (for testing)
  skipDownloads?: boolean;  // Skip document downloads
  dryRun?: boolean;         // Don't update DB, just log
}

async function deepFetchPlanHub(options: DeepFetchOptions = {}) {
  const { limit, skipDownloads = false, dryRun = false } = options;

  console.log('\n=== Deep Fetching PlanHub Bids ===\n');

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
    console.log('   Please connect PlanHub first in the dashboard.');
    return;
  }
  console.log(`   ✓ Found PlanHub connection for user ${planhubConn.userId}`);

  // 2. Get Gmail-sourced bids with PlanHub URLs that need deep fetch
  console.log('\n2. Finding bids to deep fetch...');

  let bidsToFetch = await db
    .select()
    .from(bids)
    .where(
      and(
        eq(bids.userId, planhubConn.userId),
        eq(bids.sourcePlatform, 'gmail'),
        or(
          like(bids.sourceUrl, '%planhub%'),
          like(bids.sourceUrl, '%itb.planhub%')
        )
      )
    );

  // Filter to bids that haven't been deep-fetched yet
  // (no bidDueDate or description starts with "From:")
  bidsToFetch = bidsToFetch.filter(bid =>
    !bid.bidDueDate ||
    bid.description?.startsWith('From:') ||
    bid.description?.startsWith('From: planhub')
  );

  if (bidsToFetch.length === 0) {
    console.log('   No bids need deep fetching.');
    return;
  }

  console.log(`   Found ${bidsToFetch.length} bids to deep fetch`);

  if (limit) {
    bidsToFetch = bidsToFetch.slice(0, limit);
    console.log(`   (limiting to ${limit} for this run)`);
  }

  // 3. Initialize PlanHub scraper
  console.log('\n3. Initializing PlanHub scraper...');
  const scraper = new PlanHubScraper({
    connectionId: planhubConn.id,
    userId: planhubConn.userId,
    headless: false, // Show browser for debugging
  });

  try {
    await scraper.init();
    console.log('   ✓ Browser initialized');

    // 4. Login to PlanHub
    console.log('\n4. Logging into PlanHub...');
    const loggedIn = await scraper.login();

    if (!loggedIn) {
      console.log('   ❌ Failed to login to PlanHub');
      return;
    }
    console.log('   ✓ Logged in successfully');

    // 5. Process each bid
    console.log('\n5. Processing bids...\n');

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < bidsToFetch.length; i++) {
      const bid = bidsToFetch[i];
      console.log(`[${i + 1}/${bidsToFetch.length}] "${bid.title}"`);
      console.log(`   URL: ${bid.sourceUrl?.substring(0, 60)}...`);

      try {
        // Navigate to the tracking URL (will redirect to project page)
        const scrapedBid = await scraper.scrapeProjectByUrl(bid.sourceUrl!);

        if (!scrapedBid) {
          console.log('   ⚠️ Could not scrape project details');
          failCount++;
          continue;
        }

        console.log(`   ✓ Scraped: ${scrapedBid.title}`);
        console.log(`   Location: ${scrapedBid.city}, ${scrapedBid.state}`);
        console.log(`   Due date: ${scrapedBid.bidDueDate || 'not found'}`);
        console.log(`   Documents: ${scrapedBid.documents?.length || 0}`);

        // Update bid in database
        if (!dryRun) {
          await db
            .update(bids)
            .set({
              title: scrapedBid.title || bid.title,
              description: scrapedBid.description,
              projectAddress: scrapedBid.projectAddress,
              city: scrapedBid.city,
              state: scrapedBid.state,
              bidDueDate: scrapedBid.bidDueDate,
              sourcePlatform: 'planhub', // Upgrade from gmail to planhub
              connectionId: planhubConn.id,
              updatedAt: new Date(),
            })
            .where(eq(bids.id, bid.id));

          console.log('   ✓ Updated bid in database');
        }

        // Download documents
        if (!skipDownloads && scrapedBid.documents?.length) {
          console.log(`   Downloading ${scrapedBid.documents.length} documents...`);

          // Ensure docs directory exists
          const docsDir = path.join('docs', 'planhub', scrapedBid.sourceBidId);
          fs.mkdirSync(docsDir, { recursive: true });

          const downloadedDocs = await scraper.downloadDocuments(scrapedBid);

          // Save document records to DB
          if (!dryRun) {
            for (const doc of downloadedDocs) {
              const newDoc: NewDocument = {
                bidId: bid.id,
                filename: doc.filename,
                docType: doc.docType || 'other',
                storagePath: doc.downloadUrl, // Local path after download
                pageCount: doc.pageCount,
                downloadedAt: new Date(),
              };
              await db.insert(documents).values(newDoc);
            }
            console.log(`   ✓ Downloaded ${downloadedDocs.length} documents`);
          }
        }

        successCount++;
        console.log('');

        // Random delay between bids to avoid rate limiting
        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));

      } catch (error) {
        console.log(`   ❌ Error: ${error}`);
        failCount++;
      }
    }

    // 6. Summary
    console.log('\n=== Deep Fetch Complete ===');
    console.log(`   ✓ Successful: ${successCount}`);
    console.log(`   ❌ Failed: ${failCount}`);
    console.log(`   Total processed: ${bidsToFetch.length}`);

  } finally {
    console.log('\nCleaning up...');
    await scraper.cleanup();
  }
}

// Parse command line args
const args = process.argv.slice(2);
const options: DeepFetchOptions = {};

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

deepFetchPlanHub(options).catch(console.error);
