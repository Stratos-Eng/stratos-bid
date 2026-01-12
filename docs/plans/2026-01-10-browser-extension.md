# Stratos Browser Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Chrome extension that syncs bids from PlanHub, BuildingConnected, and PlanetBids in the background using the user's existing browser sessions.

**Architecture:** Manifest V3 extension with service worker for coordination and offscreen document for heavy lifting. Extension fetches platform pages using user's cookies (via `fetch()` with `credentials: 'include'`), parses HTML, downloads documents, and uploads everything to the Stratos backend. No credentials stored in extension - relies on user's existing logged-in sessions.

**Tech Stack:** Chrome Extension Manifest V3, TypeScript, Vite (bundler), Chrome Alarms API, Offscreen Documents API

---

## Directory Structure

```
stratos/
├── stratos-bid/                    # Existing Next.js backend
│   └── src/app/api/extension/      # NEW: Extension API endpoints
└── stratos-extension/              # NEW: Chrome extension
    ├── manifest.json
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── src/
    │   ├── background/
    │   │   └── service-worker.ts   # Alarms, offscreen lifecycle
    │   ├── offscreen/
    │   │   ├── offscreen.html
    │   │   └── offscreen.ts        # Fetch + parse logic
    │   ├── popup/
    │   │   ├── popup.html
    │   │   ├── popup.ts
    │   │   └── popup.css
    │   ├── platforms/
    │   │   ├── types.ts            # Shared types
    │   │   ├── planhub.ts          # PlanHub parser
    │   │   ├── buildingconnected.ts
    │   │   └── planetbids.ts
    │   └── lib/
    │       ├── storage.ts          # chrome.storage helpers
    │       ├── api.ts              # Stratos API client
    │       └── constants.ts
    └── dist/                       # Build output (load in Chrome)
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `stratos-extension/package.json`
- Create: `stratos-extension/tsconfig.json`
- Create: `stratos-extension/vite.config.ts`
- Create: `stratos-extension/manifest.json`

### Step 1: Create extension directory and package.json

```bash
mkdir -p /Users/hamza/stratos/stratos-extension/src/{background,offscreen,popup,platforms,lib}
```

Create `stratos-extension/package.json`:

```json
{
  "name": "stratos-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.268",
    "typescript": "^5.3.0",
    "vite": "^5.0.0"
  }
}
```

### Step 2: Create tsconfig.json

Create `stratos-extension/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022", "DOM"],
    "types": ["chrome"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Step 3: Create vite.config.ts

Create `stratos-extension/vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyDirOnBuild: true,
    rollupOptions: {
      input: {
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'offscreen': resolve(__dirname, 'src/offscreen/offscreen.ts'),
        'popup': resolve(__dirname, 'src/popup/popup.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
```

### Step 4: Create manifest.json

Create `stratos-extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Stratos Bid Aggregator",
  "version": "0.1.0",
  "description": "Automatically sync bids from PlanHub, BuildingConnected, and PlanetBids",

  "permissions": [
    "storage",
    "alarms",
    "offscreen",
    "cookies"
  ],

  "host_permissions": [
    "https://*.planhub.com/*",
    "https://*.buildingconnected.com/*",
    "https://*.planetbids.com/*",
    "https://pbsystem.planetbids.com/*",
    "http://localhost:3000/*",
    "https://stratos.app/*"
  ],

  "background": {
    "service_worker": "service-worker.js",
    "type": "module"
  },

  "action": {
    "default_popup": "popup.html",
    "default_title": "Stratos"
  },

  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

### Step 5: Install dependencies

```bash
cd /Users/hamza/stratos/stratos-extension && npm install
```

### Step 6: Commit scaffolding

```bash
cd /Users/hamza/stratos/stratos-extension
git init
git add .
git commit -m "feat: scaffold Chrome extension with Vite + TypeScript"
```

---

## Task 2: Shared Types and Constants

**Files:**
- Create: `stratos-extension/src/lib/constants.ts`
- Create: `stratos-extension/src/platforms/types.ts`
- Create: `stratos-extension/src/lib/storage.ts`

### Step 1: Create constants

Create `stratos-extension/src/lib/constants.ts`:

```typescript
export const STRATOS_API_BASE =
  process.env.NODE_ENV === 'production'
    ? 'https://stratos.app'
    : 'http://localhost:3000';

export const SYNC_INTERVAL_MINUTES = 240; // 4 hours

export const PLATFORMS = {
  PLANHUB: 'planhub',
  BUILDING_CONNECTED: 'buildingconnected',
  PLANETBIDS: 'planetbids',
} as const;

export type Platform = typeof PLATFORMS[keyof typeof PLATFORMS];

export const PLATFORM_URLS = {
  [PLATFORMS.PLANHUB]: {
    base: 'https://app.planhub.com',
    itbs: 'https://subcontractor.planhub.com/leads/list',
    loginCheck: 'https://app.planhub.com/api/user',
  },
  [PLATFORMS.BUILDING_CONNECTED]: {
    base: 'https://app.buildingconnected.com',
    bids: 'https://app.buildingconnected.com/bid-board',
    loginCheck: 'https://app.buildingconnected.com/api/v2/users/me',
  },
  [PLATFORMS.PLANETBIDS]: {
    base: 'https://pbsystem.planetbids.com',
    portalBids: (portalId: string) =>
      `https://pbsystem.planetbids.com/portal/${portalId}/bo/bo-search`,
  },
} as const;
```

### Step 2: Create shared types

Create `stratos-extension/src/platforms/types.ts`:

```typescript
import { Platform } from '@/lib/constants';

export interface ExtractedBid {
  sourceBidId: string;
  title: string;
  description?: string;
  projectAddress?: string;
  city?: string;
  state?: string;
  bidDueDate?: string; // ISO string
  postedDate?: string;
  sourceUrl: string;
  documents: ExtractedDocument[];
}

export interface ExtractedDocument {
  filename: string;
  downloadUrl: string;
  docType?: 'plans' | 'specs' | 'addendum' | 'other';
}

export interface ConnectionStatus {
  platform: Platform;
  portalId?: string; // For PlanetBids
  status: 'connected' | 'needs_reauth' | 'not_connected';
  lastSynced?: string; // ISO string
  bidCount?: number;
}

export interface SyncResult {
  platform: Platform;
  portalId?: string;
  success: boolean;
  bidsFound: number;
  docsDownloaded: number;
  error?: string;
}

export interface PlatformParser {
  checkSession(): Promise<boolean>;
  extractBids(): Promise<ExtractedBid[]>;
  downloadDocument(url: string): Promise<Blob>;
}
```

### Step 3: Create storage helpers

Create `stratos-extension/src/lib/storage.ts`:

```typescript
import { ConnectionStatus, Platform } from '@/platforms/types';
import { PLATFORMS } from './constants';

interface StorageData {
  authToken?: string;
  userId?: string;
  connections: ConnectionStatus[];
  lastSyncTime?: string;
  syncInProgress: boolean;
}

const STORAGE_KEY = 'stratos_data';

export async function getStorageData(): Promise<StorageData> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {
    connections: [],
    syncInProgress: false,
  };
}

export async function setStorageData(data: Partial<StorageData>): Promise<void> {
  const current = await getStorageData();
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...current, ...data },
  });
}

export async function getConnection(platform: Platform, portalId?: string): Promise<ConnectionStatus | undefined> {
  const data = await getStorageData();
  return data.connections.find(c =>
    c.platform === platform &&
    (portalId ? c.portalId === portalId : true)
  );
}

export async function updateConnection(connection: ConnectionStatus): Promise<void> {
  const data = await getStorageData();
  const idx = data.connections.findIndex(c =>
    c.platform === connection.platform &&
    c.portalId === connection.portalId
  );

  if (idx >= 0) {
    data.connections[idx] = connection;
  } else {
    data.connections.push(connection);
  }

  await setStorageData({ connections: data.connections });
}

