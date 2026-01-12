import { google } from 'googleapis';
import { db } from '@/db';
import { connections, bids, NewBid } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { decryptCredentials, OAuthCredentials, encryptCredentials } from '@/lib/crypto';
import { createScraper } from './index';

/**
 * Resolve tracking URLs (like itb.planhub.com/ls/click?...) to their final destination.
 * This follows redirects without authentication to get the actual project URL.
 */
async function resolveTrackingUrl(url: string): Promise<string> {
  // Known tracking URL patterns that need resolution
  const trackingPatterns = [
    /itb\.planhub\.com\/ls\/click/i,
    /email\.buildingconnected\.com\//i,
    /click\.buildingconnected\.com\//i,
    /links\.autodesk\.com\//i,
    /t\.email\./i,
  ];

  const isTrackingUrl = trackingPatterns.some((p) => p.test(url));
  if (!isTrackingUrl) {
    return url;
  }

  try {
    let currentUrl = url;
    const maxRedirects = 10;

    for (let i = 0; i < maxRedirects; i++) {
      const response = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          if (location.startsWith('/')) {
            const urlObj = new URL(currentUrl);
            currentUrl = `${urlObj.protocol}//${urlObj.host}${location}`;
          } else if (!location.startsWith('http')) {
            currentUrl = new URL(location, currentUrl).href;
          } else {
            currentUrl = location;
          }
          continue;
        }
      }

      return currentUrl;
    }

    console.warn(`Too many redirects for URL: ${url}`);
    return url;
  } catch (error) {
    console.warn(`Failed to resolve tracking URL: ${error}`);
    return url;
  }
}

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

// Subject keywords for Gmail search query (some platforms use these)
const BID_SUBJECT_KEYWORDS = [
  'invitation to bid',
  'bid invitation',
  'request for proposal',
  'request for quote',
  'rfp',
  'rfq',
  'you have been invited',
  'project invitation',
  'bidding opportunity',
];

