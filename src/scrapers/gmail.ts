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

// Known bid platform senders
const BID_PLATFORM_SENDERS = [
  { pattern: /@planhub\.com$/i, platform: 'planhub' },
  { pattern: /@buildingconnected\.com$/i, platform: 'buildingconnected' },
  { pattern: /@autodesk\.com$/i, platform: 'buildingconnected' }, // BC is owned by Autodesk
  { pattern: /@planetbids\.com$/i, platform: 'planetbids' },
  { pattern: /@bidcontender\.com$/i, platform: 'bidcontender' },
  { pattern: /@isqft\.com$/i, platform: 'isqft' },
];

// Patterns to identify bid invitation emails
const BID_INVITATION_SUBJECTS = [
  /invitation to bid/i,
  /bid invitation/i,
  /request for (proposal|quote|bid)/i,
  /rfp|rfq/i,
  /you('ve| have) been invited/i,
  /project invitation/i,
  /new project/i,
  /bidding opportunity/i,
];

export class GmailScanner {
  private config: GmailScannerConfig;
  private oauth2Client: any;
  private gmail: any;

  constructor(config: GmailScannerConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    // Load credentials from database
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, this.config.connectionId))
      .limit(1);

    if (!connection || !connection.credentials) {
      throw new Error('Connection not found or missing credentials');
    }

    const credentials = decryptCredentials<OAuthCredentials>(connection.credentials);

    // Set up OAuth2 client
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
      // Build query for bid platform emails
      const senderQueries = BID_PLATFORM_SENDERS.map(s =>
        `from:${s.pattern.source.replace(/[\^\$\\]/g, '')}`
      ).join(' OR ');

      const query = `(${senderQueries}) after:${after.toISOString().split('T')[0]}`;

      // List messages
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
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const subject = this.getHeader(headers, 'Subject') || '';
    const from = this.getHeader(headers, 'From') || '';
    const date = this.getHeader(headers, 'Date') || '';

    // Check if this is a bid invitation
    const isBidInvitation = BID_INVITATION_SUBJECTS.some(pattern => pattern.test(subject));
    if (!isBidInvitation) {
      return null;
    }

    // Identify the platform
    const platform = this.identifyPlatform(from);
    if (!platform) {
      return null;
    }

    // Extract body
    const body = this.getMessageBody(msg.data);

    // Extract project link from body
    const projectUrl = this.extractProjectUrl(body, platform);

    return {
      sourceBidId: messageId,
      title: this.cleanSubject(subject),
      description: body.substring(0, 500), // First 500 chars
      sourceUrl: projectUrl,
      sourcePlatform: platform,
      invitedDate: new Date(date),
    };
  }

  private getHeader(headers: any[], name: string): string | null {
    const header = headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase());
    return header?.value || null;
  }

  private identifyPlatform(from: string): string | null {
    for (const sender of BID_PLATFORM_SENDERS) {
      if (sender.pattern.test(from)) {
        return sender.platform;
      }
    }
    return null;
  }

  private getMessageBody(payload: any): string {
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) {
          const nested = this.getMessageBody(part);
          if (nested) return nested;
        }
      }
      // Fall back to HTML
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
          return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
    }
    return '';
  }

  private extractProjectUrl(body: string, platform: string): string | undefined {
    // Platform-specific URL patterns
    const patterns: Record<string, RegExp> = {
      planhub: /https?:\/\/app\.planhub\.com\/projects?\/[\w-]+/i,
      buildingconnected: /https?:\/\/app\.buildingconnected\.com\/(bid-board|projects?)\/[\w-]+/i,
      planetbids: /https?:\/\/pbsystem\.planetbids\.com\/portal\/\d+\/bo\/[\w-]+/i,
    };

    const pattern = patterns[platform];
    if (pattern) {
      const match = body.match(pattern);
      if (match) return match[0];
    }

    // Generic URL extraction as fallback
    const genericMatch = body.match(/https?:\/\/[^\s<>"]+/);
    return genericMatch?.[0];
  }

  private cleanSubject(subject: string): string {
    // Remove common prefixes
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

      if (existing.length === 0) {
        const newBid: NewBid = {
          userId: this.config.userId,
          connectionId: this.config.connectionId,
          sourcePlatform: 'gmail', // The source is Gmail, even if the invite is from PlanHub
          sourceBidId: bid.sourceBidId,
          title: bid.title,
          description: `From: ${bid.sourcePlatform}\n${bid.description || ''}`,
          sourceUrl: bid.sourceUrl,
          invitedDate: bid.invitedDate,
          status: 'new',
        };
        await db.insert(bids).values(newBid);
        savedCount++;
      }
    }

    return savedCount;
  }
}