export async function removeConnection(platform: Platform, portalId?: string): Promise<void> {
  const data = await getStorageData();
  data.connections = data.connections.filter(c =>
    !(c.platform === platform && (portalId ? c.portalId === portalId : true))
  );
  await setStorageData({ connections: data.connections });
}
```

### Step 4: Commit types and storage

```bash
git add src/lib src/platforms/types.ts
git commit -m "feat: add shared types, constants, and storage helpers"
```

---

## Task 3: Service Worker Foundation

**Files:**
- Create: `stratos-extension/src/background/service-worker.ts`

### Step 1: Create service worker with alarm handling

Create `stratos-extension/src/background/service-worker.ts`:

```typescript
import { SYNC_INTERVAL_MINUTES } from '@/lib/constants';
import { getStorageData, setStorageData } from '@/lib/storage';

const ALARM_NAME = 'stratos-sync';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

// Track if offscreen document exists
let creatingOffscreen: Promise<void> | null = null;

// =============================================================================
// INSTALLATION & STARTUP
// =============================================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Stratos] Extension installed:', details.reason);

  // Set up periodic sync alarm
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1, // First sync 1 minute after install
    periodInMinutes: SYNC_INTERVAL_MINUTES,
  });

  console.log(`[Stratos] Sync alarm set for every ${SYNC_INTERVAL_MINUTES} minutes`);
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Stratos] Browser started');

  // Ensure alarm exists
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm) {
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: SYNC_INTERVAL_MINUTES,
    });
  }
});

// =============================================================================
// ALARM HANDLER
// =============================================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('[Stratos] Sync alarm triggered');
    await triggerSync();
  }
});

// =============================================================================
// SYNC COORDINATION
// =============================================================================

async function triggerSync(): Promise<void> {
  const data = await getStorageData();

  // Check if sync already in progress
  if (data.syncInProgress) {
    console.log('[Stratos] Sync already in progress, skipping');
    return;
  }

  // Check if user is authenticated
  if (!data.authToken) {
    console.log('[Stratos] No auth token, skipping sync');
    return;
  }

  // Check if any connections exist
  const activeConnections = data.connections.filter(c => c.status === 'connected');
  if (activeConnections.length === 0) {
    console.log('[Stratos] No active connections, skipping sync');
    return;
  }

  console.log(`[Stratos] Starting sync for ${activeConnections.length} connections`);
  await setStorageData({ syncInProgress: true });

  try {
    // Create offscreen document for heavy lifting
    await ensureOffscreenDocument();

    // Send sync command to offscreen document
    const response = await chrome.runtime.sendMessage({
      type: 'SYNC',
      connections: activeConnections,
      authToken: data.authToken,
    });

    console.log('[Stratos] Sync complete:', response);

    await setStorageData({
      syncInProgress: false,
      lastSyncTime: new Date().toISOString(),
    });

    // Update badge with new bid count
    if (response?.newBidsCount > 0) {
      await chrome.action.setBadgeText({ text: String(response.newBidsCount) });
      await chrome.action.setBadgeBackgroundColor({ color: '#22C55E' });
    }
  } catch (error) {
    console.error('[Stratos] Sync failed:', error);
    await setStorageData({ syncInProgress: false });
  } finally {
    // Clean up offscreen document
    await closeOffscreenDocument();
  }
}

// =============================================================================
// OFFSCREEN DOCUMENT MANAGEMENT
// =============================================================================

async function hasOffscreenDocument(): Promise<boolean> {
  // @ts-ignore - getContexts is available in MV3
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: 'Parse HTML from bid platforms',
  });

  await creatingOffscreen;
  creatingOffscreen = null;
}

async function closeOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

// =============================================================================
// MESSAGE HANDLING (from popup)
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'MANUAL_SYNC') {
    triggerSync().then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // Keep channel open for async response
  }

  if (message.type === 'GET_STATUS') {
    getStorageData().then((data) => {
      sendResponse({
        connections: data.connections,
        lastSyncTime: data.lastSyncTime,
        syncInProgress: data.syncInProgress,
        isAuthenticated: !!data.authToken,
      });
    });
    return true;
  }

  if (message.type === 'SET_AUTH_TOKEN') {
    setStorageData({
      authToken: message.token,
      userId: message.userId,
    }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// =============================================================================
// COOKIE CHANGE DETECTION (for session expiry)
// =============================================================================

chrome.cookies.onChanged.addListener(async (changeInfo) => {
  // Detect when platform session cookies are removed
  const { cookie, removed, cause } = changeInfo;

  if (!removed) return;
  if (cause === 'overwrite') return; // Cookie was replaced, not removed

  const platformDomains = ['.planhub.com', '.buildingconnected.com', '.planetbids.com'];
  const isRelevant = platformDomains.some(d => cookie.domain.includes(d));

  if (isRelevant && cookie.name.toLowerCase().includes('session')) {
    console.log(`[Stratos] Session cookie removed for ${cookie.domain}`);
    // Could mark connection as needs_reauth here
  }
});

console.log('[Stratos] Service worker loaded');
```

### Step 2: Commit service worker

```bash
git add src/background/service-worker.ts
git commit -m "feat: add service worker with alarm-based sync coordination"
```

---

## Task 4: Offscreen Document

**Files:**
- Create: `stratos-extension/src/offscreen/offscreen.html`
- Create: `stratos-extension/src/offscreen/offscreen.ts`

### Step 1: Create offscreen.html

Create `stratos-extension/src/offscreen/offscreen.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Stratos Offscreen</title>
</head>
<body>
  <script type="module" src="offscreen.js"></script>
</body>
</html>
```

### Step 2: Create offscreen.ts

Create `stratos-extension/src/offscreen/offscreen.ts`:

```typescript
import { ConnectionStatus, ExtractedBid, SyncResult } from '@/platforms/types';
import { PLATFORMS, STRATOS_API_BASE } from '@/lib/constants';
import { syncPlanHub } from '@/platforms/planhub';
import { syncBuildingConnected } from '@/platforms/buildingconnected';
import { syncPlanetBids } from '@/platforms/planetbids';

console.log('[Stratos Offscreen] Loaded');

// =============================================================================
// MESSAGE HANDLING
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SYNC') {
    handleSync(message.connections, message.authToken)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

// =============================================================================
// SYNC ORCHESTRATION
// =============================================================================

interface SyncResponse {
  success: boolean;
  results: SyncResult[];
  newBidsCount: number;
  error?: string;
}

async function handleSync(
  connections: ConnectionStatus[],
  authToken: string
): Promise<SyncResponse> {
  console.log(`[Stratos Offscreen] Starting sync for ${connections.length} connections`);

  const results: SyncResult[] = [];
  let totalNewBids = 0;

  for (const connection of connections) {
    try {
      let result: SyncResult;

      switch (connection.platform) {
        case PLATFORMS.PLANHUB:
          result = await syncPlanHub(authToken);
          break;
        case PLATFORMS.BUILDING_CONNECTED:
          result = await syncBuildingConnected(authToken);
          break;
        case PLATFORMS.PLANETBIDS:
          result = await syncPlanetBids(connection.portalId!, authToken);
          break;
        default:
          result = {
            platform: connection.platform,
            success: false,
            bidsFound: 0,
            docsDownloaded: 0,
            error: `Unknown platform: ${connection.platform}`,
          };
      }

      results.push(result);
      if (result.success) {
        totalNewBids += result.bidsFound;
      }

    } catch (error: any) {
      console.error(`[Stratos Offscreen] Error syncing ${connection.platform}:`, error);
      results.push({
        platform: connection.platform,
        portalId: connection.portalId,
        success: false,
        bidsFound: 0,
        docsDownloaded: 0,
        error: error.message,
      });
    }

    // Small delay between platforms to be polite
    await sleep(1000);
  }

  return {
    success: results.every(r => r.success),
    results,
    newBidsCount: totalNewBids,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Step 3: Commit offscreen document

```bash
git add src/offscreen/
git commit -m "feat: add offscreen document for background sync"
```

---

## Task 5: PlanHub Platform Parser

**Files:**
- Create: `stratos-extension/src/platforms/planhub.ts`

### Step 1: Create PlanHub parser

Create `stratos-extension/src/platforms/planhub.ts`:

```typescript
import { ExtractedBid, ExtractedDocument, SyncResult } from './types';
import { PLATFORMS, PLATFORM_URLS, STRATOS_API_BASE } from '@/lib/constants';

const PLANHUB = PLATFORM_URLS[PLATFORMS.PLANHUB];

// =============================================================================
// SESSION CHECK
// =============================================================================

export async function checkPlanHubSession(): Promise<boolean> {
  try {
    const response = await fetch(PLANHUB.loginCheck, {
      credentials: 'include',
    });
    return response.ok;
  } catch {
    return false;
  }
}

// =============================================================================
// MAIN SYNC FUNCTION
// =============================================================================

export async function syncPlanHub(authToken: string): Promise<SyncResult> {
  console.log('[PlanHub] Starting sync');

  // Check if we have a valid session
  const hasSession = await checkPlanHubSession();
  if (!hasSession) {
    console.log('[PlanHub] No valid session');
    return {
      platform: PLATFORMS.PLANHUB,
      success: false,
      bidsFound: 0,
      docsDownloaded: 0,
      error: 'Session expired - please log in to PlanHub',
    };
  }

  try {
    // Fetch the ITBs page
    const html = await fetchITBsPage();

    // Parse bids from HTML
    const bids = parseITBsHtml(html);
    console.log(`[PlanHub] Found ${bids.length} bids`);

    // For each bid, fetch details and documents
    const enrichedBids: ExtractedBid[] = [];
    for (const bid of bids.slice(0, 20)) { // Limit to 20 per sync
      try {
        const details = await fetchBidDetails(bid.sourceUrl);
        enrichedBids.push({ ...bid, ...details });
        await sleep(500); // Polite delay
      } catch (error) {
        console.error(`[PlanHub] Error fetching details for ${bid.sourceBidId}:`, error);
        enrichedBids.push(bid);
      }
    }

    // Download documents
    let docsDownloaded = 0;
    for (const bid of enrichedBids) {
      for (const doc of bid.documents) {
        try {
          const blob = await downloadDocument(doc.downloadUrl);
          await uploadDocument(authToken, bid.sourceBidId, doc.filename, blob);
          docsDownloaded++;
        } catch (error) {
          console.error(`[PlanHub] Error downloading ${doc.filename}:`, error);
        }
      }
    }

    // Upload bids to Stratos
    await uploadBids(authToken, enrichedBids);

    return {
      platform: PLATFORMS.PLANHUB,
      success: true,
      bidsFound: enrichedBids.length,
      docsDownloaded,
    };

  } catch (error: any) {
    console.error('[PlanHub] Sync error:', error);
    return {
      platform: PLATFORMS.PLANHUB,
      success: false,
      bidsFound: 0,
      docsDownloaded: 0,
      error: error.message,
    };
  }
}

// =============================================================================
// FETCHING
// =============================================================================

async function fetchITBsPage(): Promise<string> {
  const response = await fetch(PLANHUB.itbs, {
    credentials: 'include',
    headers: {
      'Accept': 'text/html',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ITBs page: ${response.status}`);
  }

  return response.text();
}

async function fetchBidDetails(url: string): Promise<Partial<ExtractedBid>> {
  const response = await fetch(url, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch bid details: ${response.status}`);
  }

  const html = await response.text();
  return parseBidDetailHtml(html);
}

async function downloadDocument(url: string): Promise<Blob> {
  const response = await fetch(url, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Failed to download document: ${response.status}`);
  }

  return response.blob();
}

