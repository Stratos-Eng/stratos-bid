import { BaseScraper, ScraperConfig, ScrapedBid, ScrapedDocument } from './base';
import { decryptCredentials, PasswordCredentials } from '@/lib/crypto';
import { db } from '@/db';
import { connections } from '@/db/schema';
import { eq } from 'drizzle-orm';

export class BuildingConnectedScraper extends BaseScraper {
  private credentials: PasswordCredentials | null = null;

  constructor(config: Omit<ScraperConfig, 'platform'>) {
    super({ ...config, platform: 'buildingconnected' });
  }

  async loadCredentials(): Promise<void> {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, this.config.connectionId))
      .limit(1);

    if (!connection || !connection.credentials) {
      throw new Error('Connection not found or missing credentials');
    }

    this.credentials = decryptCredentials<PasswordCredentials>(connection.credentials);
  }

  async login(): Promise<boolean> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call init() first.');
    }

    await this.loadCredentials();
    if (!this.credentials) {
      throw new Error('Credentials not loaded');
    }

    try {
      // Navigate to BuildingConnected login page
      await this.page.goto('https://app.buildingconnected.com/login', {
        waitUntil: 'networkidle',
      });

      await this.randomDelay(1000, 2000);

      // Fill email first
      await this.page.fill('input[name="email"], input[type="email"], #email', this.credentials.email);
      await this.randomDelay(500, 1000);

      // Some login flows have a "Continue" button before password
      const continueButton = await this.page.$('button:has-text("Continue"), button:has-text("Next")');
      if (continueButton) {
        await continueButton.click();
        await this.randomDelay(1000, 2000);
      }

      // Fill password
      await this.page.fill('input[name="password"], input[type="password"], #password', this.credentials.password);
      await this.randomDelay(500, 1000);

      // Click login/sign in button
      await this.page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")');

      // Wait for navigation to dashboard or bid board
      await this.page.waitForURL(/\/(dashboard|bid-board|projects)/, { timeout: 30000 });

      await this.screenshot('login-success');
      return true;
    } catch (error) {
      await this.screenshot('login-failed');
      console.error('BuildingConnected login failed:', error);
      return false;
    }
  }

  async scrape(): Promise<ScrapedBid[]> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call init() first.');
    }

    const scrapedBids: ScrapedBid[] = [];

    try {
      // Navigate to bid board/invitations
      await this.page.goto('https://app.buildingconnected.com/bid-board', {
        waitUntil: 'networkidle',
      });

      await this.randomDelay(2000, 3000);
      await this.screenshot('bid-board');

      // Get all bid cards/rows
      const bidElements = await this.page.$$('[data-testid="bid-row"], .bid-card, .invitation-card, .project-row');

      for (const element of bidElements) {
        try {
          const bid = await this.parseBidElement(element);
          if (bid) {
            scrapedBids.push(bid);
          }
        } catch (error) {
          console.error('Error parsing bid element:', error);
        }
      }

      // If no elements found, try alternative selectors
      if (scrapedBids.length === 0) {
        const rows = await this.page.$$('table tbody tr, .bid-list > div, [class*="BidRow"], [class*="ProjectCard"]');

        for (const row of rows) {
          try {
            const bid = await this.parseTableRow(row);
            if (bid) {
              scrapedBids.push(bid);
            }
          } catch (error) {
            console.error('Error parsing row:', error);
          }
        }
      }

      await this.screenshot('scrape-complete');
      console.log(`BuildingConnected: Found ${scrapedBids.length} bids`);

      return scrapedBids;
    } catch (error) {
      await this.screenshot('scrape-error');
      console.error('BuildingConnected scrape failed:', error);
      return scrapedBids;
    }
  }

  private async parseBidElement(element: any): Promise<ScrapedBid | null> {
    try {
      // Extract bid details
      const title = await element.$eval(
        '.project-name, [data-testid="project-name"], .bid-title, h3, h4, [class*="ProjectName"]',
        (el: any) => el.textContent?.trim()
      ).catch(() => null);

      if (!title) return null;

      const bidId = await element.getAttribute('data-bid-id') ||
        await element.getAttribute('data-project-id') ||
        await element.getAttribute('data-id') ||
        title.replace(/\W+/g, '-').toLowerCase();

      const location = await element.$eval(
        '.project-location, [data-testid="location"], .location, [class*="Location"]',
        (el: any) => el.textContent?.trim()
      ).catch(() => '');

      const dueDate = await element.$eval(
        '.due-date, [data-testid="due-date"], .deadline, [class*="DueDate"], [class*="Deadline"]',
        (el: any) => el.textContent?.trim()
      ).catch(() => '');

      const gcName = await element.$eval(
        '.gc-name, [data-testid="gc-name"], .company-name, [class*="CompanyName"]',
        (el: any) => el.textContent?.trim()
      ).catch(() => '');

      // Parse location into city/state
      let city = '';
      let state = '';
      if (location) {
        const parts = location.split(',').map((p: string) => p.trim());
        if (parts.length >= 2) {
          city = parts[0];
          state = parts[parts.length - 1].split(' ')[0];
        }
      }

      return {
        sourceBidId: bidId,
        title,
        description: gcName ? `GC: ${gcName}` : undefined,
        city,
        state,
        bidDueDate: dueDate ? this.parseDate(dueDate) : undefined,
        sourceUrl: `https://app.buildingconnected.com/bid-board/${bidId}`,
      };
    } catch (error) {
      return null;
    }
  }

  private async parseTableRow(row: any): Promise<ScrapedBid | null> {
    try {
      // Try to get text from first cell or any title-like element
      const title = await row.$eval(
        'td:first-child, .title, [class*="Title"], [class*="Name"]',
        (el: any) => el.textContent?.trim()
      ).catch(() => null);

      if (!title) return null;

      const bidId = await row.getAttribute('data-id') ||
        await row.getAttribute('data-bid-id') ||
        title.replace(/\W+/g, '-').toLowerCase();

      return {
        sourceBidId: bidId,
        title,
        sourceUrl: `https://app.buildingconnected.com/bid-board/${bidId}`,
      };
    } catch (error) {
      return null;
    }
  }

  private parseDate(dateStr: string): Date | undefined {
    try {
      // Handle common date formats like "Jan 15, 2026" or "1/15/26"
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date;
      }

      // Try to parse relative dates like "in 5 days" or "Due tomorrow"
      const lowerStr = dateStr.toLowerCase();
      if (lowerStr.includes('tomorrow')) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow;
      }
      if (lowerStr.includes('today')) {
        return new Date();
      }
      const daysMatch = lowerStr.match(/in (\d+) days?/);
      if (daysMatch) {
        const future = new Date();
        future.setDate(future.getDate() + parseInt(daysMatch[1]));
        return future;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }
}
