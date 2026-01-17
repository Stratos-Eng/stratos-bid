/**
 * Gmail Scanner - Stub implementation
 *
 * Scans Gmail for bid invitation emails from known platforms.
 * This is a simplified version - full implementation can be added later.
 */

import { google } from 'googleapis';
import { db } from '@/db';
import { connections, bids, NewBid } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { decryptCredentials, OAuthCredentials, encryptCredentials } from '@/lib/crypto';

interface GmailScannerConfig {
  connectionId: string;
  userId: string;
}

interface ExtractedBid {
  sourceBidId: string;
  title: string;
  description?: string;
  sourceUrl?: string;
  sourcePlatform: string;
  invitedDate: Date;
}

// Known bid platform sender domains
const BID_PLATFORM_SENDERS = [
  'planhub.com',
  'buildingconnected.com',
  'planetbids.com',
];

export class GmailScanner {
  private config: GmailScannerConfig;
  private oauth2Client: any;
  private gmail: any;

  constructor(config: GmailScannerConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, this.config.connectionId))
      .limit(1);

    if (!connection || !connection.credentials) {
      throw new Error('Connection not found or missing credentials');
    }

    const credentials = decryptCredentials<OAuthCredentials>(connection.credentials);

    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    this.oauth2Client.setCredentials({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
      expiry_date: credentials.expiresAt,
    });

    // Handle token refresh
    this.oauth2Client.on('tokens', async (tokens: any) => {
      const updatedCredentials: OAuthCredentials = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credentials.refreshToken,
        expiresAt: tokens.expiry_date,
      };

      await db
        .update(connections)
        .set({
          credentials: encryptCredentials(updatedCredentials),
          lastSynced: new Date(),
        })
        .where(eq(connections.id, this.config.connectionId));
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
  }

  async scan(daysBack = 7): Promise<ExtractedBid[]> {
    const extractedBids: ExtractedBid[] = [];
    const after = new Date();
    after.setDate(after.getDate() - daysBack);

    try {
      // Simple query: emails from known bid platforms
      const senderQuery = BID_PLATFORM_SENDERS.map(s => `from:${s}`).join(' OR ');
      const query = `(${senderQuery}) after:${after.toISOString().split('T')[0]}`;

      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 100,
      });

      const messages = response.data.messages || [];
      console.log(`Gmail: Found ${messages.length} potential bid emails`);

      for (const message of messages) {
        try {
          const bid = await this.parseMessage(message.id);
          if (bid) {
            extractedBids.push(bid);
          }
        } catch (error) {
          console.error(`Error parsing message ${message.id}:`, error);
        }
      }

      return extractedBids;
    } catch (error) {
      console.error('Gmail scan failed:', error);
      return extractedBids;
    }
  }

  private async parseMessage(messageId: string): Promise<ExtractedBid | null> {
    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['Subject', 'Date', 'From'],
    });

    const headers = msg.data.payload?.headers || [];
    const subject = this.getHeader(headers, 'Subject') || '';
    const date = this.getHeader(headers, 'Date') || '';
    const from = this.getHeader(headers, 'From') || '';

    // Detect platform from sender
    const platform = this.detectPlatform(from);

    return {
      sourceBidId: messageId,
      title: this.cleanSubject(subject),
      description: `From ${platform}`,
      sourcePlatform: platform,
      invitedDate: new Date(date),
    };
  }

  private getHeader(headers: any[], name: string): string | null {
    const header = headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase());
    return header?.value || null;
  }

  private detectPlatform(from: string): string {
    const fromLower = from.toLowerCase();
    if (fromLower.includes('planhub')) return 'planhub';
    if (fromLower.includes('buildingconnected')) return 'buildingconnected';
    if (fromLower.includes('planetbids')) return 'planetbids';
    return 'unknown';
  }

  private cleanSubject(subject: string): string {
    return subject
      .replace(/^(re|fwd|fw):\s*/i, '')
      .replace(/^\[.*?\]\s*/, '')
      .trim();
  }

  async saveBids(extractedBids: ExtractedBid[]): Promise<number> {
    let savedCount = 0;

    for (const bid of extractedBids) {
      // Check if bid already exists
      const existing = await db
        .select()
        .from(bids)
        .where(
          and(
            eq(bids.userId, this.config.userId),
            eq(bids.sourcePlatform, 'gmail'),
            eq(bids.sourceBidId, bid.sourceBidId)
          )
        )
        .limit(1);

      if (existing.length > 0) continue;

      const newBid: NewBid = {
        userId: this.config.userId,
        connectionId: this.config.connectionId,
        sourcePlatform: 'gmail',
        sourceBidId: bid.sourceBidId,
        title: bid.title,
        description: bid.description,
        invitedDate: bid.invitedDate,
        status: 'new',
      };

      await db.insert(bids).values(newBid);
      savedCount++;
    }

    return savedCount;
  }
}