// =============================================================================
// HTML PARSING
// =============================================================================

function parseITBsHtml(html: string): ExtractedBid[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const bids: ExtractedBid[] = [];

  // PlanHub uses various selectors for project cards
  const projectCards = doc.querySelectorAll(
    '[data-testid*="project"], [class*="ProjectCard"], [class*="LeadCard"], .project-item'
  );

  for (const card of projectCards) {
    try {
      // Extract title
      const titleEl = card.querySelector('h3, h4, [class*="title"], [class*="name"], a');
      const title = titleEl?.textContent?.trim();
      if (!title) continue;

      // Extract link
      const linkEl = card.querySelector('a[href*="project"], a[href*="lead"]') as HTMLAnchorElement;
      const sourceUrl = linkEl?.href || '';

      // Extract ID from URL or generate from title
      const sourceBidId = extractBidId(sourceUrl) || slugify(title);

      // Extract due date
      const dueDateEl = card.querySelector('[class*="date"], [class*="deadline"], [class*="due"]');
      const bidDueDate = parseDateString(dueDateEl?.textContent);

      // Extract location
      const locationEl = card.querySelector('[class*="location"], [class*="address"]');
      const location = parseLocation(locationEl?.textContent);

      // Extract GC name
      const gcEl = card.querySelector('[class*="company"], [class*="gc"], [class*="contractor"]');
      const description = gcEl?.textContent?.trim();

      bids.push({
        sourceBidId,
        title,
        description,
        sourceUrl,
        bidDueDate,
        city: location.city,
        state: location.state,
        documents: [],
      });

    } catch (error) {
      console.error('[PlanHub] Error parsing project card:', error);
    }
  }

  return bids;
}

function parseBidDetailHtml(html: string): Partial<ExtractedBid> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Extract documents
  const documents: ExtractedDocument[] = [];
  const docElements = doc.querySelectorAll(
    '[data-testid="document"], .document-item, .file-item, .attachment, tr[data-file-id]'
  );

  for (const el of docElements) {
    const linkEl = el.querySelector('a[href]') as HTMLAnchorElement;
    if (!linkEl) continue;

    const filename = linkEl.textContent?.trim() || 'document.pdf';
    const downloadUrl = linkEl.href;

    documents.push({
      filename,
      downloadUrl,
      docType: classifyDocType(filename),
    });
  }

  // Extract full description
  const descEl = doc.querySelector('[class*="description"], [class*="scope"], .project-details');
  const description = descEl?.textContent?.trim();

  // Extract address
  const addressEl = doc.querySelector('[class*="address"], [class*="location"]');
  const projectAddress = addressEl?.textContent?.trim();

  return {
    description,
    projectAddress,
    documents,
  };
}

// =============================================================================
// UPLOAD TO STRATOS
// =============================================================================

async function uploadBids(authToken: string, bids: ExtractedBid[]): Promise<void> {
  const response = await fetch(`${STRATOS_API_BASE}/api/extension/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      platform: PLATFORMS.PLANHUB,
      bids,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to upload bids: ${response.status}`);
  }
}

