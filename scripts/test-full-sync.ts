import 'dotenv/config';
import { db } from '../src/db';
import { connections, bids } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { GmailScanner } from '../src/scrapers/gmail';

async function test() {
  console.log('\n=== Testing Full Gmail Sync ===\n');

  // 1. Get Gmail connection
  const [conn] = await db.select().from(connections).where(eq(connections.platform, 'gmail'));
  if (!conn) {
    console.log('No Gmail connection found!');
    return;
  }
  console.log(`1. Found Gmail connection: ${conn.id}`);

  // 2. Create scanner
  const scanner = new GmailScanner({
    connectionId: conn.id,
    userId: conn.userId,
  });

  // 3. Initialize
  console.log('\n2. Initializing scanner...');
  await scanner.init();
  console.log('   ✓ Initialized');

  // 4. Scan emails
  console.log('\n3. Scanning emails...');
  const extractedBids = await scanner.scan(7);
  console.log(`   ✓ Found ${extractedBids.length} bids from emails`);

  if (extractedBids.length > 0) {
    console.log('\n   First 5 extracted bids:');
    for (const bid of extractedBids.slice(0, 5)) {
      console.log(`   - "${bid.title}" (${bid.sourcePlatform})`);
      console.log(`     URL: ${bid.sourceUrl || 'none'}`);
    }
  }

  // 5. Save bids
  console.log('\n4. Saving bids...');
  const savedCount = await scanner.saveBids(extractedBids);
  console.log(`   ✓ Saved ${savedCount} new bids`);

  // 6. Check database
  console.log('\n5. Checking database...');
  const allBids = await db.select().from(bids).where(eq(bids.userId, conn.userId));
  console.log(`   Total bids in DB for this user: ${allBids.length}`);

  if (allBids.length > 0) {
    console.log('\n   Recent bids:');
    for (const bid of allBids.slice(0, 5)) {
      console.log(`   - "${bid.title}" (${bid.sourcePlatform})`);
    }
  }

  console.log('\n=== Done ===\n');
}

test().catch(console.error);
