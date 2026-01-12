/**
 * Setup or fix PlanHub connection
 *
 * Run with: npx tsx scripts/setup-planhub-connection.ts
 */

import 'dotenv/config';
import { db } from '../src/db';
import { connections, users } from '../src/db/schema';
import { eq, and } from 'drizzle-orm';
import { encryptCredentials, PasswordCredentials } from '../src/lib/crypto';

async function setup() {
  console.log('\n=== Setting up PlanHub Connection ===\n');

  // Check env vars
  const email = process.env.PLANHUB_EMAIL;
  const password = process.env.PLANHUB_PASSWORD;

  if (!email || !password) {
    console.log('❌ Missing PLANHUB_EMAIL or PLANHUB_PASSWORD in .env');
    console.log('Please add these environment variables:');
    console.log('  PLANHUB_EMAIL=your@email.com');
    console.log('  PLANHUB_PASSWORD=yourpassword');
    return;
  }

  console.log(`Email: ${email}`);
  console.log(`Password: ${'*'.repeat(password.length)}`);

  // Get user
  const [user] = await db.select().from(users).limit(1);
  if (!user) {
    console.log('❌ No user found in database');
    return;
  }
  console.log(`\nUser: ${user.email} (${user.id})`);

  // Check existing connection
  const [existing] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.userId, user.id),
        eq(connections.platform, 'planhub')
      )
    );

  // Encrypt credentials
  const credentials: PasswordCredentials = { email, password };
  const encryptedCreds = encryptCredentials(credentials);

  if (existing) {
    console.log(`\nUpdating existing connection (status: ${existing.status})`);
    await db
      .update(connections)
      .set({
        credentials: encryptedCreds,
        status: 'active',
      })
      .where(eq(connections.id, existing.id));
    console.log('✓ Connection updated to active');
  } else {
    console.log('\nCreating new connection');
    await db.insert(connections).values({
      userId: user.id,
      platform: 'planhub',
      authType: 'password',
      status: 'active',
      credentials: encryptedCreds,
    });
    console.log('✓ Connection created');
  }

  // Verify
  const [conn] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.userId, user.id),
        eq(connections.platform, 'planhub')
      )
    );
  console.log(`\nVerified: ${conn.platform} - ${conn.status}`);
  console.log('\n=== Done ===\n');
}

setup().catch(console.error);