async function uploadDocument(
  authToken: string,
  bidId: string,
  filename: string,
  blob: Blob
): Promise<void> {
  const formData = new FormData();
  formData.append('file', blob, filename);
  formData.append('bidId', bidId);
  formData.append('platform', PLATFORMS.PLANHUB);

  const response = await fetch(`${STRATOS_API_BASE}/api/extension/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload document: ${response.status}`);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function extractBidId(url: string): string | null {
  const match = url.match(/projects?\/([a-zA-Z0-9-]+)/);
  return match ? match[1] : null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

function parseDateString(text: string | undefined | null): string | undefined {
  if (!text) return undefined;

  try {
    const date = new Date(text);
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
  } catch {}

  return undefined;
}

function parseLocation(text: string | undefined | null): { city?: string; state?: string } {
  if (!text) return {};

  // Try to match "City, ST" pattern
  const match = text.match(/([^,]+),\s*([A-Z]{2})/);
  if (match) {
    return { city: match[1].trim(), state: match[2] };
  }

  return {};
}

function classifyDocType(filename: string): ExtractedDocument['docType'] {
  const lower = filename.toLowerCase();
  if (lower.includes('plan') || lower.includes('drawing')) return 'plans';
  if (lower.includes('spec')) return 'specs';
  if (lower.includes('addend')) return 'addendum';
  return 'other';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Step 2: Commit PlanHub parser

```bash
git add src/platforms/planhub.ts
git commit -m "feat: add PlanHub platform parser"
```

---

## Task 6: BuildingConnected Platform Parser

**Files:**
- Create: `stratos-extension/src/platforms/buildingconnected.ts`

### Step 1: Create BuildingConnected parser

Create `stratos-extension/src/platforms/buildingconnected.ts`:

```typescript
import { ExtractedBid, ExtractedDocument, SyncResult } from './types';
import { PLATFORMS, PLATFORM_URLS, STRATOS_API_BASE } from '@/lib/constants';

const BC = PLATFORM_URLS[PLATFORMS.BUILDING_CONNECTED];

// =============================================================================
// SESSION CHECK
// =============================================================================

export async function checkBuildingConnectedSession(): Promise<boolean> {
  try {
    const response = await fetch(BC.loginCheck, {
      credentials: 'include',
    });
    return response.ok;
  } catch {
    return false;
  }
}

// =============================================================================
// MAIN SYNC FUNCTION
// =============================================================================

export async function syncBuildingConnected(authToken: string): Promise<SyncResult> {
  console.log('[BuildingConnected] Starting sync');

  const hasSession = await checkBuildingConnectedSession();
  if (!hasSession) {
    console.log('[BuildingConnected] No valid session');
    return {
      platform: PLATFORMS.BUILDING_CONNECTED,
      success: false,
      bidsFound: 0,
      docsDownloaded: 0,
      error: 'Session expired - please log in to BuildingConnected',
    };
  }

  try {
    // BuildingConnected uses a React SPA, so we need to check if they have an API
    // or scrape the rendered HTML
    const html = await fetchBidBoardPage();
    const bids = parseBidBoardHtml(html);

    console.log(`[BuildingConnected] Found ${bids.length} bids`);

    // Fetch details for each bid
    const enrichedBids: ExtractedBid[] = [];
    for (const bid of bids.slice(0, 20)) {
      try {
        const details = await fetchBidDetails(bid.sourceUrl);
        enrichedBids.push({ ...bid, ...details });
        await sleep(500);
      } catch (error) {
        console.error(`[BuildingConnected] Error fetching details:`, error);
        enrichedBids.push(bid);
      }
    }

    // Download documents
    let docsDownloaded = 0;
    for (const bid of enrichedBids) {
      for (const doc of bid.documents) {
        try {
          const blob = await downloadDocument(doc.downloadUrl);
          await uploadDocument(authToken, bid.sourceBidId, doc.filename, blob);
          docsDownloaded++;
        } catch (error) {
          console.error(`[BuildingConnected] Error downloading ${doc.filename}:`, error);
        }
      }
    }

    // Upload to Stratos
    await uploadBids(authToken, enrichedBids);

    return {
      platform: PLATFORMS.BUILDING_CONNECTED,
      success: true,
      bidsFound: enrichedBids.length,
      docsDownloaded,
    };

  } catch (error: any) {
    console.error('[BuildingConnected] Sync error:', error);
    return {
      platform: PLATFORMS.BUILDING_CONNECTED,
      success: false,
      bidsFound: 0,
      docsDownloaded: 0,
      error: error.message,
    };
  }
}

// =============================================================================
// FETCHING
// =============================================================================

async function fetchBidBoardPage(): Promise<string> {
  const response = await fetch(BC.bids, {
    credentials: 'include',
    headers: {
      'Accept': 'text/html',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch bid board: ${response.status}`);
  }

  return response.text();
}

