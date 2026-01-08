# Stratos Bid Aggregator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a hosted SaaS that aggregates construction bid opportunities from Gmail, PlanHub, BuildingConnected, and PlanetBids into a unified dashboard for specialty trade subcontractors.

**Architecture:** Next.js 14 monolith with Inngest background jobs. Users connect accounts via OAuth (Gmail) or stored credentials (PlanHub/BC). Playwright automates login and scraping. Documents stored in Supabase Storage, analyzed for trade relevance.

**Tech Stack:** Next.js 14, Postgres (Supabase), Drizzle ORM, NextAuth.js, Inngest, Playwright, Supabase Storage

---

## Phase 1: Foundation

### Task 1.1: Initialize Next.js App

**Files:**
- Create: `package.json` (replace existing)
- Create: `next.config.js`
- Create: `tsconfig.json` (replace existing)
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`

**Step 1: Initialize Next.js with dependencies**

```bash
cd /Users/hamza/stratos/stratos-bid
rm -rf node_modules package-lock.json
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-git
```

When prompted, accept defaults.

**Step 2: Install additional dependencies**

```bash
npm install drizzle-orm @neondatabase/serverless dotenv next-auth@beta @auth/drizzle-adapter inngest playwright pdf-parse
npm install -D drizzle-kit @types/pdf-parse
```

**Step 3: Verify app runs**

```bash
npm run dev
```

Open http://localhost:3000 - should see Next.js welcome page.

**Step 4: Commit**

```bash
git init
git add .
git commit -m "feat: initialize Next.js 14 app with dependencies"
```

---

### Task 1.2: Set Up Database Schema with Drizzle

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/index.ts`
- Create: `drizzle.config.ts`
- Create: `.env.local`

**Step 1: Create environment file**

Create `.env.local`:
```env
DATABASE_URL=postgresql://user:pass@host/db
ENCRYPTION_KEY=generate-32-byte-hex-key-here
NEXTAUTH_SECRET=generate-secret-here
NEXTAUTH_URL=http://localhost:3000

GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

**Step 2: Create Drizzle config**

Create `drizzle.config.ts`:
```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

**Step 3: Create database schema**

Create `src/db/schema.ts`:
```typescript
import { pgTable, text, timestamp, uuid, real, jsonb, integer } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  refresh_token: text('refresh_token'),
  access_token: text('access_token'),
  expires_at: integer('expires_at'),
  token_type: text('token_type'),
  scope: text('scope'),
  id_token: text('id_token'),
  session_state: text('session_state'),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionToken: text('session_token').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires').notNull(),
});

export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(), // 'gmail' | 'planhub' | 'buildingconnected' | 'planetbids'
  authType: text('auth_type').notNull(), // 'oauth' | 'password' | 'api_key'
  credentials: text('credentials'), // encrypted JSON
  status: text('status').notNull().default('active'), // 'active' | 'error' | 'needs_reauth'
  lastSynced: timestamp('last_synced'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const bids = pgTable('bids', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => connections.id),
  sourcePlatform: text('source_platform').notNull(),
  sourceBidId: text('source_bid_id').notNull(),

  title: text('title').notNull(),
  description: text('description'),
  projectAddress: text('project_address'),
  city: text('city'),
  state: text('state'),

  bidDueDate: timestamp('bid_due_date'),
  postedDate: timestamp('posted_date'),
  invitedDate: timestamp('invited_date'),

  status: text('status').notNull().default('new'), // 'new' | 'reviewing' | 'bidding' | 'passed' | 'won' | 'lost'
  relevanceScore: real('relevance_score').default(0),
  relevanceReasons: jsonb('relevance_reasons'),

  sourceUrl: text('source_url'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  bidId: uuid('bid_id').notNull().references(() => bids.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  docType: text('doc_type'), // 'plans' | 'specs' | 'addendum' | 'other'
  storagePath: text('storage_path'),
  extractedText: text('extracted_text'),
  relevanceScore: real('relevance_score').default(0),
  pageCount: integer('page_count'),
  downloadedAt: timestamp('downloaded_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const syncJobs = pgTable('sync_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => connections.id),
  status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'completed' | 'failed'
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  errorMessage: text('error_message'),
  bidsFound: integer('bids_found'),
  docsDownloaded: integer('docs_downloaded'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

**Step 4: Create database client**

Create `src/db/index.ts`:
```typescript
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });

