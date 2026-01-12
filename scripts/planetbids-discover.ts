/**
 * PlanetBids Portal Discovery
 *
 * Discovers PlanetBids government portals by probing ID ranges.
 * Use this to find new agencies to scrape bids from.
 *
 * Usage:
 *   npx tsx scripts/planetbids-discover.ts seed           # Seed known CA portals
 *   npx tsx scripts/planetbids-discover.ts probe 14000 14100  # Probe ID range
 *   npx tsx scripts/planetbids-discover.ts list           # List all portals
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import { db } from '../src/db';
import { planetbidsPortals } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { KNOWN_CA_PORTALS, DISCOVERY_RANGES } from '../src/scrapers/planetbids';

async function probePortal(portalId: string): Promise<{ portalId: string; name: string } | null> {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    const url = `https://pbsystem.planetbids.com/portal/${portalId}/bo/bo-search`;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    if (!response || response.status() !== 200) {
      return null;
    }

    // Wait for JS to render
    await page.waitForTimeout(2000);

    // Try to get agency name from page
    const name = await page.evaluate(() => {
      const header = document.querySelector('header');
      if (header) {
        const text = header.textContent || '';
        const lines = text.split('\n').filter((l) => l.trim().length > 0);
        if (lines.length > 0) return lines[0].trim();
      }
      return document.title.replace('PlanetBids Vendor Portal', '').trim() || 'Unknown';
    });

    // Check if it's a real portal (has bids or content)
    const hasBids = await page.$('text=/Found \\d+ bids/');
    if (!hasBids) {
      return null;
    }

    return { portalId, name };
  } catch {
    return null;
  } finally {
    await browser.close();
  }
}

async function discoverPortals(startId: number, endId: number) {
  console.log(`\nProbing portal IDs from ${startId} to ${endId}...\n`);

  const discovered: { portalId: string; name: string }[] = [];

  for (let id = startId; id <= endId; id++) {
    process.stdout.write(`Probing ${id}... `);
    const result = await probePortal(id.toString());

    if (result) {
      console.log(`✓ Found: ${result.name}`);
      discovered.push(result);

      // Save to database
      await db
        .insert(planetbidsPortals)
        .values({
          portalId: result.portalId,
          name: result.name,
          state: 'CA',
        })
        .onConflictDoNothing();
    } else {
      console.log('✗');
    }

    // Small delay to be polite
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDiscovered ${discovered.length} portals:`);
  for (const p of discovered) {
    console.log(`  ${p.portalId}: ${p.name}`);
  }

  return discovered;
}

async function seedKnownPortals() {
  console.log('\n=== Seeding Known California Portals ===\n');

  for (const portal of KNOWN_CA_PORTALS) {
    const existing = await db
      .select()
      .from(planetbidsPortals)
      .where(eq(planetbidsPortals.portalId, portal.portalId))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(planetbidsPortals).values({
        portalId: portal.portalId,
        name: portal.name,
        state: 'CA',
      });
      console.log(`  ✓ Added: ${portal.portalId} - ${portal.name}`);
    } else {
      console.log(`  • Exists: ${portal.portalId} - ${portal.name}`);
    }
  }

  console.log(`\nSeeded ${KNOWN_CA_PORTALS.length} known portals.`);
}

async function listPortals() {
  console.log('\n=== PlanetBids Portals ===\n');

  const portals = await db.select().from(planetbidsPortals);

  if (portals.length === 0) {
    console.log('No portals found. Run "seed" to add known CA portals.');
    return;
  }

  console.log('ID       | Registered | Last Scraped        | Name');
  console.log('-'.repeat(70));

  for (const p of portals) {
    const reg = p.registered ? '✓' : ' ';
    const lastScraped = p.lastScraped ? p.lastScraped.toISOString().slice(0, 16) : 'never';
    console.log(`${p.portalId.padEnd(8)} | ${reg.padEnd(10)} | ${lastScraped.padEnd(19)} | ${p.name || 'Unknown'}`);
  }

  console.log(`\nTotal: ${portals.length} portals`);
  console.log(`Registered: ${portals.filter((p) => p.registered).length}`);
}

async function main() {
  const command = process.argv[2];

  if (command === 'seed') {
    await seedKnownPortals();
  } else if (command === 'probe') {
    const start = parseInt(process.argv[3] || '14000');
    const end = parseInt(process.argv[4] || '14020');
    await discoverPortals(start, end);
  } else if (command === 'list') {
    await listPortals();
  } else {
    console.log('\nPlanetBids Portal Discovery\n');
    console.log('Usage:');
    console.log('  npx tsx scripts/planetbids-discover.ts seed              # Seed known CA portals');
    console.log('  npx tsx scripts/planetbids-discover.ts probe 14000 14100 # Probe ID range');
    console.log('  npx tsx scripts/planetbids-discover.ts list              # List all portals\n');
    console.log('Suggested ID ranges to probe:');
    for (const range of DISCOVERY_RANGES) {
      console.log(`  ${range.start}-${range.end}: ${range.note}`);
    }
  }
}

main().catch(console.error);