async function fetchBidDetails(url: string): Promise<Partial<ExtractedBid>> {
  const response = await fetch(url, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch bid details: ${response.status}`);
  }

  const html = await response.text();
  return parseBidDetailHtml(html);
}

async function downloadDocument(url: string): Promise<Blob> {
  const response = await fetch(url, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }

  return response.blob();
}

// =============================================================================
// HTML PARSING
// =============================================================================

function parseBidBoardHtml(html: string): ExtractedBid[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const bids: ExtractedBid[] = [];

  // BuildingConnected bid board selectors (may need adjustment based on actual HTML)
  const bidCards = doc.querySelectorAll(
    '[data-testid*="bid"], [class*="BidCard"], [class*="ProjectCard"], .bid-item'
  );

  for (const card of bidCards) {
    try {
      const titleEl = card.querySelector('h3, h4, [class*="title"], [class*="name"]');
      const title = titleEl?.textContent?.trim();
      if (!title) continue;

      const linkEl = card.querySelector('a[href*="bid"], a[href*="project"]') as HTMLAnchorElement;
      const sourceUrl = linkEl?.href || '';

      const sourceBidId = extractBidId(sourceUrl) || slugify(title);

      const dueDateEl = card.querySelector('[class*="deadline"], [class*="due"], [class*="date"]');
      const bidDueDate = parseDateString(dueDateEl?.textContent);

      const gcEl = card.querySelector('[class*="company"], [class*="gc"]');
      const description = gcEl?.textContent?.trim();

      const locationEl = card.querySelector('[class*="location"]');
      const location = parseLocation(locationEl?.textContent);

      bids.push({
        sourceBidId,
        title,
        description,
        sourceUrl,
        bidDueDate,
        city: location.city,
        state: location.state,
        documents: [],
      });

    } catch (error) {
      console.error('[BuildingConnected] Error parsing bid card:', error);
    }
  }

  return bids;
}

function parseBidDetailHtml(html: string): Partial<ExtractedBid> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const documents: ExtractedDocument[] = [];
  const docElements = doc.querySelectorAll(
    '[class*="document"], [class*="file"], [class*="attachment"], .doc-item'
  );

  for (const el of docElements) {
    const linkEl = el.querySelector('a[href]') as HTMLAnchorElement;
    if (!linkEl) continue;

    const filename = linkEl.textContent?.trim() || 'document.pdf';
    const downloadUrl = linkEl.href;

    documents.push({
      filename,
      downloadUrl,
      docType: classifyDocType(filename),
    });
  }

  const descEl = doc.querySelector('[class*="description"], [class*="scope"]');
  const description = descEl?.textContent?.trim();

  const addressEl = doc.querySelector('[class*="address"]');
  const projectAddress = addressEl?.textContent?.trim();

  return { description, projectAddress, documents };
}

// =============================================================================
// UPLOAD TO STRATOS
// =============================================================================

async function uploadBids(authToken: string, bids: ExtractedBid[]): Promise<void> {
  const response = await fetch(`${STRATOS_API_BASE}/api/extension/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      platform: PLATFORMS.BUILDING_CONNECTED,
      bids,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to upload bids: ${response.status}`);
  }
}

async function uploadDocument(
  authToken: string,
  bidId: string,
  filename: string,
  blob: Blob
): Promise<void> {
  const formData = new FormData();
  formData.append('file', blob, filename);
  formData.append('bidId', bidId);
  formData.append('platform', PLATFORMS.BUILDING_CONNECTED);

  const response = await fetch(`${STRATOS_API_BASE}/api/extension/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload document: ${response.status}`);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function extractBidId(url: string): string | null {
  const match = url.match(/(?:bid|project)[s]?\/([a-zA-Z0-9-]+)/);
  return match ? match[1] : null;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
}

function parseDateString(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  try {
    const date = new Date(text);
    if (!isNaN(date.getTime())) return date.toISOString();
  } catch {}
  return undefined;
}

function parseLocation(text: string | undefined | null): { city?: string; state?: string } {
  if (!text) return {};
  const match = text.match(/([^,]+),\s*([A-Z]{2})/);
  return match ? { city: match[1].trim(), state: match[2] } : {};
}

function classifyDocType(filename: string): ExtractedDocument['docType'] {
  const lower = filename.toLowerCase();
  if (lower.includes('plan') || lower.includes('drawing')) return 'plans';
  if (lower.includes('spec')) return 'specs';
  if (lower.includes('addend')) return 'addendum';
  return 'other';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Step 2: Commit BuildingConnected parser

```bash
git add src/platforms/buildingconnected.ts
git commit -m "feat: add BuildingConnected platform parser"
```

---

## Task 7: PlanetBids Platform Parser

**Files:**
- Create: `stratos-extension/src/platforms/planetbids.ts`

### Step 1: Create PlanetBids parser

Create `stratos-extension/src/platforms/planetbids.ts`:

```typescript
import { ExtractedBid, ExtractedDocument, SyncResult } from './types';
import { PLATFORMS, PLATFORM_URLS, STRATOS_API_BASE } from '@/lib/constants';

const PB = PLATFORM_URLS[PLATFORMS.PLANETBIDS];

// =============================================================================
// SESSION CHECK
// =============================================================================

export async function checkPlanetBidsSession(portalId: string): Promise<boolean> {
  try {
    // Try to access a protected resource on the portal
    const response = await fetch(
      `https://pbsystem.planetbids.com/portal/${portalId}/vendor/profile`,
      { credentials: 'include', redirect: 'manual' }
    );
    // If we get redirected to login, session is invalid
    return response.status !== 302 && response.status !== 301;
  } catch {
    return false;
  }
}

// =============================================================================
// MAIN SYNC FUNCTION
// =============================================================================

export async function syncPlanetBids(portalId: string, authToken: string): Promise<SyncResult> {
  console.log(`[PlanetBids] Starting sync for portal ${portalId}`);

  const hasSession = await checkPlanetBidsSession(portalId);
  if (!hasSession) {
    console.log(`[PlanetBids] No valid session for portal ${portalId}`);
    return {
      platform: PLATFORMS.PLANETBIDS,
      portalId,
      success: false,
      bidsFound: 0,
      docsDownloaded: 0,
      error: `Session expired for portal ${portalId} - please log in`,
    };
  }

  try {
    // Fetch the bid search page
    const html = await fetchBidSearchPage(portalId);
    const bids = parseBidSearchHtml(html, portalId);

    console.log(`[PlanetBids] Found ${bids.length} bids in portal ${portalId}`);

    // Fetch details for each bid
    const enrichedBids: ExtractedBid[] = [];
    for (const bid of bids.slice(0, 20)) {
      try {
        const details = await fetchBidDetails(bid.sourceUrl);
        enrichedBids.push({ ...bid, ...details });
        await sleep(500);
      } catch (error) {
        console.error(`[PlanetBids] Error fetching details:`, error);
        enrichedBids.push(bid);
      }
    }

    // Download documents (requires login)
    let docsDownloaded = 0;
    for (const bid of enrichedBids) {
      for (const doc of bid.documents) {
        try {
          const blob = await downloadDocument(doc.downloadUrl);
          await uploadDocument(authToken, bid.sourceBidId, doc.filename, blob, portalId);
          docsDownloaded++;
        } catch (error) {
          console.error(`[PlanetBids] Error downloading ${doc.filename}:`, error);
        }
      }
    }

    // Upload to Stratos
    await uploadBids(authToken, enrichedBids, portalId);

    return {
      platform: PLATFORMS.PLANETBIDS,
      portalId,
      success: true,
      bidsFound: enrichedBids.length,
      docsDownloaded,
    };

  } catch (error: any) {
    console.error(`[PlanetBids] Sync error for portal ${portalId}:`, error);
    return {
      platform: PLATFORMS.PLANETBIDS,
      portalId,
      success: false,
      bidsFound: 0,
      docsDownloaded: 0,
      error: error.message,
    };
  }
}

// =============================================================================
// FETCHING
// =============================================================================

async function fetchBidSearchPage(portalId: string): Promise<string> {
  const url = PB.portalBids(portalId);
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'text/html',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch bid search: ${response.status}`);
  }

  return response.text();
}

async function fetchBidDetails(url: string): Promise<Partial<ExtractedBid>> {
  const response = await fetch(url, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch bid details: ${response.status}`);
  }

  const html = await response.text();
  return parseBidDetailHtml(html);
}

async function downloadDocument(url: string): Promise<Blob> {
  const response = await fetch(url, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }

  return response.blob();
}

// =============================================================================
// HTML PARSING
// =============================================================================

function parseBidSearchHtml(html: string, portalId: string): ExtractedBid[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const bids: ExtractedBid[] = [];

  // PlanetBids uses a table for bid listings
  const rows = doc.querySelectorAll('table tbody tr, .bid-row, [data-bid-id]');

  for (const row of rows) {
    try {
      // Look for bid title link
      const titleLink = row.querySelector('a[href*="bo-detail"]') as HTMLAnchorElement;
      if (!titleLink) continue;

      const title = titleLink.textContent?.trim();
      if (!title) continue;

      const sourceUrl = titleLink.href;

      // Extract bid ID from URL
      const bidIdMatch = sourceUrl.match(/bid=(\d+)/);
      const sourceBidId = bidIdMatch
        ? `${portalId}-${bidIdMatch[1]}`
        : `${portalId}-${slugify(title)}`;

      // Extract columns (typical order: Posted, Title, Bid Number, Due Date, Stage)
      const cells = row.querySelectorAll('td');

      let postedDate: string | undefined;
      let bidDueDate: string | undefined;
      let bidNumber: string | undefined;

      if (cells.length >= 4) {
        postedDate = parseDateString(cells[0]?.textContent);
        bidNumber = cells[2]?.textContent?.trim();
        bidDueDate = parseDateString(cells[3]?.textContent);
      }

      bids.push({
        sourceBidId,
        title,
        description: bidNumber ? `Bid #${bidNumber}` : undefined,
        sourceUrl,
        postedDate,
        bidDueDate,
        documents: [],
      });

    } catch (error) {
      console.error('[PlanetBids] Error parsing row:', error);
    }
  }

  return bids;
}

function parseBidDetailHtml(html: string): Partial<ExtractedBid> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const documents: ExtractedDocument[] = [];

  // PlanetBids document table
  const docRows = doc.querySelectorAll('table.documents tr, .document-row, [data-document-id]');

  for (const row of docRows) {
    const linkEl = row.querySelector('a[href*="download"], a[href*=".pdf"]') as HTMLAnchorElement;
    if (!linkEl) continue;

    const filename = linkEl.textContent?.trim() || 'document.pdf';
    const downloadUrl = linkEl.href;

    documents.push({
      filename,
      downloadUrl,
      docType: classifyDocType(filename),
    });
  }

  // Extract description from bid details section
  const descEl = doc.querySelector('.bid-description, [class*="description"], .details-content');
  const description = descEl?.textContent?.trim();

  // Extract location/address
  const locationEl = doc.querySelector('[class*="location"], [class*="address"]');
  const projectAddress = locationEl?.textContent?.trim();

  return { description, projectAddress, documents };
}

// =============================================================================
// UPLOAD TO STRATOS
// =============================================================================

async function uploadBids(authToken: string, bids: ExtractedBid[], portalId: string): Promise<void> {
  const response = await fetch(`${STRATOS_API_BASE}/api/extension/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      platform: PLATFORMS.PLANETBIDS,
      portalId,
      bids,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to upload bids: ${response.status}`);
  }
}

