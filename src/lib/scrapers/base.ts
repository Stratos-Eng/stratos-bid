import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { db } from '@/db';
import { bids, connections, syncJobs } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export type ScrapedBid = {
  externalId: string;
  title: string;
  description?: string;
  dueDate?: Date;
  postedDate?: Date;
  sourceUrl?: string;
  projectAddress?: string;
  city?: string;
  state?: string;
  relevanceReasons?: Record<string, unknown>;
};

export type SyncResult = {
  success: boolean;
  bidsFound: number;
  bidsCreated: number;
  errors: string[];
};

export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;

  abstract readonly platform: string;

  protected async initBrowser(): Promise<void> {
    // Launch with headless: false because some platforms block headless browsers
    this.browser = await chromium.launch({
      headless: false,
    });
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    this.page = await this.context.newPage();
  }

  protected async closeBrowser(): Promise<void> {
    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  /**
   * Login to the platform with provided credentials
   */
  abstract login(credentials: { email: string; password: string }): Promise<boolean>;

  /**
   * Scrape bids from the platform
   */
  abstract scrapeBids(): Promise<ScrapedBid[]>;

  /**
   * Calculate relevance score based on trade keywords
   * Returns 0-100 score
   */
  protected calculateRelevance(bid: ScrapedBid): number {
    const text = `${bid.title} ${bid.description || ''}`.toLowerCase();

    // Keywords for glazing (Division 08) and signage (Division 10)
    const glazingKeywords = ['glass', 'glazing', 'window', 'curtain wall', 'storefront', 'skylight', 'mirror'];
    const signageKeywords = ['sign', 'signage', 'wayfinding', 'graphics', 'lettering', 'dimensional'];

    let score = 0;

    // Check glazing keywords
    for (const keyword of glazingKeywords) {
      if (text.includes(keyword)) {
        score += 15;
      }
    }

    // Check signage keywords
    for (const keyword of signageKeywords) {
      if (text.includes(keyword)) {
        score += 15;
      }
    }

    // Cap at 100
    return Math.min(score, 100);
  }

  /**
   * Save scraped bids to database using Drizzle ORM
   */
  protected async saveBids(
    userId: string,
    connectionId: string,
    scrapedBids: ScrapedBid[]
  ): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;

    for (const scraped of scrapedBids) {
      // Check if bid already exists using Drizzle query
      const existing = await db
        .select()
        .from(bids)
        .where(
          and(
            eq(bids.connectionId, connectionId),
            eq(bids.sourceBidId, scraped.externalId)
          )
        )
        .limit(1);

      const relevanceScore = this.calculateRelevance(scraped);

      if (existing.length > 0) {
        // Update existing bid using Drizzle
        await db
          .update(bids)
          .set({
            title: scraped.title,
            description: scraped.description,
            bidDueDate: scraped.dueDate,
            postedDate: scraped.postedDate,
            sourceUrl: scraped.sourceUrl,
            projectAddress: scraped.projectAddress,
            city: scraped.city,
            state: scraped.state,
            relevanceScore,
            relevanceReasons: scraped.relevanceReasons,
            updatedAt: new Date(),
          })
          .where(eq(bids.id, existing[0].id));
        updated++;
      } else {
        // Insert new bid using Drizzle
        await db.insert(bids).values({
          userId,
          connectionId,
          sourcePlatform: this.platform,
          sourceBidId: scraped.externalId,
          title: scraped.title,
          description: scraped.description,
          bidDueDate: scraped.dueDate,
          postedDate: scraped.postedDate,
          sourceUrl: scraped.sourceUrl,
          projectAddress: scraped.projectAddress,
          city: scraped.city,
          state: scraped.state,
          relevanceScore,
          relevanceReasons: scraped.relevanceReasons,
        });
        created++;
      }
    }

    return { created, updated };
  }

  /**
   * Run a full sync for a connection
   */
  async sync(userId: string, connectionId: string, credentials: { email: string; password: string }): Promise<SyncResult> {
    const errors: string[] = [];
    let bidsFound = 0;
    let bidsCreated = 0;

    // Create sync job record
    const [syncJob] = await db
      .insert(syncJobs)
      .values({
        userId,
        connectionId,
        status: 'running',
        startedAt: new Date(),
      })
      .returning();

    try {
      await this.initBrowser();

      // Login
      const loggedIn = await this.login(credentials);
      if (!loggedIn) {
        throw new Error('Failed to login');
      }

      // Scrape bids
      const scrapedBids = await this.scrapeBids();
      bidsFound = scrapedBids.length;

      // Save to database
      const { created } = await this.saveBids(userId, connectionId, scrapedBids);
      bidsCreated = created;

      // Update sync job as completed
      await db
        .update(syncJobs)
        .set({
          status: 'completed',
          completedAt: new Date(),
          bidsFound,
        })
        .where(eq(syncJobs.id, syncJob.id));

      // Update connection last synced
      await db
        .update(connections)
        .set({ lastSynced: new Date() })
        .where(eq(connections.id, connectionId));

      return {
        success: true,
        bidsFound,
        bidsCreated,
        errors,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      errors.push(errorMessage);

      // Update sync job as failed
      await db
        .update(syncJobs)
        .set({
          status: 'failed',
          completedAt: new Date(),
          errorMessage,
        })
        .where(eq(syncJobs.id, syncJob.id));

      return {
        success: false,
        bidsFound,
        bidsCreated,
        errors,
      };
    } finally {
      await this.closeBrowser();
    }
  }
}
