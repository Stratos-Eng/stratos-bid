/**
 * PlanetBids Vendor Signup Automation
 *
 * Automates the vendor registration process for PlanetBids portals.
 * Fills out the registration form - you must manually click Submit.
 *
 * Usage:
 *   npx tsx scripts/planetbids-signup.ts single <portal_id>  # Sign up for one portal
 *   npx tsx scripts/planetbids-signup.ts batch               # Sign up for all unregistered
 *
 * Required env vars:
 *   PLANETBIDS_COMPANY_NAME - Your company name
 *   PLANETBIDS_FEI_SSN - Tax ID (FEI/SSN)
 *   PLANETBIDS_EMAIL - Contact email
 */

import 'dotenv/config';
import { chromium, Page } from 'playwright';
import { db } from '../src/db';
import { planetbidsPortals } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import * as readline from 'readline';

interface VendorInfo {
  companyName: string;
  feiSsn: string;
  email: string;
}

function getVendorInfo(): VendorInfo {
  const required = ['PLANETBIDS_COMPANY_NAME', 'PLANETBIDS_FEI_SSN', 'PLANETBIDS_EMAIL'];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.log('\n❌ Missing required environment variables:\n');
    missing.forEach((key) => console.log(`  - ${key}`));
    console.log('\nAdd these to your .env file:');
    console.log('  PLANETBIDS_COMPANY_NAME=Your Company Name');
    console.log('  PLANETBIDS_FEI_SSN=12-3456789');
    console.log('  PLANETBIDS_EMAIL=you@company.com');
    process.exit(1);
  }

  return {
    companyName: process.env.PLANETBIDS_COMPANY_NAME!,
    feiSsn: process.env.PLANETBIDS_FEI_SSN!,
    email: process.env.PLANETBIDS_EMAIL!,
  };
}

async function signupForPortal(page: Page, portalId: string, vendor: VendorInfo): Promise<boolean> {
  console.log(`\nSigning up for portal ${portalId}...`);

  try {
    // Navigate to portal home
    const homeUrl = `https://pbsystem.planetbids.com/portal/${portalId}/portal-home`;
    await page.goto(homeUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Click LOG IN button
    await page.click('text=/LOG IN/i');
    await page.waitForTimeout(1500);

    // Click Register/Sign Up link
    const registerLink = await page.$('text=/register|sign up|create.*account/i');
    if (!registerLink) {
      console.log('  Could not find registration link');
      await page.screenshot({ path: `screenshots/signup-${portalId}-no-register.png` });
      return false;
    }
    await registerLink.click();
    await page.waitForTimeout(2000);

    // Fill the registration form
    // Company Name
    const companyInput = await page.$('input[placeholder*="Company" i], input[name*="company" i]');
    if (companyInput) {
      await companyInput.fill(vendor.companyName);
      console.log('  ✓ Filled: Company Name');
    }

    // FEI/SSN (Tax ID)
    const feiInput = await page.$(
      'input[placeholder*="FEI" i], input[placeholder*="SSN" i], input[name*="fei" i], input[name*="ssn" i], input[name*="tax" i]'
    );
    if (feiInput) {
      await feiInput.fill(vendor.feiSsn);
      console.log('  ✓ Filled: FEI/SSN');
    }

    // Email
    const emailInput = await page.$('input[placeholder*="Email" i], input[type="email"], input[name*="email" i]');
    if (emailInput) {
      await emailInput.fill(vendor.email);
      console.log('  ✓ Filled: Email');
    }

    // Take screenshot of filled form
    await page.screenshot({ path: `screenshots/signup-${portalId}-filled.png`, fullPage: true });
    console.log('  Screenshot saved: filled form');

    return true;
  } catch (error) {
    console.error('  Error:', error);
    await page.screenshot({ path: `screenshots/signup-${portalId}-error.png` });
    return false;
  }
}

async function waitForInput(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function signupSingle(portalId: string) {
  const vendor = getVendorInfo();

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const success = await signupForPortal(page, portalId, vendor);

  if (success) {
    console.log('\n✓ Form filled. Review and click SIGN UP manually.');
    console.log('  After registration, you will receive an email to complete setup.');
    console.log('\n  Browser will stay open for 5 minutes. Close when done.');

    // Keep browser open for manual submission
    await page.waitForTimeout(300000);
  }

  await browser.close();
}

async function signupBatch() {
  const vendor = getVendorInfo();

  // Get unregistered portals
  const portals = await db
    .select()
    .from(planetbidsPortals)
    .where(eq(planetbidsPortals.registered, false));

  if (portals.length === 0) {
    console.log('\n✓ All portals are already registered!\n');
    return;
  }

  console.log(`\nFound ${portals.length} unregistered portals:\n`);
  portals.forEach((p) => console.log(`  ${p.portalId}: ${p.name || 'Unknown'}`));

  console.log('\n--- Starting Batch Signup ---');
  console.log('For each portal, the form will be filled and browser will pause.');
  console.log('Review the form, click SIGN UP, then press Enter to continue.\n');

  for (const portal of portals) {
    const browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Portal: ${portal.portalId} - ${portal.name || 'Unknown'}`);
    console.log('='.repeat(50));

    const success = await signupForPortal(page, portal.portalId, vendor);

    if (success) {
      console.log('\n  → Review form and click SIGN UP');
      const input = await waitForInput('  → Press Enter when done (or "s" to skip): ');

      if (input.toLowerCase() !== 's') {
        await db
          .update(planetbidsPortals)
          .set({ registered: true })
          .where(eq(planetbidsPortals.portalId, portal.portalId));
        console.log('  ✓ Marked as registered');
      } else {
        console.log('  → Skipped');
      }
    }

    await browser.close();
  }

  console.log('\n✓ Batch signup complete!\n');
}

async function main() {
  const command = process.argv[2];
  const portalId = process.argv[3];

  if (command === 'single' && portalId) {
    await signupSingle(portalId);
  } else if (command === 'batch') {
    await signupBatch();
  } else {
    console.log('\nPlanetBids Vendor Signup Automation\n');
    console.log('Usage:');
    console.log('  npx tsx scripts/planetbids-signup.ts single <portal_id>  # Sign up for one portal');
    console.log('  npx tsx scripts/planetbids-signup.ts batch               # Sign up for all unregistered\n');
    console.log('Setup:');
    console.log('  1. Add these to your .env file:');
    console.log('     PLANETBIDS_COMPANY_NAME=Your Company Name');
    console.log('     PLANETBIDS_FEI_SSN=12-3456789');
    console.log('     PLANETBIDS_EMAIL=you@company.com');
    console.log('  2. Run "npx tsx scripts/planetbids-discover.ts seed" to add portals');
    console.log('  3. Run signup command\n');

    // Show current unregistered portals
    const portals = await db
      .select()
      .from(planetbidsPortals)
      .where(eq(planetbidsPortals.registered, false));

    console.log('Current unregistered portals:');
    if (portals.length === 0) {
      console.log('  (none - all registered!)');
    } else {
      portals.forEach((p) => console.log(`  ${p.portalId}: ${p.name || 'Unknown'}`));
    }
  }
}

main().catch(console.error);