async function uploadDocument(
  authToken: string,
  bidId: string,
  filename: string,
  blob: Blob,
  portalId: string
): Promise<void> {
  const formData = new FormData();
  formData.append('file', blob, filename);
  formData.append('bidId', bidId);
  formData.append('platform', PLATFORMS.PLANETBIDS);
  formData.append('portalId', portalId);

  const response = await fetch(`${STRATOS_API_BASE}/api/extension/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload document: ${response.status}`);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
}

function parseDateString(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  try {
    const date = new Date(text);
    if (!isNaN(date.getTime())) return date.toISOString();
  } catch {}
  return undefined;
}

function classifyDocType(filename: string): ExtractedDocument['docType'] {
  const lower = filename.toLowerCase();
  if (lower.includes('plan') || lower.includes('drawing')) return 'plans';
  if (lower.includes('spec')) return 'specs';
  if (lower.includes('addend')) return 'addendum';
  return 'other';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Step 2: Commit PlanetBids parser

```bash
git add src/platforms/planetbids.ts
git commit -m "feat: add PlanetBids platform parser with portal support"
```

---

## Task 8: Extension Popup UI

**Files:**
- Create: `stratos-extension/src/popup/popup.html`
- Create: `stratos-extension/src/popup/popup.css`
- Create: `stratos-extension/src/popup/popup.ts`

### Step 1: Create popup.html

Create `stratos-extension/src/popup/popup.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=400">
  <title>Stratos</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="app">
    <!-- Header -->
    <header class="header">
      <h1>Stratos</h1>
      <button id="settings-btn" class="icon-btn" title="Settings">⚙️</button>
    </header>

    <!-- Auth Section (shown when not authenticated) -->
    <section id="auth-section" class="section hidden">
      <p>Connect your Stratos account to sync bids.</p>
      <button id="login-btn" class="btn btn-primary">Connect Account</button>
    </section>

    <!-- Main Section (shown when authenticated) -->
    <section id="main-section" class="section hidden">
      <!-- Sync Status -->
      <div class="sync-status">
        <span id="sync-status-text">Ready to sync</span>
        <button id="sync-btn" class="btn btn-secondary">Sync Now</button>
      </div>

      <!-- Connections -->
      <div class="connections">
        <h2>Platforms</h2>
        <div id="connections-list">
          <!-- Populated by JS -->
        </div>
        <button id="add-connection-btn" class="btn btn-outline">+ Add Platform</button>
      </div>

      <!-- Recent Bids -->
      <div class="recent-bids">
        <h2>Recent Bids</h2>
        <div id="bids-list">
          <p class="empty-state">No bids synced yet</p>
        </div>
        <a href="#" id="view-all-btn" class="link">View all in dashboard →</a>
      </div>
    </section>

    <!-- Add Connection Modal -->
    <div id="add-modal" class="modal hidden">
      <div class="modal-content">
        <h2>Connect Platform</h2>
        <p>Select a platform and log in to connect:</p>
        <div class="platform-buttons">
          <button class="platform-btn" data-platform="planhub">
            <span class="platform-icon">📋</span>
            <span>PlanHub</span>
          </button>
          <button class="platform-btn" data-platform="buildingconnected">
            <span class="platform-icon">🏗️</span>
            <span>BuildingConnected</span>
          </button>
          <button class="platform-btn" data-platform="planetbids">
            <span class="platform-icon">🏛️</span>
            <span>PlanetBids</span>
          </button>
        </div>
        <button id="close-modal-btn" class="btn btn-outline">Cancel</button>
      </div>
    </div>
  </div>

  <script type="module" src="popup.js"></script>
</body>
</html>
```

### Step 2: Create popup.css

Create `stratos-extension/src/popup/popup.css`:

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  width: 360px;
  min-height: 400px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #1a1a1a;
  background: #ffffff;
}

.hidden {
  display: none !important;
}

/* Header */
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #e5e5e5;
}

.header h1 {
  font-size: 18px;
  font-weight: 600;
  color: #0f172a;
}

.icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  padding: 4px;
}

/* Sections */
.section {
  padding: 16px;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  border: none;
}

.btn-primary {
  background: #2563eb;
  color: white;
}

.btn-primary:hover {
  background: #1d4ed8;
}

.btn-secondary {
  background: #f1f5f9;
  color: #0f172a;
}

.btn-secondary:hover {
  background: #e2e8f0;
}

.btn-outline {
  background: transparent;
  border: 1px solid #e5e5e5;
  color: #64748b;
}

.btn-outline:hover {
  background: #f8fafc;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Sync Status */
.sync-status {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background: #f8fafc;
  border-radius: 8px;
  margin-bottom: 16px;
}

#sync-status-text {
  color: #64748b;
  font-size: 13px;
}

/* Connections */
.connections {
  margin-bottom: 16px;
}

.connections h2,
.recent-bids h2 {
  font-size: 13px;
  font-weight: 600;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 12px;
}

#connections-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.connection-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: #f8fafc;
  border-radius: 8px;
}

.connection-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.connection-icon {
  font-size: 20px;
}

.connection-name {
  font-weight: 500;
}

.connection-status {
  font-size: 12px;
  color: #64748b;
}

.connection-status.connected {
  color: #22c55e;
}

.connection-status.needs-reauth {
  color: #f59e0b;
}

/* Recent Bids */
.recent-bids {
  border-top: 1px solid #e5e5e5;
  padding-top: 16px;
}

#bids-list {
  margin-bottom: 12px;
}

.bid-item {
  padding: 12px;
  background: #f8fafc;
  border-radius: 8px;
  margin-bottom: 8px;
}

.bid-title {
  font-weight: 500;
  margin-bottom: 4px;
}

.bid-meta {
  font-size: 12px;
  color: #64748b;
}

.empty-state {
  text-align: center;
  color: #94a3b8;
  padding: 24px;
}

.link {
  color: #2563eb;
  text-decoration: none;
  font-size: 13px;
}

.link:hover {
  text-decoration: underline;
}

/* Modal */
.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.modal-content {
  background: white;
  border-radius: 12px;
  padding: 24px;
  width: 100%;
  max-width: 320px;
}

.modal-content h2 {
  font-size: 18px;
  margin-bottom: 8px;
}

.modal-content p {
  color: #64748b;
  margin-bottom: 16px;
}

.platform-buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.platform-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #f8fafc;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.platform-btn:hover {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

.platform-icon {
  font-size: 24px;
}

/* Loading spinner */
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid #e5e5e5;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

### Step 3: Create popup.ts

Create `stratos-extension/src/popup/popup.ts`:

