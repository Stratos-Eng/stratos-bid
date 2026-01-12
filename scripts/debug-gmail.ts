/**
 * Debug script to investigate Gmail sync issues
 * Run with: npx tsx scripts/debug-gmail.ts
 */

import 'dotenv/config';
import { google } from 'googleapis';
import { db } from '../src/db';
import { connections, users } from '../src/db/schema';
import { eq, and } from 'drizzle-orm';
import { decryptCredentials, OAuthCredentials } from '../src/lib/crypto';

async function debug() {
  console.log('\n=== Gmail Sync Debug ===\n');

  // 1. Find Gmail connection
  console.log('1. Looking for Gmail connections...');
  const gmailConnections = await db
    .select()
    .from(connections)
    .where(eq(connections.platform, 'gmail'));

  if (gmailConnections.length === 0) {
    console.log('   ❌ No Gmail connections found!');
    return;
  }

  console.log(`   ✓ Found ${gmailConnections.length} Gmail connection(s)`);

  const conn = gmailConnections[0];
  console.log(`   Connection ID: ${conn.id}`);
  console.log(`   Status: ${conn.status}`);
  console.log(`   Last synced: ${conn.lastSynced}`);

  // 2. Check credentials
  console.log('\n2. Checking credentials...');
  if (!conn.credentials) {
    console.log('   ❌ No credentials stored!');
    return;
  }

  let creds: OAuthCredentials;
  try {
    creds = decryptCredentials<OAuthCredentials>(conn.credentials);
    console.log('   ✓ Credentials decrypted successfully');
    console.log(`   Access token: ${creds.accessToken?.substring(0, 20)}...`);
    console.log(`   Refresh token: ${creds.refreshToken ? 'present' : 'MISSING'}`);
    console.log(`   Expires at: ${new Date(creds.expiresAt).toISOString()}`);
    console.log(`   Token expired: ${Date.now() > creds.expiresAt ? 'YES' : 'no'}`);
  } catch (e) {
    console.log(`   ❌ Failed to decrypt: ${e}`);
    return;
  }

  // 3. Initialize Gmail API
  console.log('\n3. Initializing Gmail API...');
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    access_token: creds.accessToken,
    refresh_token: creds.refreshToken,
    expiry_date: creds.expiresAt,
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // 4. Test basic API access
  console.log('\n4. Testing Gmail API access...');
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.log(`   ✓ Connected as: ${profile.data.emailAddress}`);
    console.log(`   Total messages: ${profile.data.messagesTotal}`);
  } catch (e: any) {
    console.log(`   ❌ API error: ${e.message}`);
    if (e.message.includes('invalid_grant')) {
      console.log('   → Token expired or revoked. User needs to re-authenticate.');
    }
    return;
  }

  // 5. Test different queries
  console.log('\n5. Testing Gmail queries...');

  const queries = [
    // Current query
    'subject:("invitation to bid" OR "bid invitation" OR "request for proposal" OR "rfp" OR "rfq" OR "you have been invited" OR "project invitation" OR "new project" OR "bidding opportunity")',
    // Simpler queries
    'subject:invitation',
    'subject:bid',
    'subject:project',
    // From specific senders
    'from:planhub',
    'from:buildingconnected',
    // Very broad
    'newer_than:7d',
  ];

  for (const q of queries) {
    try {
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: q,
        maxResults: 10,
      });
      const count = response.data.messages?.length || 0;
      console.log(`   "${q.substring(0, 50)}..." → ${count} messages`);
    } catch (e: any) {
      console.log(`   "${q.substring(0, 50)}..." → ERROR: ${e.message}`);
    }
  }

  // 6. Sample some recent emails
  console.log('\n6. Sampling recent emails to see actual subjects...');
  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'newer_than:7d',
      maxResults: 20,
    });

    const messages = response.data.messages || [];
    console.log(`   Found ${messages.length} recent emails. Subjects:\n`);

    for (const msg of messages.slice(0, 15)) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      });

      const headers = full.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const from = headers.find(h => h.name === 'From')?.value || '(unknown)';

      // Truncate for display
      const shortSubject = subject.length > 60 ? subject.substring(0, 60) + '...' : subject;
      const shortFrom = from.length > 40 ? from.substring(0, 40) + '...' : from;

      console.log(`   From: ${shortFrom}`);
      console.log(`   Subject: ${shortSubject}\n`);
    }
  } catch (e: any) {
    console.log(`   ❌ Error: ${e.message}`);
  }

  // 7. Check what bid-related emails look like
  console.log('\n7. Looking for bid-related emails specifically...');
  try {
    // Try a broad search for bid-related content
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'bid OR invitation OR project OR RFP newer_than:30d',
      maxResults: 20,
    });

    const messages = response.data.messages || [];
    console.log(`   Found ${messages.length} potentially bid-related emails:\n`);

    for (const msg of messages.slice(0, 10)) {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      });

      const headers = full.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
      const from = headers.find(h => h.name === 'From')?.value || '(unknown)';

      console.log(`   From: ${from}`);
      console.log(`   Subject: ${subject}\n`);
    }
  } catch (e: any) {
    console.log(`   ❌ Error: ${e.message}`);
  }

  console.log('\n=== Debug Complete ===\n');
}

debug().catch(console.error);