export * from './schema';
```

**Step 5: Generate and run migrations**

```bash
npx drizzle-kit generate
npx drizzle-kit push
```

**Step 6: Commit**

```bash
git add .
git commit -m "feat: add database schema with Drizzle"
```

---

### Task 1.3: Set Up NextAuth with Google OAuth

**Files:**
- Create: `src/app/api/auth/[...nextauth]/route.ts`
- Create: `src/lib/auth.ts`
- Modify: `src/app/layout.tsx`

**Step 1: Create auth configuration**

Create `src/lib/auth.ts`:
```typescript
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db } from '@/db';

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: DrizzleAdapter(db),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
});
```

**Step 2: Create auth route**

Create `src/app/api/auth/[...nextauth]/route.ts`:
```typescript
import { handlers } from '@/lib/auth';

export const { GET, POST } = handlers;
```

**Step 3: Create session provider**

Create `src/components/providers.tsx`:
```typescript
'use client';

import { SessionProvider } from 'next-auth/react';

export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
```

**Step 4: Update layout**

Replace `src/app/layout.tsx`:
```typescript
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Stratos Bid',
  description: 'Bid aggregation for specialty trades',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

**Step 5: Test auth flow**

```bash
npm run dev
```

Visit http://localhost:3000/api/auth/signin - should see Google sign-in option.

**Step 6: Commit**

```bash
git add .
git commit -m "feat: add NextAuth with Google OAuth"
```

---

### Task 1.4: Create Credential Encryption Utilities

**Files:**
- Create: `src/lib/encryption.ts`
- Create: `src/lib/encryption.test.ts`

**Step 1: Create encryption module**

Create `src/lib/encryption.ts`:
```typescript
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(key, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const [ivHex, authTagHex, encrypted] = ciphertext.split(':');

  if (!ivHex || !authTagHex || !encrypted) {
    throw new Error('Invalid ciphertext format');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

export function encryptCredentials(credentials: object): string {
  return encrypt(JSON.stringify(credentials));
}

export function decryptCredentials<T>(ciphertext: string): T {
  return JSON.parse(decrypt(ciphertext));
}
```

**Step 2: Test encryption (manual)**

Create a quick test script `scripts/test-encryption.ts`:
```typescript
import { encryptCredentials, decryptCredentials } from '../src/lib/encryption';

const creds = { email: 'test@example.com', password: 'secret123' };
const encrypted = encryptCredentials(creds);
console.log('Encrypted:', encrypted);

const decrypted = decryptCredentials(encrypted);
console.log('Decrypted:', decrypted);
console.log('Match:', JSON.stringify(creds) === JSON.stringify(decrypted));
```

Run:
```bash
npx tsx scripts/test-encryption.ts
```

Expected: `Match: true`

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add credential encryption utilities"
```

---

## Phase 2: Platform Integrations

### Task 2.1: Create Base Scraper Class

**Files:**
- Create: `src/lib/scrapers/base.ts`

**Step 1: Create base scraper**

Create `src/lib/scrapers/base.ts`:
```typescript
import { chromium, Browser, BrowserContext, Page } from 'playwright';

export interface ScraperConfig {
  headless?: boolean;
  timeout?: number;
}

export interface RawBid {
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
  documents?: { filename: string; url: string }[];
  raw?: Record<string, unknown>;
}

