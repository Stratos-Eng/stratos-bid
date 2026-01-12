import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { db } from '@/db';
import { bids, documents, NewBid, NewDocument } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import {
  askClaudeForHelp,
  executeBrowserAction,
  getKnownSelector,
  saveLearnedSelector,
  type BrowserAction,
} from '@/lib/browser-agent';

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

  /**
   * Scrape a single project by URL (for deep fetch from email links)
   * Override in platform scrapers that support this
   */
  async scrapeProjectByUrl(url: string): Promise<ScrapedBid | null> {
    console.log(`scrapeProjectByUrl not implemented for ${this.config.platform}`);
    return null;
  }

  /**
   * Download documents for a bid
   * Override in platform scrapers that support this
   */
  async downloadDocuments(bid: ScrapedBid): Promise<ScrapedDocument[]> {
    console.log(`downloadDocuments not implemented for ${this.config.platform}`);
    return [];
  }

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

  /**
   * Try to perform an action with selector, fall back to Claude agent if it fails
   */
  protected async tryWithFallback(
    actionName: string,
    selectors: string[],
    action: (selector: string) => Promise<void>,
    task: string
  ): Promise<boolean> {
    if (!this.page) throw new Error('Page not initialized');

    // First check if we have a learned selector
    const knownSelector = getKnownSelector(this.config.platform, actionName);
    if (knownSelector) {
      selectors = [knownSelector, ...selectors];
    }

    // Try each selector
    for (const selector of selectors) {
      try {
        await action(selector);
        console.log(`✓ ${actionName} succeeded with: ${selector}`);
        return true;
      } catch (error) {
        console.log(`✗ ${actionName} failed with: ${selector}`);
      }
    }

    // All selectors failed, ask Claude for help
    console.log(`⚡ Asking Claude agent for help with: ${actionName}`);
    await this.screenshot(`before-agent-${actionName}`);

    const context = `Platform: ${this.config.platform}\nAction: ${actionName}\nTried selectors: ${selectors.join(', ')}`;

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      const agentAction = await askClaudeForHelp(this.page, task, context);

      if (agentAction.type === 'fail') {
        console.error(`Agent gave up: ${agentAction.reason}`);
        return false;
      }

      if (agentAction.type === 'done') {
        // Save learned selector if provided
        if (agentAction.learnedSelector) {
          saveLearnedSelector(
            this.config.platform,
            actionName,
            agentAction.learnedSelector
          );
        }
        return true;
      }

      // Execute the action
      const success = await executeBrowserAction(this.page, agentAction);

      if (success && agentAction.learnedSelector) {
        saveLearnedSelector(
          this.config.platform,
          actionName,
          agentAction.learnedSelector
        );
      }

      // Give the page time to update
      await this.randomDelay(1000, 2000);
    }

    console.error(`Agent failed after ${maxAttempts} attempts`);
    return false;
  }

  /**
   * Click with fallback to Claude agent
   */
  protected async clickWithFallback(
    actionName: string,
    selectors: string[],
    task: string
  ): Promise<boolean> {
    return this.tryWithFallback(
      actionName,
      selectors,
      async (selector) => {
        await this.page!.click(selector, { timeout: 5000 });
      },
      task
    );
  }

  /**
   * Fill input with fallback to Claude agent
   */
  protected async fillWithFallback(
    actionName: string,
    selectors: string[],
    value: string,
    task: string
  ): Promise<boolean> {
    return this.tryWithFallback(
      actionName,
      selectors,
      async (selector) => {
        await this.page!.fill(selector, value, { timeout: 5000 });
      },
      task
    );
  }

  /**
   * Wait for navigation with fallback
   */
  protected async waitForUrlWithFallback(
    pattern: string | RegExp,
    task: string,
    timeout = 30000
  ): Promise<boolean> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      await this.page.waitForURL(pattern, { timeout });
      return true;
    } catch {
      console.log(`⚡ URL pattern not matched, asking Claude for help`);
      await this.screenshot('url-mismatch');

      // Ask Claude to help navigate
      const agentAction = await askClaudeForHelp(
        this.page,
        task,
        `Expected URL pattern: ${pattern}\nCurrent URL: ${this.page.url()}`
      );

      if (agentAction.type === 'done') {
        return true;
      }

      if (agentAction.type !== 'fail') {
        await executeBrowserAction(this.page, agentAction);
        // Check again after agent action
        try {
          await this.page.waitForURL(pattern, { timeout: 10000 });
          return true;
        } catch {
          return false;
        }
      }

      return false;
    }
  }
}
