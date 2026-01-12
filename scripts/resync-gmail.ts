import 'dotenv/config';
import { db } from '../src/db';
import { connections, bids } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { GmailScanner } from '../src/scrapers/gmail';

async function resync() {
  console.log('\n=== Re-syncing Gmail with URL fix ===\n');

  // 1. Get Gmail connection
  const [conn] = await db.select().from(connections).where(eq(connections.platform, 'gmail'));
  if (!conn) {
    console.log('No Gmail connection found!');
    return;
  }

  // 2. Delete existing gmail-sourced bids to re-sync
  console.log('1. Deleting existing gmail-sourced bids...');
  const deleted = await db.delete(bids).where(eq(bids.sourcePlatform, 'gmail'));
  console.log('   Done');

  // 3. Create scanner and sync
  const scanner = new GmailScanner({
    connectionId: conn.id,
    userId: conn.userId,
  });

  console.log('\n2. Initializing scanner...');
  await scanner.init();

  console.log('\n3. Scanning emails...');
  const extractedBids = await scanner.scan(7);
  console.log(`   Found ${extractedBids.length} bids`);

  // Show URLs
  console.log('\n4. Sample bids with URLs:');
  for (const bid of extractedBids.slice(0, 10)) {
    console.log(`   - "${bid.title.substring(0, 50)}..."`);
    console.log(`     Platform: ${bid.sourcePlatform}`);
    console.log(`     URL: ${bid.sourceUrl || 'NONE'}\n`);
  }

  // 5. Save (without deep fetch for speed)
  console.log('5. Saving bids...');
  const savedCount = await scanner.saveBids(extractedBids, false);
  console.log(`   Saved ${savedCount} bids`);

  // 6. Verify
  const allBids = await db.select().from(bids).where(eq(bids.userId, conn.userId));
  console.log(`\n6. Total bids in DB: ${allBids.length}`);

  // Show ones with URLs
  const withUrls = allBids.filter(b => b.sourceUrl && !b.sourceUrl.includes('w3.org'));
  console.log(`   Bids with valid URLs: ${withUrls.length}`);

  console.log('\n=== Done ===\n');
}

resync().catch(console.error);