export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;
  protected config: ScraperConfig;

  abstract readonly platform: string;

  constructor(config: ScraperConfig = {}) {
    this.config = {
      headless: false,
      timeout: 30000,
      ...config,
    };
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    this.page = await this.context.newPage();
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  abstract login(credentials: Record<string, string>): Promise<boolean>;
  abstract scrape(): Promise<RawBid[]>;

  protected async screenshot(name: string): Promise<void> {
    if (this.page) {
      await this.page.screenshot({
        path: `screenshots/${this.platform}-${name}-${Date.now()}.png`,
        fullPage: true,
      });
    }
  }
}
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: add base scraper class"
```

---

### Task 2.2: Implement PlanHub Scraper

**Files:**
- Create: `src/lib/scrapers/planhub.ts`

**Step 1: Create PlanHub scraper**

Create `src/lib/scrapers/planhub.ts`:
```typescript
import { BaseScraper, RawBid, ScraperConfig } from './base';

export class PlanHubScraper extends BaseScraper {
  readonly platform = 'planhub';

  constructor(config: ScraperConfig = {}) {
    super(config);
  }

  async login(credentials: { email: string; password: string }): Promise<boolean> {
    if (!this.page) throw new Error('Scraper not initialized');

    try {
      await this.page.goto('https://app.planhub.com/login', {
        waitUntil: 'networkidle',
        timeout: this.config.timeout,
      });

      await this.page.fill('input[name="email"], input[type="email"]', credentials.email);
      await this.page.fill('input[name="password"], input[type="password"]', credentials.password);
      await this.page.click('button[type="submit"]');

      // Wait for dashboard to load
      await this.page.waitForURL('**/dashboard**', { timeout: 15000 });

      return true;
    } catch (error) {
      console.error('PlanHub login failed:', error);
      await this.screenshot('login-error');
      return false;
    }
  }

  async scrape(): Promise<RawBid[]> {
    if (!this.page) throw new Error('Scraper not initialized');

    const bids: RawBid[] = [];

    try {
      // Navigate to projects/bid board
      await this.page.goto('https://app.planhub.com/projects', {
        waitUntil: 'networkidle',
        timeout: this.config.timeout,
      });

      // Wait for project list
      await this.page.waitForSelector('[data-testid="project-list"], .project-list, table', {
        timeout: 10000,
      });

      // Extract project data
      const projects = await this.page.evaluate(() => {
        const items: any[] = [];

        // Try multiple selectors for project cards/rows
        const projectElements = document.querySelectorAll(
          '[data-testid="project-card"], .project-card, .project-row, table tbody tr'
        );

        projectElements.forEach((el) => {
          const title = el.querySelector('h3, .project-title, td:first-child')?.textContent?.trim();
          const location = el.querySelector('.location, .project-location')?.textContent?.trim();
          const dueDate = el.querySelector('.due-date, .bid-date')?.textContent?.trim();
          const link = el.querySelector('a')?.getAttribute('href');

          if (title) {
            items.push({
              title,
              location,
              dueDate,
              link,
            });
          }
        });

        return items;
      });

      for (const project of projects) {
        bids.push({
          sourceBidId: project.link?.split('/').pop() || `planhub-${Date.now()}`,
          title: project.title,
          city: project.location?.split(',')[0]?.trim(),
          state: project.location?.split(',')[1]?.trim(),
          bidDueDate: project.dueDate ? new Date(project.dueDate) : undefined,
          sourceUrl: project.link ? `https://app.planhub.com${project.link}` : undefined,
        });
      }

      console.log(`PlanHub: Found ${bids.length} projects`);
      return bids;
    } catch (error) {
      console.error('PlanHub scrape failed:', error);
      await this.screenshot('scrape-error');
      return [];
    }
  }
}
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: add PlanHub scraper"
```

---

### Task 2.3: Implement BuildingConnected Scraper

**Files:**
- Create: `src/lib/scrapers/buildingconnected.ts`

**Step 1: Create BuildingConnected scraper**

Create `src/lib/scrapers/buildingconnected.ts`:
```typescript
import { BaseScraper, RawBid, ScraperConfig } from './base';