```typescript
import { PLATFORMS, STRATOS_API_BASE, PLATFORM_URLS } from '@/lib/constants';
import { ConnectionStatus, Platform } from '@/platforms/types';

// =============================================================================
// DOM ELEMENTS
// =============================================================================

const authSection = document.getElementById('auth-section')!;
const mainSection = document.getElementById('main-section')!;
const loginBtn = document.getElementById('login-btn')!;
const syncBtn = document.getElementById('sync-btn')!;
const syncStatusText = document.getElementById('sync-status-text')!;
const connectionsList = document.getElementById('connections-list')!;
const addConnectionBtn = document.getElementById('add-connection-btn')!;
const addModal = document.getElementById('add-modal')!;
const closeModalBtn = document.getElementById('close-modal-btn')!;
const platformButtons = document.querySelectorAll('.platform-btn');
const viewAllBtn = document.getElementById('view-all-btn')!;

// =============================================================================
// STATE
// =============================================================================

interface PopupState {
  isAuthenticated: boolean;
  connections: ConnectionStatus[];
  lastSyncTime?: string;
  syncInProgress: boolean;
}

let state: PopupState = {
  isAuthenticated: false,
  connections: [],
  syncInProgress: false,
};

// =============================================================================
// INITIALIZATION
// =============================================================================

async function init() {
  // Get current status from service worker
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });

  state = {
    isAuthenticated: status.isAuthenticated,
    connections: status.connections || [],
    lastSyncTime: status.lastSyncTime,
    syncInProgress: status.syncInProgress,
  };

  render();
}

// =============================================================================
// RENDERING
// =============================================================================

function render() {
  // Show/hide sections based on auth state
  if (state.isAuthenticated) {
    authSection.classList.add('hidden');
    mainSection.classList.remove('hidden');
  } else {
    authSection.classList.remove('hidden');
    mainSection.classList.add('hidden');
  }

  // Update sync status
  if (state.syncInProgress) {
    syncStatusText.textContent = 'Syncing...';
    syncBtn.disabled = true;
    syncBtn.innerHTML = '<span class="spinner"></span>';
  } else if (state.lastSyncTime) {
    const ago = formatTimeAgo(new Date(state.lastSyncTime));
    syncStatusText.textContent = `Last synced ${ago}`;
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync Now';
  } else {
    syncStatusText.textContent = 'Ready to sync';
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync Now';
  }

  // Render connections
  renderConnections();
}

function renderConnections() {
  if (state.connections.length === 0) {
    connectionsList.innerHTML = '<p class="empty-state">No platforms connected</p>';
    return;
  }

  connectionsList.innerHTML = state.connections.map(conn => `
    <div class="connection-item">
      <div class="connection-info">
        <span class="connection-icon">${getPlatformIcon(conn.platform)}</span>
        <div>
          <div class="connection-name">${getPlatformName(conn.platform)}${conn.portalId ? ` (${conn.portalId})` : ''}</div>
          <div class="connection-status ${conn.status}">${formatStatus(conn.status)}</div>
        </div>
      </div>
      <button class="icon-btn" data-action="remove" data-platform="${conn.platform}" data-portal="${conn.portalId || ''}">❌</button>
    </div>
  `).join('');

  // Add remove handlers
  connectionsList.querySelectorAll('[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', handleRemoveConnection);
  });
}

// =============================================================================
// EVENT HANDLERS
// =============================================================================

loginBtn.addEventListener('click', () => {
  // Open Stratos login page
  chrome.tabs.create({ url: `${STRATOS_API_BASE}/login?extension=true` });
});

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  syncBtn.innerHTML = '<span class="spinner"></span>';
  syncStatusText.textContent = 'Syncing...';

  try {
    await chrome.runtime.sendMessage({ type: 'MANUAL_SYNC' });

    // Refresh status
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    state.lastSyncTime = status.lastSyncTime;
    state.syncInProgress = false;
    render();
  } catch (error) {
    console.error('Sync failed:', error);
    syncStatusText.textContent = 'Sync failed';
    syncBtn.disabled = false;
    syncBtn.textContent = 'Retry';
  }
});

addConnectionBtn.addEventListener('click', () => {
  addModal.classList.remove('hidden');
});

closeModalBtn.addEventListener('click', () => {
  addModal.classList.add('hidden');
});

platformButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const platform = btn.getAttribute('data-platform') as Platform;
    connectPlatform(platform);
    addModal.classList.add('hidden');
  });
});

viewAllBtn.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: `${STRATOS_API_BASE}/dashboard` });
});

async function handleRemoveConnection(e: Event) {
  const btn = e.currentTarget as HTMLElement;
  const platform = btn.getAttribute('data-platform') as Platform;
  const portalId = btn.getAttribute('data-portal') || undefined;

  // Remove from state
  state.connections = state.connections.filter(c =>
    !(c.platform === platform && c.portalId === portalId)
  );

  // Update storage
  await chrome.runtime.sendMessage({
    type: 'REMOVE_CONNECTION',
    platform,
    portalId
  });

  render();
}

// =============================================================================
// PLATFORM CONNECTION
// =============================================================================

async function connectPlatform(platform: Platform) {
  let loginUrl: string;

  switch (platform) {
    case PLATFORMS.PLANHUB:
      loginUrl = PLATFORM_URLS[PLATFORMS.PLANHUB].base + '/login';
      break;
    case PLATFORMS.BUILDING_CONNECTED:
      loginUrl = PLATFORM_URLS[PLATFORMS.BUILDING_CONNECTED].base + '/login';
      break;
    case PLATFORMS.PLANETBIDS:
      // For PlanetBids, we need to ask which portal
      const portalId = prompt('Enter PlanetBids Portal ID (e.g., 14319):');
      if (!portalId) return;
      loginUrl = `https://pbsystem.planetbids.com/portal/${portalId}/login`;
      break;
    default:
      return;
  }

  // Open the login page
  chrome.tabs.create({ url: loginUrl });

  // Set up a listener to detect when login is complete
  // This is simplified - in production you'd use content scripts
  // to detect login success and notify the extension
}

// =============================================================================
// HELPERS
// =============================================================================

function getPlatformIcon(platform: Platform): string {
  switch (platform) {
    case PLATFORMS.PLANHUB: return '📋';
    case PLATFORMS.BUILDING_CONNECTED: return '🏗️';
    case PLATFORMS.PLANETBIDS: return '🏛️';
    default: return '📄';
  }
}

function getPlatformName(platform: Platform): string {
  switch (platform) {
    case PLATFORMS.PLANHUB: return 'PlanHub';
    case PLATFORMS.BUILDING_CONNECTED: return 'BuildingConnected';
    case PLATFORMS.PLANETBIDS: return 'PlanetBids';
    default: return platform;
  }
}

function formatStatus(status: ConnectionStatus['status']): string {
  switch (status) {
    case 'connected': return '✓ Connected';
    case 'needs_reauth': return '⚠️ Needs re-login';
    case 'not_connected': return 'Not connected';
    default: return status;
  }
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

// =============================================================================
// LISTEN FOR AUTH MESSAGES FROM WEB APP
// =============================================================================

// When user logs into Stratos web app, it sends the auth token to the extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'AUTH_TOKEN') {
    chrome.runtime.sendMessage({
      type: 'SET_AUTH_TOKEN',
      token: message.token,
      userId: message.userId,
    }).then(() => {
      state.isAuthenticated = true;
      render();
    });
  }
});

// =============================================================================
// INIT
// =============================================================================

