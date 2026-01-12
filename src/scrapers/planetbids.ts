import { BaseScraper, ScraperConfig, ScrapedBid } from './base';
import { db } from '@/db';
import { planetbidsPortals } from '@/db/schema';
import { eq } from 'drizzle-orm';

interface PlanetBidsScraperConfig extends Omit<ScraperConfig, 'platform'> {
  portalId: string;
}

/**
 * PlanetBids scraper for government/public sector bids
 *
 * PlanetBids uses a portal-based system where each agency has a unique portal ID.
 * Unlike other platforms, PlanetBids doesn't use traditional login - instead you
 * register as a vendor on each portal separately.
 */
export class PlanetBidsScraper extends BaseScraper {
  private portalId: string;

  constructor(config: PlanetBidsScraperConfig) {
    super({ ...config, platform: 'planetbids' });
    this.portalId = config.portalId;
  }

  /**
   * PlanetBids doesn't require login - it's public access with vendor registration
   * Always returns true since no authentication needed
   */
  async login(): Promise<boolean> {
    return true;
  }

  /**
   * Scrape bids from a PlanetBids portal
   */
  async scrape(): Promise<ScrapedBid[]> {
    if (!this.page) throw new Error('Scraper not initialized');

    const url = `https://pbsystem.planetbids.com/portal/${this.portalId}/bo/bo-search`;
    console.log(`Scraping PlanetBids portal ${this.portalId}...`);

    await this.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await this.screenshot(`portal-${this.portalId}`);

    // Wait for bid data to load
    try {
      await this.page.waitForSelector('text=/Found \\d+ bids/', { timeout: 15000 });
    } catch {
      console.log('No bids found or page failed to load');
      return [];
    }

    const countText = await this.page.textContent('text=/Found \\d+ bids/');
    console.log(`  ${countText}`);

    // Extract bids from table
    const rows = await this.page.$$('table tbody tr');
    const scrapedBids: ScrapedBid[] = [];

    for (const row of rows) {
      const cells = await row.$$('td');
      if (cells.length >= 7) {
        const posted = (await cells[0].textContent())?.trim() || '';
        const title = (await cells[1].textContent())?.trim() || '';
        const invitationNumber = (await cells[2].textContent())?.trim() || '';
        const dueDate = (await cells[3].textContent())?.trim() || '';
        const stage = (await cells[5].textContent())?.trim() || '';

        // Only capture open bids (stage = "Bidding")
        if (stage.toLowerCase() !== 'bidding') continue;

        // Get link to bid details
        const link = await cells[1].$('a');
        const href = link ? await link.getAttribute('href') : null;

        scrapedBids.push({
          sourceBidId: `${this.portalId}-${invitationNumber}`,
          title,
          description: `Invitation #: ${invitationNumber}`,
          bidDueDate: this.parseDate(dueDate),
          postedDate: this.parseDate(posted),
          sourceUrl: href ? `https://pbsystem.planetbids.com${href}` : undefined,
        });
      }
    }

    console.log(`  Found ${scrapedBids.length} open bids`);

    // Update last scraped timestamp
    await db
      .update(planetbidsPortals)
      .set({ lastScraped: new Date() })
      .where(eq(planetbidsPortals.portalId, this.portalId));

    return scrapedBids;
  }

  /**
   * Scrape a specific project by URL
   */
  async scrapeProjectByUrl(url: string): Promise<ScrapedBid | null> {
    if (!this.page) throw new Error('Scraper not initialized');

    try {
      await this.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await this.screenshot('project-detail');

      // Extract project details from the detail page
      const title = await this.page.$eval('h1, .bid-title', el => el.textContent?.trim() || '');
      const invitationNumber = await this.page.$eval(
        'text=/Invitation.*#/i',
        el => el.textContent?.replace(/Invitation.*#:?\s*/i, '').trim() || ''
      ).catch(() => '');

      const description = await this.page.$eval(
        '.description, .bid-description',
        el => el.textContent?.trim() || ''
      ).catch(() => '');

      const dueDate = await this.page.$eval(
        'text=/Due.*Date/i',
        el => {
          const text = el.textContent || '';
          const match = text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
          return match ? match[0] : '';
        }
      ).catch(() => '');

      // Extract portal ID from URL
      const portalMatch = url.match(/portal\/(\d+)/);
      const portalId = portalMatch ? portalMatch[1] : this.portalId;

      return {
        sourceBidId: `${portalId}-${invitationNumber || Date.now()}`,
        title,
        description,
        bidDueDate: this.parseDate(dueDate),
        sourceUrl: url,
      };
    } catch (error) {
      console.error('Error scraping project:', error);
      return null;
    }
  }

  /**
   * Parse date string to Date object
   */
  private parseDate(dateStr: string): Date | undefined {
    if (!dateStr) return undefined;

    // Handle formats like "01/15/2026" or "1/15/26"
    const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (match) {
      const [, month, day, year] = match;
      const fullYear = year.length === 2 ? `20${year}` : year;
      return new Date(`${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    }

    // Try standard Date parsing as fallback
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? undefined : parsed;
  }
}

// Known California portals for seeding
export const KNOWN_CA_PORTALS = [
  { portalId: '14319', name: 'Kern High School District' },
  { portalId: '21372', name: 'Los Angeles Community College District' },
  { portalId: '15300', name: 'City of Sacramento' },
  { portalId: '14769', name: 'City of Fresno' },
  { portalId: '47426', name: 'City of Torrance' },
  { portalId: '65093', name: 'City of Santa Fe Springs' },
  { portalId: '24103', name: 'City of National City' },
  { portalId: '16151', name: 'Los Angeles Area Agency' },
];

// Suggested ID ranges for portal discovery
export const DISCOVERY_RANGES = [
  { start: 14000, end: 15000, note: 'Early CA adopters' },
  { start: 20000, end: 25000, note: 'Mid adopters' },
  { start: 45000, end: 50000, note: 'Recent adopters' },
  { start: 60000, end: 70000, note: 'Newest adopters' },
];