export class BuildingConnectedScraper extends BaseScraper {
  readonly platform = 'buildingconnected';

  constructor(config: ScraperConfig = {}) {
    super(config);
  }

  async login(credentials: { email: string; password: string }): Promise<boolean> {
    if (!this.page) throw new Error('Scraper not initialized');

    try {
      await this.page.goto('https://app.buildingconnected.com/login', {
        waitUntil: 'networkidle',
        timeout: this.config.timeout,
      });

      await this.page.fill('input[name="email"], input[type="email"]', credentials.email);
      await this.page.fill('input[name="password"], input[type="password"]', credentials.password);
      await this.page.click('button[type="submit"]');

      // Wait for app to load
      await this.page.waitForURL('**/app/**', { timeout: 15000 });

      return true;
    } catch (error) {
      console.error('BuildingConnected login failed:', error);
      await this.screenshot('login-error');
      return false;
    }
  }

  async scrape(): Promise<RawBid[]> {
    if (!this.page) throw new Error('Scraper not initialized');

    const bids: RawBid[] = [];

    try {
      // Navigate to bid board / opportunities
      await this.page.goto('https://app.buildingconnected.com/app/bid-board', {
        waitUntil: 'networkidle',
        timeout: this.config.timeout,
      });

      // Wait for bid list
      await this.page.waitForSelector('[data-testid="bid-list"], .bid-list, .opportunity-list', {
        timeout: 10000,
      });

      // Extract bid data
      const opportunities = await this.page.evaluate(() => {
        const items: any[] = [];

        const bidElements = document.querySelectorAll(
          '[data-testid="bid-card"], .bid-card, .opportunity-card, .bid-row'
        );

        bidElements.forEach((el) => {
          const title = el.querySelector('h3, .bid-title, .project-name')?.textContent?.trim();
          const company = el.querySelector('.company, .gc-name')?.textContent?.trim();
          const location = el.querySelector('.location')?.textContent?.trim();
          const dueDate = el.querySelector('.due-date, .bid-due')?.textContent?.trim();
          const link = el.querySelector('a')?.getAttribute('href');

          if (title) {
            items.push({
              title,
              company,
              location,
              dueDate,
              link,
            });
          }
        });

        return items;
      });

      for (const opp of opportunities) {
        bids.push({
          sourceBidId: opp.link?.split('/').pop() || `bc-${Date.now()}`,
          title: opp.title,
          description: opp.company ? `GC: ${opp.company}` : undefined,
          city: opp.location?.split(',')[0]?.trim(),
          state: opp.location?.split(',')[1]?.trim(),
          bidDueDate: opp.dueDate ? new Date(opp.dueDate) : undefined,
          sourceUrl: opp.link ? `https://app.buildingconnected.com${opp.link}` : undefined,
        });
      }

      console.log(`BuildingConnected: Found ${bids.length} opportunities`);
      return bids;
    } catch (error) {
      console.error('BuildingConnected scrape failed:', error);
      await this.screenshot('scrape-error');
      return [];
    }
  }
}
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: add BuildingConnected scraper"
```

---

### Task 2.4: Implement Gmail Bid Invite Scanner

**Files:**
- Create: `src/lib/scrapers/gmail.ts`

**Step 1: Create Gmail scanner**

Create `src/lib/scrapers/gmail.ts`:
```typescript
import { google } from 'googleapis';

interface GmailCredentials {
  accessToken: string;
  refreshToken: string;
}

interface EmailBid {
  sourceBidId: string;
  title: string;
  invitedDate: Date;
  sourceUrl?: string;
  fromPlatform?: string;
  raw: {
    from: string;
    subject: string;
    snippet: string;
  };
}

export class GmailScanner {
  private oauth2Client;

  constructor(credentials: GmailCredentials) {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    this.oauth2Client.setCredentials({
      access_token: credentials.accessToken,
      refresh_token: credentials.refreshToken,
    });
  }