// Subject patterns that indicate NON-bid emails (filter out noise)
const EXCLUDE_SUBJECT_PATTERNS = [
  // Auth/security emails
  /one-time\s*(pass)?code/i,
  /passcode/i,
  /password/i,
  /verify\s*(your)?\s*(email|account|identity)/i,
  /verification\s*code/i,
  /security\s*code/i,
  /2fa|two.factor/i,
  /reset\s*(your\s*)?password/i,
  /confirm\s*(your\s*)?(email|account)/i,
  /sign\s*in\s*(from|attempt)/i,
  /login\s*(attempt|notification)/i,

  // Account/onboarding emails
  /partnership\s*introduction/i,
  /welcome\s*to/i,
  /join\s*(a\s*)?(company|team|office|organization)/i,
  /invitation\s*to\s*join/i,
  /you('ve|\s*have)\s*been\s*added/i,
  /account\s*(created|activated|setup)/i,

  // Marketing/promotional emails
  /maximize\s*(your)?\s*(free)?\s*trial/i,
  /free\s*trial/i,
  /upgrade\s*(your|to)/i,
  /new\s*feature/i,
  /product\s*update/i,
  /tips\s*(and|&)\s*tricks/i,
  /getting\s*started/i,
  /how\s*to\s*use/i,
  /newsletter/i,
  /unsubscribe/i,

  // Digest/summary emails (NOT actual ITBs)
  /digest/i,
  /weekly\s*(update|summary|report)/i,
  /daily\s*(update|summary|report)/i,
  /monthly\s*(update|summary|report)/i,
  /new\s*projects?\s*bidding\s*near/i,
  /projects?\s*near\s*you/i,
  /local\s*planning\s*project\s*report/i,
  /weekly\s*project\s*report/i,
  /project\s*digest/i,
  /\d+\s*new\s*(projects?|bids?|opportunities)/i,  // "5 new projects near you"
  /projects?\s*this\s*week/i,
  /opportunities?\s*this\s*week/i,
  /your\s*weekly/i,
  /your\s*daily/i,

  // Activity notifications (not ITBs)
  /bid\s*(has\s*been\s*)?(opened|closed|awarded)/i,
  /project\s*(has\s*been\s*)?(closed|cancelled|awarded)/i,
  /you\s*(were|have\s*been)\s*(not\s*)?selected/i,
  /award\s*notification/i,
  /bid\s*results/i,

  // GC outreach (not actual ITBs)
  /looking\s*for\s*subcontractors/i,
  /subcontractor\s*outreach/i,
  /introduce\s*(yourself|your\s*company)/i,
];

// Body patterns that indicate an ACTUAL bid invitation (positive signals)
// These should be specific enough to not match marketing emails
const BID_BODY_SIGNALS = [
  // Timing/deadline signals (strong)
  /bid\s*(due|deadline|closes?)\s*:?\s*\w+/i,
  /due\s*date\s*:?\s*\w+/i,
  /submission\s*deadline/i,
  /bidding\s*(closes?|ends?)/i,

  // Submission signals (strong)
  /submit\s*(your\s*)?bid/i,
  /submit\s*(your\s*)?(proposal|quote)/i,
  /invitation\s*to\s*bid/i,
  /request(ing)?\s*(your\s*)?(bid|proposal|quote)/i,

  // Project details signals (medium)
  /project\s*(address|location)\s*:/i,
  /scope\s*of\s*work/i,
  /work\s*scope/i,

  // Meeting signals (strong - very specific to bids)
  /pre-?bid\s*(meeting|conference|walk)/i,
  /mandatory\s*(site\s*)?(visit|meeting|walk)/i,
  /site\s*visit/i,

  // Document signals (medium)
  /addendum\s*#?\d*/i,
  /specifications\s*(available|attached)/i,
  /drawings\s*(available|attached)/i,
  /plans\s*(available|attached)/i,
  /bid\s*documents/i,
  /contract\s*documents/i,

  // Role signals (medium)
  /general\s*contractor/i,
  /subcontractor\s*(bid|invitation|opportunity)/i,
  /trade\s*(packages?|scope)/i,
  /division\s*\d+/i,

  // Value signals (medium)
  /estimated\s*(project\s*)?(value|cost|budget)/i,
  /project\s*value/i,

  // Action signals (weak - only count if combined with others)
  /view\s*(full\s*)?(project|bid|details)/i,
  /click\s*(here\s*)?to\s*(view|access|download)/i,
];

// High-confidence ITB sender domains (transactional emails, not marketing)
const HIGH_CONFIDENCE_ITB_SENDERS = [
  'message.planhub.com',      // PlanHub transactional
  'itb.planhub.com',          // PlanHub ITB notifications
  'notifications.buildingconnected.com',
  'invites.buildingconnected.com',
];

// Known bid platform sender domains (includes marketing - need extra filtering)
const BID_PLATFORM_SENDERS = [
  'planhub.com',
  'planhubprojects.com',
  'message.planhub.com',
  'itb.planhub.com',
  'buildingconnected.com',
  'notifications.buildingconnected.com',
  'autodesk.com',
  'planetbids.com',
  'procore.com',
  'isqft.com',
  'smartbid.co',
  'bidcontender.com',
];

// Platform URL patterns - detect platform from links in email body
const PLATFORM_URL_PATTERNS: { pattern: RegExp; platform: string }[] = [
  { pattern: /planhub\.com/i, platform: 'planhub' },
  { pattern: /buildingconnected\.com/i, platform: 'buildingconnected' },
  { pattern: /planetbids\.com/i, platform: 'planetbids' },
  { pattern: /procore\.com/i, platform: 'procore' },
  { pattern: /isqft\.com/i, platform: 'isqft' },
  { pattern: /smartbid/i, platform: 'smartbid' },
  { pattern: /bidcontender/i, platform: 'bidcontender' },
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
      // Build query: emails from known bid platforms OR with bid-related subjects
      const senderQuery = BID_PLATFORM_SENDERS.map(s => `from:${s}`).join(' OR ');
      const subjectQuery = BID_SUBJECT_KEYWORDS.map(k => `subject:"${k}"`).join(' OR ');
      const query = `(${senderQuery} OR ${subjectQuery}) after:${after.toISOString().split('T')[0]}`;
      console.log(`Gmail query: ${query}`);

      // List messages (increased limit to get more bids)
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 500,
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
    const date = this.getHeader(headers, 'Date') || '';
    const fromAddress = this.getHeader(headers, 'From') || '';

    // Get raw HTML first (for URL extraction), then stripped body (for description)
    const rawHtml = this.getRawHtml(msg.data.payload);
    const body = this.getMessageBody(msg.data.payload);

    // Check if this is a noise email (OTP, password reset, etc.)
    if (this.isNoiseEmail(subject, body)) {
      console.log(`  Skipping noise: "${subject.substring(0, 50)}..."`);
      return null;
    }

    // Detect platform from URLs in the RAW email (before stripping tags)
    const platform = this.detectPlatformFromBody(rawHtml || body);

    // Extract project link from RAW HTML (URLs are in <a href="...">)
    let projectUrl = this.extractProjectUrl(rawHtml || body, platform);

    // For emails from bid platforms, verify it's actually a bid invitation
    if (!this.isLikelyBidInvitation(subject, body, platform, projectUrl, fromAddress)) {
      console.log(`  Skipping (no bid signals): "${subject.substring(0, 50)}..."`);
      return null;
    }

    // Resolve tracking URLs to get actual project URLs
    if (projectUrl) {
      const resolvedUrl = await resolveTrackingUrl(projectUrl);
      if (resolvedUrl !== projectUrl) {
        console.log(`  Resolved tracking URL: ${projectUrl.substring(0, 50)}... → ${resolvedUrl.substring(0, 60)}...`);
        projectUrl = resolvedUrl;
      }
    }

    console.log(`  ✓ Bid found: "${this.cleanSubject(subject)}" → platform: ${platform}, url: ${projectUrl || 'none'}`);

    return {
      sourceBidId: messageId,
      title: this.cleanSubject(subject),
      description: body.substring(0, 500), // First 500 chars
      sourceUrl: projectUrl,
      sourcePlatform: platform,
      invitedDate: new Date(date),
    };
  }

  /**
   * Check if email is noise (OTP, password reset, account notifications, etc.)
   */
  private isNoiseEmail(subject: string, body: string): boolean {
    // Check subject against exclusion patterns
    for (const pattern of EXCLUDE_SUBJECT_PATTERNS) {
      if (pattern.test(subject)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if email is likely an actual bid invitation (not just from a bid platform)
   * STRICT filtering to reduce noise - better to miss some than get flooded
   */
  private isLikelyBidInvitation(
    subject: string,
    body: string,
    platform: string,
    projectUrl: string | undefined,
    fromAddress: string
  ): boolean {
    // Count body signals first - used in multiple checks
    let bidSignalCount = 0;
    for (const pattern of BID_BODY_SIGNALS) {
      if (pattern.test(body)) {
        bidSignalCount++;
      }
    }

    // Check if from high-confidence ITB sender (transactional, not marketing)
    const isHighConfidenceSender = HIGH_CONFIDENCE_ITB_SENDERS.some(
      domain => fromAddress.toLowerCase().includes(domain)
    );

    // HIGH CONFIDENCE: From ITB-specific subdomain + has project URL
    if (isHighConfidenceSender && projectUrl) {
      return true;
    }

    // HIGH CONFIDENCE: From ITB sender + 2+ body signals (even without URL)
    if (isHighConfidenceSender && bidSignalCount >= 2) {
      return true;
    }

    // MEDIUM CONFIDENCE: Known platform + project URL + at least 1 body signal
    if (platform !== 'unknown' && projectUrl && bidSignalCount >= 1) {
      return true;
    }

    // Check for strong bid-related keywords in subject
    const subjectLower = subject.toLowerCase();
    const strongSubjectKeywords = [
      'invitation to bid',
      'bid invitation',
      'itb',
      'rfp',
      'rfq',
      'request for proposal',
      'request for quote',
      'addendum',
      'pre-bid',
    ];
    const hasStrongSubjectKeyword = strongSubjectKeywords.some(kw => subjectLower.includes(kw));

    // MEDIUM CONFIDENCE: Strong subject keyword + project URL
    if (hasStrongSubjectKeyword && projectUrl) {
      return true;
    }

    // MEDIUM CONFIDENCE: Strong subject keyword + 2+ body signals
    if (hasStrongSubjectKeyword && bidSignalCount >= 2) {
      return true;
    }

    // LOW CONFIDENCE: 3+ body signals (strict - previously was 2)
    if (bidSignalCount >= 3) {
      return true;
    }

    // REJECT: Not enough signals
    return false;
  }

  private getHeader(headers: any[], name: string): string | null {
    const header = headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase());
    return header?.value || null;
  }

  /**
   * Get raw HTML from email (for URL extraction before tag stripping)
   */
  private getRawHtml(payload: any): string {
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    if (payload.parts) {
      // Prefer HTML for URL extraction
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) {
          const nested = this.getRawHtml(part);
          if (nested) return nested;
        }
      }
      // Fall back to plain text
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
    }
    return '';
  }

  private detectPlatformFromBody(body: string): string {
    // Extract all URLs from body
    const urls = body.match(/https?:\/\/[^\s<>"]+/gi) || [];

    for (const url of urls) {
      for (const { pattern, platform } of PLATFORM_URL_PATTERNS) {
        if (pattern.test(url)) {
          return platform;
        }
      }
    }

    return 'unknown'; // Fallback - still capture the bid
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
    // Platform-specific URL patterns (more flexible to catch various URL formats)
    const patterns: Record<string, RegExp[]> = {
      planhub: [
        /https?:\/\/[^\/]*planhub\.com\/[^\s<>"]+/gi,
        /https?:\/\/app\.planhub\.com\/projects?\/[\w-]+/i,
      ],
      buildingconnected: [
        /https?:\/\/[^\/]*buildingconnected\.com\/[^\s<>"]+/gi,
        /https?:\/\/app\.buildingconnected\.com\/(bid-board|projects?)\/[\w-]+/i,
      ],
      planetbids: [
        /https?:\/\/[^\/]*planetbids\.com\/[^\s<>"]+/gi,
      ],
      procore: [
        /https?:\/\/[^\/]*procore\.com\/[^\s<>"]+/gi,
      ],
    };

    // Try platform-specific patterns first
    const platformPatterns = patterns[platform];
    if (platformPatterns) {
      for (const pattern of platformPatterns) {
        const match = body.match(pattern);
        if (match) {
          // Clean up the URL (remove trailing punctuation)
          return match[0].replace(/[.,;:!?)]+$/, '');
        }
      }
    }

    // Try all known platform URLs as fallback
    for (const [, patternList] of Object.entries(patterns)) {
      for (const pattern of patternList) {
        const match = body.match(pattern);
        if (match) {
          return match[0].replace(/[.,;:!?)]+$/, '');
        }
      }
    }

    // Don't return generic URLs - they're often wrong (like w3.org namespace)
    return undefined;
  }

  private cleanSubject(subject: string): string {
    // Remove common prefixes
    return subject
      .replace(/^(re|fwd|fw):\s*/i, '')
      .replace(/^\[.*?\]\s*/, '')
      .trim();
  }

  async saveBids(extractedBids: ExtractedBid[], enableDeepFetch = true): Promise<number> {
    let savedCount = 0;

    // Group bids by platform for efficient deep fetching
    const bidsByPlatform = new Map<string, ExtractedBid[]>();
    for (const bid of extractedBids) {
      const platform = bid.sourcePlatform;
      if (!bidsByPlatform.has(platform)) {
        bidsByPlatform.set(platform, []);
      }
      bidsByPlatform.get(platform)!.push(bid);
    }

    // Check which platforms have credentials
    const platformConnections = new Map<string, typeof connections.$inferSelect>();
    if (enableDeepFetch) {
      const userConnections = await db
        .select()
        .from(connections)
        .where(eq(connections.userId, this.config.userId));

      for (const conn of userConnections) {
        if (conn.status === 'active' && conn.platform !== 'gmail') {
          platformConnections.set(conn.platform, conn);
        }
      }
    }

    // Process each platform
    for (const [platform, platformBids] of bidsByPlatform) {
      const platformConnection = platformConnections.get(platform);

      if (platformConnection && enableDeepFetch) {
        // Deep fetch from source platform
        console.log(`Gmail: Deep fetching ${platformBids.length} bids from ${platform}`);
        savedCount += await this.deepFetchBids(platformBids, platformConnection);
      } else {
        // Save minimal info from email
        savedCount += await this.saveMinimalBids(platformBids);
      }
    }

    return savedCount;
  }

  /**
   * Deep fetch bids from source platform (login, navigate, scrape full details)
   */
  private async deepFetchBids(
    emailBids: ExtractedBid[],
    platformConnection: typeof connections.$inferSelect
  ): Promise<number> {
    let savedCount = 0;
    const platform = platformConnection.platform as 'planhub' | 'buildingconnected';

    // Only support platforms with browser scrapers
    if (!['planhub', 'buildingconnected'].includes(platform)) {
      console.log(`Deep fetch not supported for ${platform}, saving minimal`);
      return this.saveMinimalBids(emailBids);
    }

    let scraper;
    try {
      scraper = createScraper(platform, {
        connectionId: platformConnection.id,
        userId: this.config.userId,
      });

      await scraper.init();
      const loggedIn = await scraper.login();

      if (!loggedIn) {
        console.error(`Could not login to ${platform}, saving minimal bids`);
        return this.saveMinimalBids(emailBids);
      }

      for (const emailBid of emailBids) {
        // Check if bid already exists
        const existing = await this.bidExists(emailBid.sourceBidId, platform);
        if (existing) {
          console.log(`  Skipping existing bid: ${emailBid.title}`);
          continue;
        }

        if (!emailBid.sourceUrl) {
          // No URL to fetch, save minimal
          await this.saveMinimalBid(emailBid);
          savedCount++;
          continue;
        }

        try {
          console.log(`  Deep fetching: ${emailBid.title}`);
          const fullBid = await scraper.scrapeProjectByUrl(emailBid.sourceUrl);

          if (fullBid) {
            // Save full bid data
            const newBid: NewBid = {
              userId: this.config.userId,
              connectionId: platformConnection.id,
              sourcePlatform: platform, // Use actual platform, not gmail
              sourceBidId: fullBid.sourceBidId,
              title: fullBid.title,
              description: fullBid.description,
              projectAddress: fullBid.projectAddress,
              city: fullBid.city,
              state: fullBid.state,
              bidDueDate: fullBid.bidDueDate,
              invitedDate: emailBid.invitedDate,
              sourceUrl: fullBid.sourceUrl,
              status: 'new',
            };
            await db.insert(bids).values(newBid);
            savedCount++;

            // Download documents if available
            if (fullBid.documents?.length) {
              console.log(`  Downloading ${fullBid.documents.length} documents...`);
              await scraper.downloadDocuments(fullBid);
            }
          } else {
            // Deep fetch failed, save minimal
            await this.saveMinimalBid(emailBid);
            savedCount++;
          }
        } catch (error) {
          console.error(`  Error deep fetching ${emailBid.title}:`, error);
          await this.saveMinimalBid(emailBid);
          savedCount++;
        }
      }
    } finally {
      if (scraper) {
        await scraper.cleanup();
      }
    }

    return savedCount;
  }

  /**
   * Save minimal bid info from email (no platform credentials)
   */
  private async saveMinimalBids(emailBids: ExtractedBid[]): Promise<number> {
    let savedCount = 0;
    for (const bid of emailBids) {
      if (await this.saveMinimalBid(bid)) {
        savedCount++;
      }
    }
    return savedCount;
  }

  private async saveMinimalBid(bid: ExtractedBid): Promise<boolean> {
    const existing = await this.bidExists(bid.sourceBidId, 'gmail');
    if (existing) return false;

    const newBid: NewBid = {
      userId: this.config.userId,
      connectionId: this.config.connectionId,
      sourcePlatform: 'gmail',
      sourceBidId: bid.sourceBidId,
      title: bid.title,
      description: `From: ${bid.sourcePlatform}\n${bid.description || ''}`,
      sourceUrl: bid.sourceUrl,
      invitedDate: bid.invitedDate,
      status: 'new',
    };
    await db.insert(bids).values(newBid);
    return true;
  }

  private async bidExists(sourceBidId: string, sourcePlatform: string): Promise<boolean> {
    const existing = await db
      .select()
      .from(bids)
      .where(
        and(
          eq(bids.userId, this.config.userId),
          eq(bids.sourcePlatform, sourcePlatform),
          eq(bids.sourceBidId, sourceBidId)
        )
      )
      .limit(1);
    return existing.length > 0;
  }
}
