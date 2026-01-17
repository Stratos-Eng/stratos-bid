import { db } from '../src/db';
import { users, bids, documents } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { copyFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { execSync } from 'child_process';

const SOURCE_PDF = '/Users/hamza/experiments/doc-extraction/Bid Plans_20251125A-GP OMF_Full Set 2025-11-24_stamped.pdf';

async function seed() {
  console.log('Starting seed...');

  // Find the user
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, 'hamza.surti1@gmail.com'))
    .limit(1);

  if (!user) {
    console.error('User not found. Please log in first.');
    process.exit(1);
  }

  console.log('Found user:', user.id);

  // Create the bid
  const [bid] = await db
    .insert(bids)
    .values({
      userId: user.id,
      sourcePlatform: 'manual',
      sourceBidId: 'great-parks-omf-2025',
      title: 'Great Parks OMF - Irvine',
      description: 'Operations & Maintenance Facility for Great Park Neighborhoods',
      city: 'Irvine',
      state: 'CA',
      status: 'reviewing',
    })
    .returning();

  console.log('Created bid:', bid.id);

  // Set up storage path
  const docsDir = join(process.cwd(), 'docs', 'manual', 'great-parks-omf-2025');
  await mkdir(docsDir, { recursive: true });

  const filename = 'Bid Plans_20251125A-GP OMF_Full Set.pdf';
  const storagePath = join(docsDir, filename);

  // Copy PDF
  console.log('Copying PDF...');
  await copyFile(SOURCE_PDF, storagePath);
  console.log('PDF copied to:', storagePath);

  // Get page count
  let pageCount = 166; // Default if pdfinfo fails
  try {
    const pdfInfoOutput = execSync(`pdfinfo "${storagePath}" 2>/dev/null | grep Pages`, { encoding: 'utf-8' });
    const match = pdfInfoOutput.match(/Pages:\s+(\d+)/);
    if (match) {
      pageCount = parseInt(match[1], 10);
    }
  } catch (e) {
    console.log('Could not get page count, using default:', pageCount);
  }

  // Create document record
  const [doc] = await db
    .insert(documents)
    .values({
      bidId: bid.id,
      filename,
      docType: 'plans',
      storagePath,
      pageCount,
      downloadedAt: new Date(),
      extractionStatus: 'not_started',
    })
    .returning();

  console.log('Created document:', doc.id);

  console.log('\n=== SEED COMPLETE ===');
  console.log('Bid ID:', bid.id);
  console.log('Document ID:', doc.id);
  console.log('\nNow trigger extraction by running:');
  console.log(`curl -X POST "http://localhost:3000/api/extraction" -H "Content-Type: application/json" -d '{"documentId":"${doc.id}"}'`);
  console.log('\nOr visit the bid page and click Extract');
  console.log(`http://localhost:3000/bids/${bid.id}`);

  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