  async scanForBidInvites(afterDate?: Date): Promise<EmailBid[]> {
    const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    // Build search query for bid invites
    const queries = [
      'from:buildingconnected.com',
      'from:planhub.com',
      'from:planetbids.com',
      'subject:(bid OR invitation OR invited OR RFP OR proposal)',
    ];

    const afterQuery = afterDate
      ? `after:${Math.floor(afterDate.getTime() / 1000)}`
      : 'newer_than:7d';

    const query = `(${queries.join(' OR ')}) ${afterQuery}`;

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 50,
    });

    const messages = response.data.messages || [];
    const bids: EmailBid[] = [];

    for (const msg of messages) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const headers = detail.data.payload?.headers || [];
      const from = headers.find((h) => h.name === 'From')?.value || '';
      const subject = headers.find((h) => h.name === 'Subject')?.value || '';
      const date = headers.find((h) => h.name === 'Date')?.value;

      // Detect platform from sender
      let fromPlatform: string | undefined;
      if (from.includes('buildingconnected')) fromPlatform = 'buildingconnected';
      else if (from.includes('planhub')) fromPlatform = 'planhub';
      else if (from.includes('planetbids')) fromPlatform = 'planetbids';

      bids.push({
        sourceBidId: msg.id!,
        title: subject,
        invitedDate: date ? new Date(date) : new Date(),
        fromPlatform,
        raw: {
          from,
          subject,
          snippet: detail.data.snippet || '',
        },
      });
    }

    console.log(`Gmail: Found ${bids.length} bid invite emails`);
    return bids;
  }
}
```

**Step 2: Install googleapis**

```bash
npm install googleapis
```

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add Gmail bid invite scanner"
```

---

### Task 2.5: Create Scraper Index

**Files:**
- Create: `src/lib/scrapers/index.ts`

**Step 1: Create index file**

Create `src/lib/scrapers/index.ts`:
```typescript
export { BaseScraper, type RawBid, type ScraperConfig } from './base';
export { PlanHubScraper } from './planhub';
export { BuildingConnectedScraper } from './buildingconnected';
export { GmailScanner } from './gmail';
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: add scraper index exports"
```

---

## Phase 3: Background Jobs with Inngest

### Task 3.1: Set Up Inngest

**Files:**
- Create: `src/inngest/client.ts`
- Create: `src/inngest/functions/sync.ts`
- Create: `src/app/api/inngest/route.ts`

**Step 1: Create Inngest client**

Create `src/inngest/client.ts`:
```typescript
import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'stratos-bid' });
```

**Step 2: Create sync functions**

