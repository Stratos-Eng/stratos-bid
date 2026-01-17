import { BaseScraper, ScraperConfig, ScrapedBid, ScrapedDocument } from './base';
import { decryptCredentials, PasswordCredentials } from '@/lib/crypto';
import { db } from '@/db';
import { connections } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * BuildingConnected Scraper
 *
 * BuildingConnected (part of Autodesk Construction Cloud) is a platform where
 * GCs invite subcontractors to bid on projects. The main interface is the "Bid Board"
 * which shows all bid invitations.
 *
 * Key UI elements:
 * - Login: app.buildingconnected.com/login (may redirect to Autodesk ID)
 * - Bid Board: Accessed via clipboard icon in left sidebar
 * - Projects appear as cards/rows with project name, GC, due date, location
 * - Side panel shows project details when clicked
 */
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
      console.log('Navigating to BuildingConnected login...');
      await this.page.goto('https://app.buildingconnected.com/login', {
        waitUntil: 'networkidle',
        timeout: 60000,
      });

      await this.randomDelay(1000, 2000);
      await this.screenshot('login-page');

      // Check if we're already logged in (redirected to dashboard)
      const currentUrl = this.page.url();
      if (currentUrl.includes('/bid-board') || currentUrl.includes('/dashboard') || currentUrl.includes('/projects')) {
        console.log('Already logged in via session cookies');
        return true;
      }

      // Check if redirected to Autodesk ID login
      if (currentUrl.includes('autodesk.com') || currentUrl.includes('accounts.autodesk')) {
        console.log('Redirected to Autodesk ID login');
        return await this.handleAutodeskLogin();
      }

      // Standard BuildingConnected login form
      return await this.handleStandardLogin();
    } catch (error) {
      await this.screenshot('login-failed');
      console.error('BuildingConnected login failed:', error);
      return false;
    }
  }

  /**
   * Handle standard BuildingConnected login form
   */
  private async handleStandardLogin(): Promise<boolean> {
    if (!this.page || !this.credentials) return false;

    try {
      // Wait for email field
      await this.page.waitForSelector('input[type="email"], input[name="email"], #email, input[placeholder*="email" i]', {
        timeout: 10000,
      });

      // Fill email using multiple strategies
      const emailFilled = await this.fillField(
        ['input[type="email"]', 'input[name="email"]', '#email', 'input[placeholder*="email" i]'],
        this.credentials.email
      );

      if (!emailFilled) {
        throw new Error('Could not fill email field');
      }

      await this.randomDelay(500, 1000);

      // Check for "Continue" button (two-step login flow)
      const continueButton = await this.page.$(
        'button:has-text("Continue"), button:has-text("Next"), button[type="submit"]:has-text("Continue")'
      );
      if (continueButton) {
        await continueButton.click();
        await this.randomDelay(1500, 2500);
        await this.screenshot('after-continue');
      }

      // Fill password
      const passwordFilled = await this.fillField(
        ['input[type="password"]', 'input[name="password"]', '#password'],
        this.credentials.password
      );

      if (!passwordFilled) {
        throw new Error('Could not fill password field');
      }

      await this.randomDelay(500, 1000);

      // Click sign in button
      const signInClicked = await this.clickButton([
        'button[type="submit"]',
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'button:has-text("Sign In")',
        'button:has-text("Login")',
      ]);

      if (!signInClicked) {
        throw new Error('Could not click sign in button');
      }

      // Wait for navigation to dashboard or bid board
      return await this.waitForSuccessfulLogin();
    } catch (error) {
      console.error('Standard login failed:', error);
      return false;
    }
  }

  /**
   * Handle Autodesk ID (SSO) login
   */
  private async handleAutodeskLogin(): Promise<boolean> {
    if (!this.page || !this.credentials) return false;

    try {
      await this.screenshot('autodesk-login');

      // Autodesk login typically has username/email field first
      await this.page.waitForSelector('input[name="userName"], input[type="email"], #userName', {
        timeout: 15000,
      });

      // Fill email/username
      const emailFilled = await this.fillField(
        ['input[name="userName"]', 'input[type="email"]', '#userName', 'input[id*="email"]'],
        this.credentials.email
      );

      if (!emailFilled) {
        throw new Error('Could not fill Autodesk email field');
      }

      await this.randomDelay(500, 1000);

      // Click Next/Continue
      await this.clickButton([
        'button[type="submit"]',
        'button:has-text("Next")',
        'button:has-text("Continue")',
        '#verify_user_btn',
      ]);

      await this.randomDelay(2000, 3000);
      await this.screenshot('autodesk-password');

      // Fill password
      const passwordFilled = await this.fillField(
        ['input[type="password"]', 'input[name="password"]', '#password'],
        this.credentials.password
      );

      if (!passwordFilled) {
        throw new Error('Could not fill Autodesk password field');
      }

      await this.randomDelay(500, 1000);

      // Click Sign In
      await this.clickButton([
        'button[type="submit"]',
        'button:has-text("Sign in")',
        '#btnSubmit',
      ]);

      return await this.waitForSuccessfulLogin();
    } catch (error) {
      console.error('Autodesk login failed:', error);
      return false;
    }
  }

  /**
   * Wait for successful login and navigation to app
   */
  private async waitForSuccessfulLogin(): Promise<boolean> {
    if (!this.page) return false;

    // Wait up to 45 seconds for login to complete
    for (let i = 0; i < 45; i++) {
      await this.randomDelay(1000, 1500);
      const currentUrl = this.page.url();

      // Check for successful navigation
      if (
        currentUrl.includes('app.buildingconnected.com') &&
        !currentUrl.includes('/login') &&
        !currentUrl.includes('autodesk.com')
      ) {
        console.log(`Login successful, redirected to: ${currentUrl}`);
        await this.screenshot('login-success');
        return true;
      }

      // Check for error messages
      const errorEl = await this.page.$('[class*="error"], [class*="alert-danger"], [role="alert"]');
      if (errorEl) {
        const errorText = await errorEl.textContent();
        if (errorText?.toLowerCase().includes('invalid') || errorText?.toLowerCase().includes('incorrect')) {
          throw new Error(`Login failed: ${errorText}`);
        }
      }

      // Check for MFA/2FA prompt
      const mfaPrompt = await this.page.$('input[name="code"], input[placeholder*="code" i], [class*="mfa"]');
      if (mfaPrompt) {
        console.error('MFA/2FA required - not supported in automated login');
        await this.screenshot('mfa-required');
        throw new Error('MFA/2FA required');
      }
    }

    await this.screenshot('login-timeout');
    throw new Error('Login timed out');
  }

  /**
   * Fill a form field trying multiple selectors
   */
  private async fillField(selectors: string[], value: string): Promise<boolean> {
    if (!this.page) return false;

    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          await element.fill(value);
          console.log(`Filled field with selector: ${selector}`);
          return true;
        }
      } catch {
        // Try next selector
      }
    }
    return false;
  }

  /**
   * Click a button trying multiple selectors
   */
  private async clickButton(selectors: string[]): Promise<boolean> {
    if (!this.page) return false;

    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          await element.click();
          console.log(`Clicked button with selector: ${selector}`);
          return true;
        }
      } catch {
        // Try next selector
      }
    }
    return false;
  }

  async scrape(): Promise<ScrapedBid[]> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call init() first.');
    }

    const scrapedBids: ScrapedBid[] = [];

    try {
      // Navigate to Bid Board
      console.log('Navigating to Bid Board...');

      // Try clicking the clipboard/Bid Board icon in the sidebar
      const bidBoardClicked = await this.navigateToBidBoard();

      if (!bidBoardClicked) {
        // Direct navigation fallback
        await this.page.goto('https://app.buildingconnected.com/bid-board', {
          waitUntil: 'networkidle',
          timeout: 30000,
        });
      }

      await this.randomDelay(2000, 3000);
      await this.screenshot('bid-board');

      // Wait for content to load
      await this.page.waitForSelector(
        '[data-testid*="project"], [data-testid*="bid"], [class*="ProjectCard"], [class*="BidCard"], table tbody tr, .project-row',
        { timeout: 15000 }
      ).catch(() => console.log('Bid list selector not found, trying alternatives...'));

      // Try multiple approaches to find bids
      const bids = await this.extractBidsFromPage();
      scrapedBids.push(...bids);

      // Handle pagination if present
      let hasNextPage = true;
      let pageNum = 1;
      const maxPages = 10;

      while (hasNextPage && pageNum < maxPages) {
        const nextButton = await this.page.$(
          'button[aria-label="Next page"], button:has-text("Next"), [class*="pagination"] button:last-child:not([disabled])'
        );

        if (nextButton && await nextButton.isEnabled()) {
          await nextButton.click();
          await this.randomDelay(2000, 3000);
          pageNum++;

          const pageBids = await this.extractBidsFromPage();
          if (pageBids.length === 0) {
            hasNextPage = false;
          } else {
            scrapedBids.push(...pageBids);
          }
        } else {
          hasNextPage = false;
        }
      }

      await this.screenshot('scrape-complete');
      console.log(`BuildingConnected: Found ${scrapedBids.length} bids across ${pageNum} pages`);

      return scrapedBids;
    } catch (error) {
      await this.screenshot('scrape-error');
      console.error('BuildingConnected scrape failed:', error);
      return scrapedBids;
    }
  }

  /**
   * Navigate to Bid Board via sidebar icon
   */
  private async navigateToBidBoard(): Promise<boolean> {
    if (!this.page) return false;

    // Selectors for the Bid Board icon in the sidebar
    const bidBoardSelectors = [
      '[aria-label="Bid Board"]',
      '[data-testid="bid-board-nav"]',
      'nav a[href*="bid-board"]',
      'a[href*="bid-board"]',
      '[class*="sidebar"] [class*="clipboard"]',
      '[class*="nav"] [class*="BidBoard"]',
      'button[title*="Bid Board"]',
      // Clipboard icon (commonly used for bid board)
      'svg[class*="clipboard"]',
    ];

    for (const selector of bidBoardSelectors) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          await element.click();
          await this.randomDelay(1500, 2500);
          console.log(`Clicked Bid Board via: ${selector}`);
          return true;
        }
      } catch {
        // Try next selector
      }
    }

    return false;
  }

  /**
   * Extract bids from the current page
   */
  private async extractBidsFromPage(): Promise<ScrapedBid[]> {
    if (!this.page) return [];

    const bids: ScrapedBid[] = [];

    // Try multiple selectors for bid elements
    const bidSelectors = [
      '[data-testid*="project-row"]',
      '[data-testid*="bid-row"]',
      '[class*="ProjectCard"]',
      '[class*="BidCard"]',
      '[class*="project-card"]',
      '[class*="bid-card"]',
      'table tbody tr',
      '.bid-row',
      '.project-row',
      '[class*="InvitationRow"]',
      '[class*="invitation-row"]',
    ];

    for (const selector of bidSelectors) {
      const elements = await this.page.$$(selector);
      if (elements.length > 0) {
        console.log(`Found ${elements.length} bid elements with selector: ${selector}`);

        for (const element of elements.slice(0, 100)) { // Limit to 100 per page
          try {
            const bid = await this.parseBidElement(element);
            if (bid) {
              bids.push(bid);
            }
          } catch (error) {
            console.error('Error parsing bid element:', error);
          }
        }
        break; // Found bids, no need to try other selectors
      }
    }

    return bids;
  }

  /**
   * Parse a bid element to extract bid details
   */
  private async parseBidElement(element: any): Promise<ScrapedBid | null> {
    try {
      // Try to get project title
      const titleSelectors = [
        '[class*="project-name"]',
        '[class*="ProjectName"]',
        '[data-testid*="project-name"]',
        '[class*="title"]',
        'h3', 'h4',
        'a[href*="project"]',
        'td:first-child',
      ];

      let title: string | null = null;
      for (const selector of titleSelectors) {
        try {
          const el = await element.$(selector);
          if (el) {
            title = await el.textContent();
            if (title?.trim()) break;
          }
        } catch {
          // Try next
        }
      }

      if (!title?.trim()) return null;
      title = title.trim();

      // Get bid/project ID from data attributes or URL
      let bidId = await element.getAttribute('data-project-id') ||
        await element.getAttribute('data-bid-id') ||
        await element.getAttribute('data-id');

      if (!bidId) {
        // Try to extract from link href
        const link = await element.$('a[href*="project"], a[href*="bid"]');
        if (link) {
          const href = await link.getAttribute('href');
          const match = href?.match(/(?:project|bid)[s]?\/([a-zA-Z0-9-]+)/);
          bidId = match?.[1];
        }
      }

      if (!bidId) {
        // Generate ID from title
        bidId = title.replace(/\W+/g, '-').toLowerCase().substring(0, 50);
      }

      // Get GC/company name
      const gcSelectors = [
        '[class*="company"]',
        '[class*="gc-name"]',
        '[class*="GcName"]',
        '[data-testid*="company"]',
        '[class*="contractor"]',
      ];

      let gcName = '';
      for (const selector of gcSelectors) {
        try {
          const el = await element.$(selector);
          if (el) {
            gcName = await el.textContent() || '';
            if (gcName.trim()) break;
          }
        } catch {
          // Try next
        }
      }

      // Get location
      const locationSelectors = [
        '[class*="location"]',
        '[class*="Location"]',
        '[data-testid*="location"]',
        '[class*="address"]',
      ];

      let location = '';
      for (const selector of locationSelectors) {
        try {
          const el = await element.$(selector);
          if (el) {
            location = await el.textContent() || '';
            if (location.trim()) break;
          }
        } catch {
          // Try next
        }
      }

      // Parse location into city/state
      let city = '';
      let state = '';
      if (location) {
        const parts = location.trim().split(',').map(p => p.trim());
        if (parts.length >= 2) {
          city = parts[0];
          // State is usually the last part, possibly with zip
          const lastPart = parts[parts.length - 1];
          const stateMatch = lastPart.match(/([A-Z]{2})/);
          state = stateMatch?.[1] || '';
        }
      }

      // Get due date
      const dateSelectors = [
        '[class*="due-date"]',
        '[class*="DueDate"]',
        '[data-testid*="due-date"]',
        '[class*="deadline"]',
        '[class*="Deadline"]',
        'time',
      ];

      let dueDate = '';
      for (const selector of dateSelectors) {
        try {
          const el = await element.$(selector);
          if (el) {
            dueDate = await el.textContent() || '';
            if (dueDate.trim()) break;
          }
        } catch {
          // Try next
        }
      }

      // Get project URL
      let sourceUrl = `https://app.buildingconnected.com/projects/${bidId}`;
      const projectLink = await element.$('a[href*="project"]');
      if (projectLink) {
        const href = await projectLink.getAttribute('href');
        if (href) {
          sourceUrl = href.startsWith('http') ? href : `https://app.buildingconnected.com${href}`;
        }
      }

      return {
        sourceBidId: bidId,
        title,
        description: gcName ? `GC: ${gcName.trim()}` : undefined,
        city,
        state,
        projectAddress: location?.trim() || undefined,
        bidDueDate: dueDate ? this.parseDate(dueDate) : undefined,
        sourceUrl,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Parse date string to Date object
   */
  private parseDate(dateStr: string): Date | undefined {
    try {
      const cleanStr = dateStr.trim();

      // Try standard date parsing first
      const date = new Date(cleanStr);
      if (!isNaN(date.getTime())) {
        return date;
      }

      // Handle relative dates
      const lowerStr = cleanStr.toLowerCase();
      const now = new Date();

      if (lowerStr.includes('today')) {
        return now;
      }

      if (lowerStr.includes('tomorrow')) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow;
      }

      // "in X days"
      const daysMatch = lowerStr.match(/in\s+(\d+)\s*days?/);
      if (daysMatch) {
        const future = new Date(now);
        future.setDate(future.getDate() + parseInt(daysMatch[1]));
        return future;
      }

      // "X days left"
      const daysLeftMatch = lowerStr.match(/(\d+)\s*days?\s*left/);
      if (daysLeftMatch) {
        const future = new Date(now);
        future.setDate(future.getDate() + parseInt(daysLeftMatch[1]));
        return future;
      }

      // Try parsing formats like "Jan 15" or "1/15/26"
      const monthDayMatch = cleanStr.match(/([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?/);
      if (monthDayMatch) {
        const [, month, day, year] = monthDayMatch;
        const yearNum = year ? parseInt(year) : now.getFullYear();
        const parsed = new Date(`${month} ${day}, ${yearNum}`);
        if (!isNaN(parsed.getTime())) {
          return parsed;
        }
      }

      // MM/DD/YY or MM/DD/YYYY
      const slashDateMatch = cleanStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (slashDateMatch) {
        const [, month, day, year] = slashDateMatch;
        const fullYear = year.length === 2 ? `20${year}` : year;
        return new Date(`${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Scrape a single project by URL
   */
  async scrapeProjectByUrl(url: string): Promise<ScrapedBid | null> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call init() first.');
    }

    try {
      console.log(`BuildingConnected: Fetching project from ${url}`);

      await this.page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      await this.randomDelay(2000, 3000);
      await this.screenshot('project-detail');

      // Extract project ID from URL
      const urlMatch = url.match(/(?:project|bid)[s]?\/([a-zA-Z0-9-]+)/);
      const projectId = urlMatch?.[1] || url;

      // Scrape project details
      const title = await this.page.$eval(
        'h1, [data-testid*="project-name"], [class*="ProjectName"], [class*="project-title"]',
        (el: Element) => el.textContent?.trim()
      ).catch(() => 'Unknown Project');

      const description = await this.page.$eval(
        '[class*="description"], [data-testid*="description"], [class*="scope"]',
        (el: Element) => el.textContent?.trim()
      ).catch(() => '');

      const gcName = await this.page.$eval(
        '[class*="gc-name"], [class*="company-name"], [data-testid*="gc"], [class*="contractor"]',
        (el: Element) => el.textContent?.trim()
      ).catch(() => '');

      const location = await this.page.$eval(
        '[class*="location"], [class*="address"], [data-testid*="location"]',
        (el: Element) => el.textContent?.trim()
      ).catch(() => '');

      const dueDate = await this.page.$eval(
        '[class*="due-date"], [class*="deadline"], [data-testid*="due-date"], time',
        (el: Element) => el.textContent?.trim()
      ).catch(() => '');

      // Parse location
      let city = '';
      let state = '';
      if (location) {
        const parts = location.split(',').map(p => p.trim());
        if (parts.length >= 2) {
          city = parts[0];
          const stateMatch = parts[parts.length - 1].match(/([A-Z]{2})/);
          state = stateMatch?.[1] || '';
        }
      }

      // Get documents if available
      const documents = await this.scrapeDocumentList();

      return {
        sourceBidId: projectId,
        title: title || 'Unknown Project',
        description: gcName ? `GC: ${gcName}\n${description}` : description,
        city,
        state,
        projectAddress: location,
        bidDueDate: dueDate ? this.parseDate(dueDate) : undefined,
        sourceUrl: url,
        documents,
      };
    } catch (error) {
      console.error('BuildingConnected scrapeProjectByUrl failed:', error);
      await this.screenshot('project-detail-error');
      return null;
    }
  }

  /**
   * Scrape document list from current project page
   */
  private async scrapeDocumentList(): Promise<ScrapedDocument[]> {
    if (!this.page) return [];

    const documents: ScrapedDocument[] = [];

    try {
      // Click on Files/Documents tab if present
      const filesTab = await this.page.$(
        'button:has-text("Files"), button:has-text("Documents"), [data-testid*="files-tab"], a:has-text("Files")'
      );
      if (filesTab) {
        await filesTab.click();
        await this.randomDelay(1000, 2000);
      }

      // Find document elements
      const docSelectors = [
        '[data-testid*="file"]',
        '[class*="FileRow"]',
        '[class*="file-row"]',
        '[class*="document-item"]',
        'table[class*="files"] tbody tr',
      ];

      for (const selector of docSelectors) {
        const elements = await this.page.$$(selector);
        if (elements.length > 0) {
          for (const el of elements) {
            try {
              const filename = await el.$eval(
                '[class*="filename"], [class*="name"], a, td:first-child',
                (e: Element) => e.textContent?.trim()
              ).catch(() => '');

              const downloadUrl = await el.$eval(
                'a[href*="download"], a[download], a[href*=".pdf"]',
                (e: Element) => (e as HTMLAnchorElement).href
              ).catch(() => '');

              if (filename && downloadUrl) {
                // Detect document type
                let docType: 'plans' | 'specs' | 'addendum' | 'other' = 'other';
                const lowerName = filename.toLowerCase();
                if (lowerName.includes('plan') || lowerName.includes('drawing') || lowerName.includes('sheet')) {
                  docType = 'plans';
                } else if (lowerName.includes('spec')) {
                  docType = 'specs';
                } else if (lowerName.includes('addendum') || lowerName.includes('addenda')) {
                  docType = 'addendum';
                }

                documents.push({ filename, downloadUrl, docType });
              }
            } catch {
              // Skip this document
            }
          }
          break;
        }
      }
    } catch (error) {
      console.error('Error scraping document list:', error);
    }

    return documents;
  }

  /**
   * Download documents for a bid
   */
  async downloadDocuments(bid: ScrapedBid): Promise<ScrapedDocument[]> {
    if (!this.page || !bid.documents?.length) {
      return [];
    }

    const downloadedDocs: ScrapedDocument[] = [];

    for (const doc of bid.documents) {
      try {
        console.log(`Downloading: ${doc.filename}`);

        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 30000 }),
          this.page.goto(doc.downloadUrl),
        ]);

        const savePath = `docs/${this.config.platform}/${bid.sourceBidId}/${doc.filename}`;
        await download.saveAs(savePath);

        downloadedDocs.push({
          ...doc,
          downloadUrl: savePath,
        });

        await this.randomDelay(500, 1000);
      } catch (error) {
        console.error(`Failed to download ${doc.filename}:`, error);
      }
    }

    return downloadedDocs;
  }
}
