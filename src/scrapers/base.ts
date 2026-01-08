import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { db } from '@/db';
import { bids, documents, NewBid, NewDocument } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export interface ScraperConfig {
  platform: string;
  connectionId: string;
  userId: string;
  headless?: boolean;
}

export interface ScrapedBid {
  sourceBidId: string;
  title: string;
  description?: string;
  projectAddress?: string;
  city?: string;
  state?: string;
  bidDueDate?: Date;
  postedDate?: Date;
  invitedDate?: Date;
  sourceUrl?: string;
  documents?: ScrapedDocument[];
}

export interface ScrapedDocument {
  filename: string;
  docType?: 'plans' | 'specs' | 'addendum' | 'other';
  downloadUrl: string;
  pageCount?: number;
}

export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;
  protected config: ScraperConfig;

  constructor(config: ScraperConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.config.headless ?? false, // PlanetBids blocks headless
    });
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    this.page = await this.context.newPage();
  }

  async cleanup(): Promise<void> {
    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
  }

  // Abstract methods to be implemented by platform scrapers
  abstract login(): Promise<boolean>;
  abstract scrape(): Promise<ScrapedBid[]>;

  // Common method to save bids to database
  async saveBids(scrapedBids: ScrapedBid[]): Promise<number> {
    let savedCount = 0;

    for (const bid of scrapedBids) {
      // Check if bid already exists
      const existing = await db
        .select()
        .from(bids)
        .where(
          and(
            eq(bids.userId, this.config.userId),
            eq(bids.sourcePlatform, this.config.platform),
            eq(bids.sourceBidId, bid.sourceBidId)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        // Update existing bid
        await db
          .update(bids)
          .set({
            title: bid.title,
            description: bid.description,
            projectAddress: bid.projectAddress,
            city: bid.city,
            state: bid.state,
            bidDueDate: bid.bidDueDate,
            postedDate: bid.postedDate,
            invitedDate: bid.invitedDate,
            sourceUrl: bid.sourceUrl,
            updatedAt: new Date(),
          })
          .where(eq(bids.id, existing[0].id));
      } else {
        // Insert new bid
        const newBid: NewBid = {
          userId: this.config.userId,
          connectionId: this.config.connectionId,
          sourcePlatform: this.config.platform,
          sourceBidId: bid.sourceBidId,
          title: bid.title,
          description: bid.description,
          projectAddress: bid.projectAddress,
          city: bid.city,
          state: bid.state,
          bidDueDate: bid.bidDueDate,
          postedDate: bid.postedDate,
          invitedDate: bid.invitedDate,
          sourceUrl: bid.sourceUrl,
          status: 'new',
        };
        await db.insert(bids).values(newBid);
        savedCount++;
      }
    }

    return savedCount;
  }

  // Helper to take debug screenshot
  async screenshot(name: string): Promise<void> {
    if (this.page) {
      await this.page.screenshot({
        path: `screenshots/${this.config.platform}-${name}-${Date.now()}.png`,
        fullPage: true,
      });
    }
  }

  // Helper for waiting with random delay (avoid detection)
  async randomDelay(min = 1000, max = 3000): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