Create `src/inngest/functions/sync.ts`:
```typescript
import { inngest } from '../client';
import { db, connections, bids, syncJobs } from '@/db';
import { eq } from 'drizzle-orm';
import { decryptCredentials } from '@/lib/encryption';
import { PlanHubScraper, BuildingConnectedScraper, GmailScanner, RawBid } from '@/lib/scrapers';

// Daily sync trigger
export const dailySync = inngest.createFunction(
  { id: 'daily-sync' },
  { cron: '0 6 * * *' }, // 6am daily
  async ({ step }) => {
    const users = await step.run('get-active-users', async () => {
      const result = await db.query.connections.findMany({
        where: eq(connections.status, 'active'),
      });
      // Get unique user IDs
      return [...new Set(result.map((c) => c.userId))];
    });

    for (const userId of users) {
      await step.sendEvent('trigger-user-sync', {
        name: 'sync/user',
        data: { userId },
      });
    }

    return { usersTriggered: users.length };
  }
);

// Per-user sync
export const syncUser = inngest.createFunction(
  { id: 'sync-user' },
  { event: 'sync/user' },
  async ({ event, step }) => {
    const userId = event.data.userId;

    const userConnections = await step.run('get-connections', async () => {
      return db.query.connections.findMany({
        where: eq(connections.userId, userId),
      });
    });

    for (const conn of userConnections) {
      await step.run(`sync-${conn.platform}-${conn.id}`, async () => {
        return syncConnection(conn);
      });
    }

    return { connectionsSynced: userConnections.length };
  }
);

async function syncConnection(conn: typeof connections.$inferSelect) {
  // Create sync job record
  const [job] = await db
    .insert(syncJobs)
    .values({
      userId: conn.userId,
      connectionId: conn.id,
      status: 'running',
      startedAt: new Date(),
    })
    .returning();

  try {
    let rawBids: RawBid[] = [];

    if (conn.platform === 'planhub' && conn.credentials) {
      const creds = decryptCredentials<{ email: string; password: string }>(conn.credentials);
      const scraper = new PlanHubScraper();
      await scraper.init();
      const loggedIn = await scraper.login(creds);
      if (loggedIn) {
        rawBids = await scraper.scrape();
      }
      await scraper.close();
    } else if (conn.platform === 'buildingconnected' && conn.credentials) {
      const creds = decryptCredentials<{ email: string; password: string }>(conn.credentials);
      const scraper = new BuildingConnectedScraper();
      await scraper.init();
      const loggedIn = await scraper.login(creds);
      if (loggedIn) {
        rawBids = await scraper.scrape();
      }
      await scraper.close();
    } else if (conn.platform === 'gmail' && conn.credentials) {
      const creds = decryptCredentials<{ accessToken: string; refreshToken: string }>(conn.credentials);
      const scanner = new GmailScanner(creds);
      const emailBids = await scanner.scanForBidInvites();
      rawBids = emailBids.map((eb) => ({
        ...eb,
        sourceBidId: eb.sourceBidId,
        title: eb.title,
        invitedDate: eb.invitedDate,
      }));
    }

    // Upsert bids
    for (const raw of rawBids) {
      await db
        .insert(bids)
        .values({
          userId: conn.userId,
          connectionId: conn.id,
          sourcePlatform: conn.platform,
          sourceBidId: raw.sourceBidId,
          title: raw.title,
          description: raw.description,
          city: raw.city,
          state: raw.state,
          bidDueDate: raw.bidDueDate,
          postedDate: raw.postedDate,
          invitedDate: raw.invitedDate,
          sourceUrl: raw.sourceUrl,
        })
        .onConflictDoUpdate({
          target: [bids.userId, bids.sourcePlatform, bids.sourceBidId],
          set: {
            title: raw.title,
            bidDueDate: raw.bidDueDate,
            updatedAt: new Date(),
          },
        });
    }

    // Update sync job
    await db
      .update(syncJobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        bidsFound: rawBids.length,
      })
      .where(eq(syncJobs.id, job.id));

    // Update connection last synced
    await db
      .update(connections)
      .set({ lastSynced: new Date(), status: 'active' })
      .where(eq(connections.id, conn.id));

    return { bidsFound: rawBids.length };
  } catch (error) {
    await db
      .update(syncJobs)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      })
      .where(eq(syncJobs.id, job.id));

    await db
      .update(connections)
      .set({ status: 'error' })
      .where(eq(connections.id, conn.id));

    throw error;
  }
}
```

**Step 3: Create Inngest API route**

Create `src/app/api/inngest/route.ts`:
```typescript
import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { dailySync, syncUser } from '@/inngest/functions/sync';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [dailySync, syncUser],
});
```

**Step 4: Commit**

```bash
git add .
git commit -m "feat: add Inngest background jobs for sync"
```

---

## Phase 4: Dashboard UI

### Task 4.1: Create Dashboard Layout

**Files:**
- Create: `src/app/(dashboard)/layout.tsx`
- Create: `src/app/(dashboard)/page.tsx`
- Create: `src/components/nav.tsx`

**Step 1: Create navigation component**