init();
```

### Step 4: Commit popup UI

```bash
git add src/popup/
git commit -m "feat: add extension popup UI"
```

---

## Task 9: Backend API Endpoints

**Files:**
- Create: `stratos-bid/src/app/api/extension/sync/route.ts`
- Create: `stratos-bid/src/app/api/extension/upload/route.ts`
- Create: `stratos-bid/src/app/api/extension/status/route.ts`
- Create: `stratos-bid/src/app/api/extension/token/route.ts`

### Step 1: Create sync endpoint

Create `stratos-bid/src/app/api/extension/sync/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { bids, connections, documents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

interface ExtractedBid {
  sourceBidId: string;
  title: string;
  description?: string;
  projectAddress?: string;
  city?: string;
  state?: string;
  bidDueDate?: string;
  postedDate?: string;
  sourceUrl: string;
  documents: { filename: string; docType?: string }[];
}

interface SyncRequest {
  platform: string;
  portalId?: string;
  bids: ExtractedBid[];
}

export async function POST(req: NextRequest) {
  // Verify auth token from extension
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const userId = await verifyExtensionToken(token);

  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  try {
    const body: SyncRequest = await req.json();
    const { platform, portalId, bids: extractedBids } = body;

    // Find or create connection
    let connection = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.userId, userId),
          eq(connections.platform, platform)
        )
      )
      .limit(1)
      .then(rows => rows[0]);

    if (!connection) {
      const [newConn] = await db
        .insert(connections)
        .values({
          userId,
          platform,
          authType: 'extension',
          status: 'active',
        })
        .returning();
      connection = newConn;
    }

    // Upsert bids
    let inserted = 0;
    let updated = 0;

    for (const bid of extractedBids) {
      const existing = await db
        .select()
        .from(bids)
        .where(
          and(
            eq(bids.userId, userId),
            eq(bids.sourcePlatform, platform),
            eq(bids.sourceBidId, bid.sourceBidId)
          )
        )
        .limit(1)
        .then(rows => rows[0]);

      if (existing) {
        await db
          .update(bids)
          .set({
            title: bid.title,
            description: bid.description,
            projectAddress: bid.projectAddress,
            city: bid.city,
            state: bid.state,
            bidDueDate: bid.bidDueDate ? new Date(bid.bidDueDate) : null,
            postedDate: bid.postedDate ? new Date(bid.postedDate) : null,
            sourceUrl: bid.sourceUrl,
            updatedAt: new Date(),
          })
          .where(eq(bids.id, existing.id));
        updated++;
      } else {
        await db
          .insert(bids)
          .values({
            userId,
            connectionId: connection.id,
            sourcePlatform: platform,
            sourceBidId: bid.sourceBidId,
            title: bid.title,
            description: bid.description,
            projectAddress: bid.projectAddress,
            city: bid.city,
            state: bid.state,
            bidDueDate: bid.bidDueDate ? new Date(bid.bidDueDate) : null,
            postedDate: bid.postedDate ? new Date(bid.postedDate) : null,
            sourceUrl: bid.sourceUrl,
          });
        inserted++;
      }
    }

    // Update connection last synced
    await db
      .update(connections)
      .set({ lastSynced: new Date(), status: 'active' })
      .where(eq(connections.id, connection.id));

    return NextResponse.json({
      success: true,
      inserted,
      updated,
      total: extractedBids.length,
    });

  } catch (error: any) {
    console.error('Extension sync error:', error);
    return NextResponse.json(
      { error: 'Sync failed', details: error.message },
      { status: 500 }
    );
  }
}

async function verifyExtensionToken(token: string): Promise<string | null> {
  // TODO: Implement proper token verification
  // For now, decode a simple JWT-like token
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.userId;
  } catch {
    return null;
  }
}
```

### Step 2: Create upload endpoint

Create `stratos-bid/src/app/api/extension/upload/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { bids, documents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const userId = await verifyExtensionToken(token);

  if (!userId) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const bidId = formData.get('bidId') as string;
    const platform = formData.get('platform') as string;

    if (!file || !bidId || !platform) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Find the bid
    const bid = await db
      .select()
      .from(bids)
      .where(
        and(
          eq(bids.userId, userId),
          eq(bids.sourcePlatform, platform),
          eq(bids.sourceBidId, bidId)
        )
      )
      .limit(1)
      .then(rows => rows[0]);

    if (!bid) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }

    // Save file to disk
    const docsDir = join(process.cwd(), 'docs', platform, bidId);
    await mkdir(docsDir, { recursive: true });

    const filePath = join(docsDir, file.name);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filePath, buffer);

    // Create document record
    const [doc] = await db
      .insert(documents)
      .values({
        bidId: bid.id,
        filename: file.name,
        docType: classifyDocType(file.name),
        storagePath: filePath,
        downloadedAt: new Date(),
      })
      .returning();

    return NextResponse.json({
      success: true,
      documentId: doc.id,
    });

  } catch (error: any) {
    console.error('Upload error:', error);
    return NextResponse.json(
      { error: 'Upload failed', details: error.message },
      { status: 500 }
    );
  }
}

function classifyDocType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('plan') || lower.includes('drawing')) return 'plans';
  if (lower.includes('spec')) return 'specs';
  if (lower.includes('addend')) return 'addendum';
  return 'other';
}

async function verifyExtensionToken(token: string): Promise<string | null> {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.userId;
  } catch {
    return null;
  }
}
```

### Step 3: Create token generation endpoint

Create `stratos-bid/src/app/api/extension/token/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { sign } from 'jsonwebtoken';

const EXTENSION_TOKEN_SECRET = process.env.EXTENSION_TOKEN_SECRET || 'dev-secret-change-in-prod';

export async function POST(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Generate a long-lived token for the extension
  const token = sign(
    { userId: session.user.id, email: session.user.email },
    EXTENSION_TOKEN_SECRET,
    { expiresIn: '90d' }
  );

  return NextResponse.json({
    token,
    userId: session.user.id,
  });
}
```

### Step 4: Commit backend API

```bash
cd /Users/hamza/stratos/stratos-bid
git add src/app/api/extension/
git commit -m "feat: add extension API endpoints for sync and upload"
```

---

## Task 10: Build and Test

**Files:**
- Update: `stratos-extension/vite.config.ts` (copy static files)
- Create: `stratos-extension/public/icons/` (placeholder icons)

### Step 1: Update vite config to copy static files

Update `stratos-extension/vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyDirOnBuild: true,
    rollupOptions: {
      input: {
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'offscreen': resolve(__dirname, 'src/offscreen/offscreen.ts'),
        'popup': resolve(__dirname, 'src/popup/popup.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [
    {
      name: 'copy-static-files',
      closeBundle() {
        const dist = resolve(__dirname, 'dist');

        // Copy manifest
        copyFileSync(
          resolve(__dirname, 'manifest.json'),
          resolve(dist, 'manifest.json')
        );

        // Copy popup HTML and CSS
        copyFileSync(
          resolve(__dirname, 'src/popup/popup.html'),
          resolve(dist, 'popup.html')
        );
        copyFileSync(
          resolve(__dirname, 'src/popup/popup.css'),
          resolve(dist, 'popup.css')
        );

        // Copy offscreen HTML
        copyFileSync(
          resolve(__dirname, 'src/offscreen/offscreen.html'),
          resolve(dist, 'offscreen.html')
        );

        // Copy icons
        const iconsDir = resolve(dist, 'icons');
        if (!existsSync(iconsDir)) {
          mkdirSync(iconsDir, { recursive: true });
        }
        // Icons will be added manually
      },
    },
  ],
});
```

### Step 2: Create placeholder icons

```bash
mkdir -p stratos-extension/public/icons
# Create placeholder 16x16, 48x48, 128x128 PNG icons
# For now, use simple colored squares
```

### Step 3: Build the extension

```bash
cd /Users/hamza/stratos/stratos-extension
npm run build
```

### Step 4: Load in Chrome for testing

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `stratos-extension/dist` folder

### Step 5: Test the extension

1. Click extension icon → should see auth section
2. Log into Stratos web app → should get token
3. Log into PlanHub manually in browser
4. Click "Sync Now" → should see sync progress
5. Check Stratos dashboard for new bids

### Step 6: Commit final build setup

```bash
git add vite.config.ts
git commit -m "feat: add build configuration with static file copying"
```

---

## Summary

This plan creates a complete browser extension with:

1. **Service Worker** - Handles alarms for periodic sync, manages offscreen document lifecycle
2. **Offscreen Document** - Does the heavy lifting of fetching and parsing platform pages
3. **Platform Parsers** - PlanHub, BuildingConnected, PlanetBids with HTML parsing and document download
4. **Popup UI** - Shows connection status, allows manual sync, links to dashboard
5. **Backend API** - Receives synced bids and uploaded documents from extension

**Key architectural decisions:**
- Uses `fetch()` with `credentials: 'include'` to make requests using user's session cookies
- No credentials stored in extension - relies entirely on user's logged-in browser sessions
- Background sync via Chrome Alarms API (every 4 hours)
- Offscreen document for DOMParser access and long-running operations
- Backend does deduplication and storage

---

**Plan complete and saved to `docs/plans/2026-01-10-browser-extension.md`.**

**Two execution options:**

1. **Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

2. **Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
