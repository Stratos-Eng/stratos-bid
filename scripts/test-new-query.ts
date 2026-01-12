import 'dotenv/config';
import { google } from 'googleapis';
import { db } from '../src/db';
import { connections } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { decryptCredentials, OAuthCredentials } from '../src/lib/crypto';

const BID_PLATFORM_SENDERS = [
  'planhub.com',
  'planhubprojects.com',
  'message.planhub.com',
  'buildingconnected.com',
  'autodesk.com',
  'planetbids.com',
  'procore.com',
  'isqft.com',
  'smartbid.co',
  'bidcontender.com',
];

const BID_SUBJECT_KEYWORDS = [
  'invitation to bid',
  'bid invitation',
  'request for proposal',
  'rfp',
  'rfq',
];

async function test() {
  const [conn] = await db.select().from(connections).where(eq(connections.platform, 'gmail'));
  const creds = decryptCredentials<OAuthCredentials>(conn.credentials!);

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

  // New combined query
  const after = new Date();
  after.setDate(after.getDate() - 7);

  const senderQuery = BID_PLATFORM_SENDERS.map(s => `from:${s}`).join(' OR ');
  const subjectQuery = BID_SUBJECT_KEYWORDS.map(k => `subject:"${k}"`).join(' OR ');
  const query = `(${senderQuery} OR ${subjectQuery}) after:${after.toISOString().split('T')[0]}`;

  console.log('Query:', query);
  console.log('');

  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 100,
  });

  const messages = response.data.messages || [];
  console.log(`Found ${messages.length} emails!\n`);

  // Show first 10
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

    console.log(`From: ${from}`);
    console.log(`Subject: ${subject}\n`);
  }
}

test().catch(console.error);