Create `src/components/nav.tsx`:
```typescript
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';

const navItems = [
  { href: '/', label: 'Bids' },
  { href: '/connections', label: 'Connections' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  const pathname = usePathname();
  const { data: session } = useSession();

  return (
    <nav className="border-b bg-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 justify-between">
          <div className="flex">
            <div className="flex flex-shrink-0 items-center">
              <span className="text-xl font-bold">Stratos</span>
            </div>
            <div className="ml-10 flex space-x-8">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex items-center border-b-2 px-1 pt-1 text-sm font-medium ${
                    pathname === item.href
                      ? 'border-blue-500 text-gray-900'
                      : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{session?.user?.email}</span>
            <button
              onClick={() => signOut()}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
```

**Step 2: Create dashboard layout**

Create `src/app/(dashboard)/layout.tsx`:
```typescript
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { Nav } from '@/components/nav';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session) {
    redirect('/api/auth/signin');
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add dashboard layout with navigation"
```

---

### Task 4.2: Create Bid Inbox Page

**Files:**
- Create: `src/app/(dashboard)/page.tsx`
- Create: `src/components/bid-card.tsx`

**Step 1: Create bid card component**

Create `src/components/bid-card.tsx`:
```typescript
import Link from 'next/link';

interface BidCardProps {
  bid: {
    id: string;
    title: string;
    sourcePlatform: string;
    city?: string | null;
    state?: string | null;
    bidDueDate?: Date | null;
    relevanceScore?: number | null;
    status: string;
  };
}

function getRelevanceColor(score: number | null | undefined) {
  if (!score) return 'bg-gray-200';
  if (score >= 0.7) return 'bg-green-500';
  if (score >= 0.4) return 'bg-yellow-500';
  return 'bg-gray-300';
}

function formatDate(date: Date | null | undefined) {
  if (!date) return 'No due date';
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function BidCard({ bid }: BidCardProps) {
  const relevancePercent = bid.relevanceScore ? Math.round(bid.relevanceScore * 100) : 0;

  return (
    <Link href={`/bids/${bid.id}`}>
      <div className="rounded-lg border bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`h-10 w-10 rounded-full ${getRelevanceColor(bid.relevanceScore)} flex items-center justify-center text-white text-sm font-medium`}
            >
              {relevancePercent}%
            </div>
            <div>
              <h3 className="font-medium text-gray-900">{bid.title}</h3>
              <p className="text-sm text-gray-500">
                {bid.sourcePlatform} · Due {formatDate(bid.bidDueDate)}
                {bid.city && ` · ${bid.city}, ${bid.state}`}
              </p>
            </div>
          </div>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              bid.status === 'new'
                ? 'bg-blue-100 text-blue-800'
                : bid.status === 'reviewing'
                ? 'bg-yellow-100 text-yellow-800'
                : bid.status === 'bidding'
                ? 'bg-green-100 text-green-800'
                : 'bg-gray-100 text-gray-800'
            }`}
          >
            {bid.status}
          </span>
        </div>
      </div>
    </Link>
  );
}
```

**Step 2: Create bid inbox page**

Create `src/app/(dashboard)/page.tsx`:
```typescript
import { auth } from '@/lib/auth';
import { db, bids } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { BidCard } from '@/components/bid-card';

