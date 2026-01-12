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
      console.log('Navigating to PlanHub login...');
      await this.page.goto('https://app.planhub.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // Wait for login form to appear
      await this.page.waitForSelector('input[type="email"], input[name="email"], #email', {
        timeout: 30000,
      }).catch(() => {
        console.log('Email input not found with primary selectors, continuing...');
      });

      await this.randomDelay(1000, 2000);
      await this.screenshot('login-page');

      // Use Playwright's robust locator API for form fields
      // Try multiple approaches to find and fill the email field
      let emailFilled = false;
      const emailLocators = [
        this.page.getByLabel('Email'),
        this.page.getByPlaceholder(/email/i),
        this.page.locator('input[type="email"]'),
        this.page.locator('input').first(),
      ];

      for (const locator of emailLocators) {
        try {
          if (await locator.isVisible({ timeout: 2000 })) {
            await locator.fill(this.credentials.email);
            console.log('✓ Filled email field');
            emailFilled = true;
            break;
          }
        } catch {
          // Try next locator
        }
      }

      if (!emailFilled) {
        // Last resort: click on the form area and try to find inputs
        const inputs = await this.page.locator('form input').all();
        if (inputs.length >= 2) {
          await inputs[0].fill(this.credentials.email);
          emailFilled = true;
          console.log('✓ Filled email via form input[0]');
        }
      }

      if (!emailFilled) {
        throw new Error('Could not fill email field');
      }

      await this.randomDelay(500, 1000);

      // Fill password field
      let passwordFilled = false;
      const passwordLocators = [
        this.page.getByLabel('Password'),
        this.page.getByPlaceholder(/password/i),
        this.page.locator('input[type="password"]'),
      ];

      for (const locator of passwordLocators) {
        try {
          if (await locator.isVisible({ timeout: 2000 })) {
            await locator.fill(this.credentials.password);
            console.log('✓ Filled password field');
            passwordFilled = true;
            break;
          }
        } catch {
          // Try next locator
        }
      }

      if (!passwordFilled) {
        const inputs = await this.page.locator('form input').all();
        if (inputs.length >= 2) {
          await inputs[1].fill(this.credentials.password);
          passwordFilled = true;
          console.log('✓ Filled password via form input[1]');
        }
      }

      if (!passwordFilled) {
        throw new Error('Could not fill password field');
      }

      await this.randomDelay(500, 1000);

      // Click Sign In button
      let loginClicked = false;
      const buttonLocators = [
        this.page.getByRole('button', { name: /sign in/i }),
        this.page.locator('button:has-text("Sign In")'),
        this.page.locator('button[type="submit"]'),
        this.page.locator('form button'),
      ];

      for (const locator of buttonLocators) {
        try {
          if (await locator.isVisible({ timeout: 2000 })) {
            await locator.click();
            console.log('✓ Clicked login button');
            loginClicked = true;
            break;
          }
        } catch {
          // Try next locator
        }
      }

      if (!loginClicked) {
        throw new Error('Could not click login button');
      }

      // Wait for login to complete - check for URL change or dashboard elements
      console.log('Waiting for login redirect...');

      // Wait up to 30 seconds for navigation away from signin page
      for (let i = 0; i < 30; i++) {
        await this.randomDelay(1000, 1500);
        const currentUrl = this.page.url();

        // Check if we've left the signin page
        if (!currentUrl.includes('signin') && !currentUrl.includes('login')) {
          console.log(`✓ Redirected to: ${currentUrl}`);
          await this.screenshot('login-success');
          return true;
        }

        // Check for login error messages
        const errorEl = await this.page.$('[class*="error"], [class*="alert"], .error-message');
        if (errorEl) {
          const errorText = await errorEl.textContent();
          if (errorText && errorText.toLowerCase().includes('invalid')) {
            throw new Error(`Login failed: ${errorText}`);
          }
        }

        // Check if dashboard/main content appeared on same URL
        const mainContent = await this.page.$('[class*="dashboard"], [class*="project"], nav, header:has-text("Project")');
        if (mainContent) {
          console.log('✓ Dashboard content detected');
          await this.screenshot('login-success');
          return true;
        }
      }

      // Final check
      const finalUrl = this.page.url();
      console.log(`Final URL: ${finalUrl}`);
      await this.screenshot('login-timeout');

      if (!finalUrl.includes('signin') && !finalUrl.includes('login')) {
        return true;
      }

      throw new Error('Login redirect timed out');
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
      // After login we should be on subcontractor.planhub.com
      // Click the ITBs tab instead of navigating to a new URL
      console.log('Looking for ITBs tab...');
      const currentUrl = this.page.url();
      console.log(`Current URL: ${currentUrl}`);

      await this.screenshot('before-itbs-click');

      // Try to click on ITBs tab
      const itbsTabClicked = await this.clickTab('ITBs');

      if (!itbsTabClicked) {
        // If no tab found, try navigating (might already be logged in from cookies)
        console.log('ITBs tab not found, checking if already on leads page...');

        if (!currentUrl.includes('leads/list')) {
          // Navigate to leads page
          await this.page.goto('https://subcontractor.planhub.com/leads/list', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
          });
          await this.randomDelay(2000, 3000);

          // Try clicking ITBs tab again
          await this.clickTab('ITBs');
        }
      }

      await this.randomDelay(3000, 5000);
      await this.screenshot('itbs-list');

      // Wait for the project list to load
      await this.page.waitForSelector('[class*="project"], [class*="lead"], [class*="card"], table tbody tr', {
        timeout: 30000,
      }).catch(() => console.log('Project list selector not found, continuing...'));

      // Try multiple selectors for project items
      const projectSelectors = [
        '[data-testid*="project"]',
        '[class*="ProjectCard"]',
        '[class*="LeadCard"]',
        'table tbody tr',
        '.project-item',
        '.lead-item',
      ];

      for (const selector of projectSelectors) {
        const elements = await this.page.$$(selector);
        if (elements.length > 0) {
          console.log(`Found ${elements.length} projects with selector: ${selector}`);

          for (const element of elements.slice(0, 50)) { // Limit to 50 projects
            try {
              const bid = await this.parseProjectCard(element);
              if (bid) {
                scrapedBids.push(bid);
              }
            } catch (error) {
              console.error('Error parsing project:', error);
            }
          }
          break;
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

  /**
   * Parse a project card from the ITBs list
   */
  private async parseProjectCard(element: any): Promise<ScrapedBid | null> {
    try {
      // Try to get the project title
      const titleEl = await element.$('h3, h4, [class*="title"], [class*="name"], a');
      const title = titleEl ? await titleEl.textContent() : null;

      if (!title?.trim()) return null;

      // Try to get project URL
      const linkEl = await element.$('a[href*="project"], a[href*="lead"]');
      const href = linkEl ? await linkEl.getAttribute('href') : null;

      // Try to get location
      const locationEl = await element.$('[class*="location"], [class*="address"]');
      const location = locationEl ? await locationEl.textContent() : '';

      // Try to get due date
      const dateEl = await element.$('[class*="date"], [class*="deadline"], [class*="due"]');
      const dateText = dateEl ? await dateEl.textContent() : '';

      // Try to get GC name
      const gcEl = await element.$('[class*="company"], [class*="gc"], [class*="contractor"]');
      const gcName = gcEl ? await gcEl.textContent() : '';

      // Parse location
      let city = '';
      let state = '';
      if (location) {
        const parts = location.trim().split(',').map((p: string) => p.trim());
        if (parts.length >= 2) {
          city = parts[0];
          state = parts[parts.length - 1].split(' ')[0];
        }
      }

      // Generate project ID from URL or title
      const projectId = href?.match(/\/([^/]+)$/)?.[1] ||
        title.trim().replace(/\W+/g, '-').toLowerCase().substring(0, 50);

      return {
        sourceBidId: projectId,
        title: title.trim(),
        description: gcName ? `GC: ${gcName.trim()}` : undefined,
        city,
        state,
        projectAddress: location?.trim(),
        bidDueDate: dateText ? this.parseDate(dateText) : undefined,
        sourceUrl: href ? `https://subcontractor.planhub.com${href}` : undefined,
      };
    } catch (error) {
      return null;
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

  /**
   * Click on a tab by name (ITBs, All Projects, Connections, etc.)
   */
  private async clickTab(tabName: string): Promise<boolean> {
    if (!this.page) return false;

    const tabSelectors = [
      `button:has-text("${tabName}")`,
      `a:has-text("${tabName}")`,
      `[role="tab"]:has-text("${tabName}")`,
      `div:has-text("${tabName}"):not(:has(*))`, // Text-only divs
    ];

    for (const selector of tabSelectors) {
      try {
        const tab = this.page.locator(selector).first();
        if (await tab.isVisible({ timeout: 2000 })) {
          await tab.click();
          console.log(`✓ Clicked "${tabName}" tab`);
          await this.randomDelay(2000, 3000);
          return true;
        }
      } catch {
        // Try next selector
      }
    }

    console.log(`✗ Could not find "${tabName}" tab`);
    return false;
  }

  /**
   * Scrape a single project by URL (deep fetch from email link)
   */
  async scrapeProjectByUrl(url: string): Promise<ScrapedBid | null> {
    if (!this.page) {
      throw new Error('Browser not initialized. Call init() first.');
    }

    try {
      console.log(`PlanHub: Deep fetching project from ${url}`);

      // PlanHub tracking URLs redirect, so use longer timeout
      await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // Wait for the page to settle after redirect
      await this.randomDelay(2000, 3000);
      await this.screenshot('project-detail');

      // Check if we're on a project page
      const currentUrl = this.page.url();
      console.log(`  Navigated to: ${currentUrl}`);

      // Extract project ID from URL
      const urlMatch = url.match(/projects?\/([^/?]+)/);
      const projectId = urlMatch?.[1] || url;

      // Scrape project details from the detail page
      // These selectors will fall back to Claude agent if they fail
      const title = await this.page.$eval(
        'h1, [data-testid="project-title"], .project-title, .project-header h1',
        (el: Element) => el.textContent?.trim()
      ).catch(() => null);

      if (!title) {
        console.log('Could not find project title, asking Claude for help');
        // Use agent fallback for complex page analysis
        const { askClaudeForHelp } = await import('@/lib/browser-agent');
        const action = await askClaudeForHelp(
          this.page,
          'Extract the project title from this page',
          'Looking at a PlanHub project detail page'
        );
        if (action.type === 'fail') {
          return null;
        }
      }

      const description = await this.page.$eval(
        '[data-testid="project-description"], .project-description, .description, .project-details',
        (el: Element) => el.textContent?.trim()
      ).catch(() => '');

      const location = await this.page.$eval(
        '[data-testid="project-location"], .project-location, .location, .address',
        (el: Element) => el.textContent?.trim()
      ).catch(() => '');

      const dueDate = await this.page.$eval(
        '[data-testid="due-date"], .due-date, .deadline, .bid-due',
        (el: Element) => el.textContent?.trim()
      ).catch(() => '');

      const gcName = await this.page.$eval(
        '[data-testid="gc-name"], .gc-name, .general-contractor, .company-name',
        (el: Element) => el.textContent?.trim()
      ).catch(() => '');

      // Parse location
      let city = '';
      let state = '';
      if (location) {
        const parts = location.split(',').map((p: string) => p.trim());
        if (parts.length >= 2) {
          city = parts[0];
          state = parts[parts.length - 1].split(' ')[0];
        }
      }

      // Get document list
      const documents = await this.scrapeDocumentList();

      const bid: ScrapedBid = {
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

      console.log(`PlanHub: Scraped project "${bid.title}" with ${documents.length} documents`);
      return bid;
    } catch (error) {
      console.error('PlanHub scrapeProjectByUrl failed:', error);
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
      // Look for document/file sections
      const docElements = await this.page.$$(
        '[data-testid="document"], .document-item, .file-item, .attachment, tr[data-file-id]'
      );

      for (const el of docElements) {
        try {
          const filename = await el.$eval(
            '.filename, .file-name, .document-name, a',
            (e: Element) => e.textContent?.trim()
          ).catch(() => '');

          const downloadUrl = await el.$eval(
            'a[href*="download"], a[href*=".pdf"], a[download]',
            (e: Element) => (e as HTMLAnchorElement).href
          ).catch(() => '');

          if (filename && downloadUrl) {
            // Detect document type from filename
            let docType: 'plans' | 'specs' | 'addendum' | 'other' = 'other';
            const lowerName = filename.toLowerCase();
            if (lowerName.includes('plan') || lowerName.includes('drawing')) {
              docType = 'plans';
            } else if (lowerName.includes('spec')) {
              docType = 'specs';
            } else if (lowerName.includes('addendum') || lowerName.includes('addenda')) {
              docType = 'addendum';
            }

            documents.push({
              filename,
              downloadUrl,
              docType,
            });
          }
        } catch {
          // Skip this document
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

        // Set up download handling
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 30000 }),
          this.page.goto(doc.downloadUrl),
        ]);

        // Save to docs folder
        const savePath = `docs/${this.config.platform}/${bid.sourceBidId}/${doc.filename}`;
        await download.saveAs(savePath);

        downloadedDocs.push({
          ...doc,
          downloadUrl: savePath, // Update to local path
        });

        await this.randomDelay(500, 1000);
      } catch (error) {
        console.error(`Failed to download ${doc.filename}:`, error);
      }
    }

    return downloadedDocs;
  }
}
