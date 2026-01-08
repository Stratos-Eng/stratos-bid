import { BaseScraper, ScraperConfig, ScrapedBid, ScrapedDocument } from './base';
import { decryptCredentials, PasswordCredentials } from '@/lib/crypto';
import { db } from '@/db';
import { connections } from '@/db/schema';
import { eq } from 'drizzle-orm';

export class PlanHubScraper extends BaseScraper {
  private credentials: PasswordCredentials | null = null;

  constructor(config: Omit<ScraperConfig, 'platform'>) {
    super({ ...config, platform: 'planhub' });
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
      // Navigate to PlanHub login page
      await this.page.goto('https://app.planhub.com/login', {
        waitUntil: 'networkidle',
      });

      await this.randomDelay(1000, 2000);

      // Fill login form
      await this.page.fill('input[name="email"], input[type="email"]', this.credentials.email);
      await this.randomDelay(500, 1000);
      await this.page.fill('input[name="password"], input[type="password"]', this.credentials.password);
      await this.randomDelay(500, 1000);

      // Click login button
      await this.page.click('button[type="submit"]');

      // Wait for navigation to dashboard
      await this.page.waitForURL('**/dashboard**', { timeout: 30000 });

      await this.screenshot('login-success');
      return true;
    } catch (error) {
      await this.screenshot('login-failed');
      console.error('PlanHub login failed:', error);
      return false;
    }
  }

  async scrape(): Promise<ScrapedBid[]> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call init() first.');
    }

    const scrapedBids: ScrapedBid[] = [];

    try {
      // Navigate to projects/invitations page
      await this.page.goto('https://app.planhub.com/projects', {
        waitUntil: 'networkidle',
      });

      await this.randomDelay(2000, 3000);
      await this.screenshot('projects-list');

      // Get all project cards/rows
      const projectElements = await this.page.$$('[data-testid="project-row"], .project-card, .project-item');

      for (const element of projectElements) {
        try {
          const bid = await this.parseProjectElement(element);
          if (bid) {
            scrapedBids.push(bid);
          }
        } catch (error) {
          console.error('Error parsing project element:', error);
        }
      }

      // If no elements found with test ids, try alternative selectors
      if (scrapedBids.length === 0) {
        // Try to scrape from table rows or list items
        const rows = await this.page.$$('table tbody tr, .project-list > div');

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
      console.log(`PlanHub: Found ${scrapedBids.length} projects`);

      return scrapedBids;
    } catch (error) {
      await this.screenshot('scrape-error');
      console.error('PlanHub scrape failed:', error);
      return scrapedBids;
    }
  }

  private async parseProjectElement(element: any): Promise<ScrapedBid | null> {
    try {
      // Extract project details from element
      const title = await element.$eval(
        '.project-title, [data-testid="project-title"], h3, h4',
        (el: any) => el.textContent?.trim()
      ).catch(() => null);

      if (!title) return null;

      const projectId = await element.getAttribute('data-project-id') ||
        await element.getAttribute('data-id') ||
        title.replace(/\W+/g, '-').toLowerCase();

      const location = await element.$eval(
        '.project-location, [data-testid="location"], .location',
        (el: any) => el.textContent?.trim()
      ).catch(() => '');

      const dueDate = await element.$eval(
        '.due-date, [data-testid="due-date"], .deadline',
        (el: any) => el.textContent?.trim()
      ).catch(() => '');

      const description = await element.$eval(
        '.project-description, [data-testid="description"], .description',
        (el: any) => el.textContent?.trim()
      ).catch(() => '');

      // Parse location into city/state
      let city = '';
      let state = '';
      if (location) {
        const parts = location.split(',').map((p: string) => p.trim());
        if (parts.length >= 2) {
          city = parts[0];
          state = parts[parts.length - 1].split(' ')[0]; // Get state abbreviation
        }
      }

      return {
        sourceBidId: projectId,
        title,
        description,
        city,
        state,
        bidDueDate: dueDate ? this.parseDate(dueDate) : undefined,
        sourceUrl: `https://app.planhub.com/projects/${projectId}`,
      };
    } catch (error) {
      return null;
    }
  }

  private async parseTableRow(row: any): Promise<ScrapedBid | null> {
    try {
      const cells = await row.$$('td');
      if (cells.length === 0) return null;

      const title = await cells[0]?.textContent?.();
      if (!title?.trim()) return null;

      const projectId = await row.getAttribute('data-id') ||
        title.replace(/\W+/g, '-').toLowerCase();

      return {
        sourceBidId: projectId,
        title: title.trim(),
        sourceUrl: `https://app.planhub.com/projects/${projectId}`,
      };
    } catch (error) {
      return null;
    }
  }

  private parseDate(dateStr: string): Date | undefined {
    try {
      // Handle common date formats
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