export default async function BidsPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const userBids = await db.query.bids.findMany({
    where: eq(bids.userId, session.user.id),
    orderBy: [desc(bids.relevanceScore), desc(bids.createdAt)],
  });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Bid Inbox</h1>
        <div className="flex gap-2">
          <select className="rounded-md border-gray-300 text-sm">
            <option>All Sources</option>
            <option>PlanHub</option>
            <option>BuildingConnected</option>
            <option>Gmail</option>
          </select>
          <select className="rounded-md border-gray-300 text-sm">
            <option>All Status</option>
            <option>New</option>
            <option>Reviewing</option>
            <option>Bidding</option>
          </select>
        </div>
      </div>

      {userBids.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500">No bids yet. Connect your accounts to start syncing.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {userBids.map((bid) => (
            <BidCard key={bid.id} bid={bid} />
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add bid inbox page with bid cards"
```

---

### Task 4.3: Create Connections Page

**Files:**
- Create: `src/app/(dashboard)/connections/page.tsx`
- Create: `src/components/connection-card.tsx`
- Create: `src/app/api/connections/route.ts`

**Step 1: Create connection card**

Create `src/components/connection-card.tsx`:
```typescript
'use client';

interface ConnectionCardProps {
  connection?: {
    id: string;
    platform: string;
    status: string;
    lastSynced?: Date | null;
  };
  platform: string;
  onConnect: () => void;
  onDisconnect?: () => void;
}

const platformInfo: Record<string, { name: string; description: string }> = {
  gmail: { name: 'Gmail', description: 'Scan for bid invitation emails' },
  planhub: { name: 'PlanHub', description: 'Sync projects from PlanHub' },
  buildingconnected: { name: 'BuildingConnected', description: 'Sync bid invitations' },
};

export function ConnectionCard({ connection, platform, onConnect, onDisconnect }: ConnectionCardProps) {
  const info = platformInfo[platform];
  const isConnected = !!connection;

  return (
    <div className="rounded-lg border bg-white p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-gray-900">{info.name}</h3>
          <p className="text-sm text-gray-500">{info.description}</p>
          {connection?.lastSynced && (
            <p className="mt-1 text-xs text-gray-400">
              Last synced: {new Date(connection.lastSynced).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isConnected && (
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                connection.status === 'active'
                  ? 'bg-green-100 text-green-800'
                  : 'bg-red-100 text-red-800'
              }`}
            >
              {connection.status}
            </span>
          )}
          {isConnected ? (
            <button
              onClick={onDisconnect}
              className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-100"
            >
              Disconnect
            </button>
          ) : (
            <button
              onClick={onConnect}
              className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Connect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Create connections page**

Create `src/app/(dashboard)/connections/page.tsx`:
```typescript
import { auth } from '@/lib/auth';
import { db, connections } from '@/db';
import { eq } from 'drizzle-orm';
import { ConnectionCard } from '@/components/connection-card';

export default async function ConnectionsPage() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const userConnections = await db.query.connections.findMany({
    where: eq(connections.userId, session.user.id),
  });

  const platforms = ['gmail', 'planhub', 'buildingconnected'];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">Connections</h1>
      <div className="space-y-4">
        {platforms.map((platform) => {
          const conn = userConnections.find((c) => c.platform === platform);
          return (
            <ConnectionCard
              key={platform}
              platform={platform}
              connection={conn}
              onConnect={() => {
                // Will be handled by client component
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
```

**Step 3: Create connections API**

Create `src/app/api/connections/route.ts`:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db, connections } from '@/db';
import { eq, and } from 'drizzle-orm';
import { encryptCredentials } from '@/lib/encryption';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const { platform, email, password } = body;

  if (!platform || !email || !password) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  const encryptedCreds = encryptCredentials({ email, password });

  const [connection] = await db
    .insert(connections)
    .values({
      userId: session.user.id,
      platform,
      authType: 'password',
      credentials: encryptedCreds,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: [connections.userId, connections.platform],
      set: {
        credentials: encryptedCreds,
        status: 'active',
      },
    })
    .returning();

  return NextResponse.json({ connection: { id: connection.id, platform, status: 'active' } });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const platform = searchParams.get('platform');

  if (!platform) {
    return NextResponse.json({ error: 'Missing platform' }, { status: 400 });
  }

  await db
    .delete(connections)
    .where(and(eq(connections.userId, session.user.id), eq(connections.platform, platform)));

  return NextResponse.json({ success: true });
}
```

**Step 4: Commit**

```bash
git add .
git commit -m "feat: add connections page and API"
```

---

## Next Steps

Continue with:
- Task 4.4: Bid Detail Page
- Task 4.5: Document Pipeline Integration
- Phase 5: Polish (error handling, sync triggers)

---

Plan complete and saved to `docs/plans/2026-01-07-stratos-bid-implementation.md`.

**Two execution options:**

1. **Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

2. **Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
