# Stratos Bid Aggregator - Architecture Design

**Date:** 2026-01-07
**Status:** Approved

---

## Overview

Stratos Bid is a hosted SaaS that aggregates construction bid opportunities from multiple platforms into a single dashboard for specialty trade subcontractors (glazing, signage).

### What It Does

1. **Connects to user accounts** — Gmail (OAuth), PlanHub (email/password), BuildingConnected (email/password), PlanetBids (public)
2. **Automatically scans** — Runs daily scans for new bid invites
3. **Downloads & analyzes documents** — Gets PDFs, extracts text, scores relevance
4. **Presents in dashboard** — Users see all bids filtered by relevance
5. **Enables action** — Users can respond/download directly from Stratos

### MVP Scope

- Dashboard with bid inbox, detail view, connections management
- Full workflow (view, download, respond) minus email/SMS alerts
- PlanetBids, PlanHub, BuildingConnected, Gmail as sources

---

## Architecture

### Approach: Monolith + Background Jobs

```
┌─────────────────────────────────────────────────────────┐
│                   NEXT.JS APP                           │
├─────────────────────────────────────────────────────────┤
│  Dashboard UI    │    API Routes    │   Background Jobs │
│  (React)         │    (tRPC/REST)   │   (Inngest)       │
├─────────────────────────────────────────────────────────┤
│                      POSTGRES                           │
│   users, connections, bids, documents, sync_jobs        │
├─────────────────────────────────────────────────────────┤
│                      SERVICES                           │
│   • Playwright (browser automation)                     │
│   • Supabase Storage (PDFs)                             │
│   • AES-256-GCM (credential encryption)                 │
└─────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | Next.js 14+ (App Router) | Full-stack, Vercel deploy |
| Database | Postgres (Supabase/Neon) | Relational, hosted |
| ORM | Drizzle | Type-safe, lightweight |
| Auth | NextAuth.js | Gmail OAuth built-in |
| Background Jobs | Inngest | Serverless-friendly, long timeouts |
| File Storage | Supabase Storage | PDFs, extracted text |
| Credential Encryption | AES-256-GCM | Encrypt passwords at rest |
| Browser Automation | Playwright | Proven with BC/PlanHub |

---

## Data Model

### users
Managed by NextAuth.

### connections
```sql
connections
  id              UUID PRIMARY KEY
  user_id         UUID REFERENCES users
  platform        TEXT  -- 'gmail' | 'planhub' | 'buildingconnected' | 'planetbids'
  auth_type       TEXT  -- 'oauth' | 'password' | 'api_key'
  credentials     TEXT  -- encrypted JSON: {email, password} or {api_key} or {access_token, refresh_token, expires_at}
  status          TEXT  -- 'active' | 'error' | 'needs_reauth'
  last_synced     TIMESTAMP
  created_at      TIMESTAMP
```

### bids
```sql
bids
  id              UUID PRIMARY KEY
  user_id         UUID REFERENCES users
  connection_id   UUID REFERENCES connections
  source_platform TEXT
  source_bid_id   TEXT

  -- Core fields
  title           TEXT
  description     TEXT
  project_address TEXT
  city            TEXT
  state           TEXT

  -- Dates
  bid_due_date    TIMESTAMP
  posted_date     TIMESTAMP
  invited_date    TIMESTAMP

  -- Status & scoring
  status          TEXT  -- 'new' | 'reviewing' | 'bidding' | 'passed' | 'won' | 'lost'
  relevance_score REAL  -- 0-1
  relevance_reasons JSONB

  -- Links
  source_url      TEXT

  created_at      TIMESTAMP
  updated_at      TIMESTAMP

  UNIQUE(user_id, source_platform, source_bid_id)
```

### documents
```sql
documents
  id              UUID PRIMARY KEY
  bid_id          UUID REFERENCES bids
  filename        TEXT
  doc_type        TEXT  -- 'plans' | 'specs' | 'addendum' | 'other'
  storage_path    TEXT
  extracted_text  TEXT
  relevance_score REAL
  page_count      INT
  downloaded_at   TIMESTAMP
  created_at      TIMESTAMP
```

### sync_jobs
```sql
sync_jobs
  id              UUID PRIMARY KEY
  user_id         UUID REFERENCES users
  connection_id   UUID REFERENCES connections
  status          TEXT  -- 'pending' | 'running' | 'completed' | 'failed'
  started_at      TIMESTAMP
  completed_at    TIMESTAMP
  error_message   TEXT
  bids_found      INT
  docs_downloaded INT
```

---

## Auth & Connection Flow

### Gmail (OAuth)
```
User clicks "Connect Gmail"
    → NextAuth OAuth flow with Google
    → Scopes: gmail.readonly
    → Get access_token + refresh_token
    → Encrypt and store in connections.credentials
```

### PlanHub / BuildingConnected (Password)
```
User enters email + password in Stratos UI
    → Encrypt credentials with AES-256-GCM
    → Store in connections.credentials
    → Background job tests login with Playwright
    → Success → status = 'active'
    → Fail → status = 'error', show message to user
```

### Credential Encryption
- Algorithm: AES-256-GCM
- Key: from `ENCRYPTION_KEY` environment variable
- Each credential blob gets unique IV
- Decrypt only when sync job runs
- Never exposed to frontend

---

## Background Jobs (Sync Engine)

### Job Types

| Job | Trigger | Description |
|-----|---------|-------------|
| `daily-sync` | Cron 6am | Kicks off sync for all active users |
| `sync-user` | Event | Fan out to all user's connections |
| `sync-gmail` | Per connection | Fetch bid invite emails, extract project links |
| `sync-planhub` | Per connection | Login, search with filters, fetch projects |
| `sync-buildingconnected` | Per connection | Login, check bid board for invites |
| `download-documents` | After sync | Download PDFs from project pages |
| `analyze-documents` | After download | Extract text, score relevance |

### Job Flow
```
daily-sync (cron)
    │
    └─► sync-user (per user)
            │
            ├─► sync-gmail
            ├─► sync-planhub
            └─► sync-buildingconnected
                    │
                    └─► download-documents (per bid)
                            │
                            └─► analyze-documents (per doc)
```

### Inngest Implementation
```typescript
// Scheduled daily sync
inngest.createFunction(
  { id: "daily-sync" },
  { cron: "0 6 * * *" },
  async ({ step }) => {
    const users = await step.run("get-users", () => getActiveUsers());
    for (const user of users) {
      await step.sendEvent("sync/user", { userId: user.id });
    }
  }
);

// Per-user sync
inngest.createFunction(
  { id: "sync-user" },
  { event: "sync/user" },
  async ({ event, step }) => {
    const connections = await step.run("get-connections", () =>
      getConnections(event.data.userId)
    );
    for (const conn of connections) {
      await step.run(`sync-${conn.platform}`, () => syncPlatform(conn));
    }
  }
);
```

---

## Document Pipeline

### Download Flow
```
New bid found
    → Create document records in DB
    → Queue download-documents job
    → Playwright navigates to project page
    → Download each PDF to temp storage
    → Upload to Supabase Storage
    → Update document.storage_path
```

### Analysis Flow
```
Document downloaded
    → Queue analyze-documents job
    → Download PDF from storage
    → Extract text with pdf-parse
    → Run relevance scoring
    → Store extracted_text + relevance_score
    → Update bid's overall relevance_score
```

### Relevance Scoring (v1 - Keyword Based)

```typescript
const TRADE_KEYWORDS = {
  glazing: [
    'glazing', 'glass', 'window', 'curtain wall', 'storefront',
    'skylight', 'aluminum frame', 'vision glass', 'spandrel',
    'division 08', '08 40 00', '08 44 00', '08 80 00'
  ],
  signage: [
    'signage', 'sign', 'wayfinding', 'monument sign', 'channel letter',
    'ada sign', 'directory', 'pylon', 'illuminated',
    'division 10', '10 14 00'
  ]
};

function scoreDocument(text: string, trades: string[]): number {
  const lowerText = text.toLowerCase();
  let matches = 0;

  for (const trade of trades) {
    for (const keyword of TRADE_KEYWORDS[trade]) {
      if (lowerText.includes(keyword)) {
        matches++;
      }
    }
  }

  return Math.min(matches / 5, 1.0);
}
```

> **TODO:** Implement smarter scoring with ML/LLM-based classification.

### Storage Structure
```
/documents/{user_id}/{bid_id}/
  plans.pdf
  specs.pdf
  addendum-1.pdf
```

---

## Dashboard UI

### Views

| View | Purpose |
|------|---------|
| Bid Inbox | All bids, sorted by due date, filterable |
| Bid Detail | Single bid with docs, status controls |
| Connections | Manage connected accounts |
| Settings | Trade preferences, location filters |

### Bid Inbox
```
┌─────────────────────────────────────────────────────────────────┐
│  STRATOS                                    [Settings] [Sync Now]│
├─────────────────────────────────────────────────────────────────┤
│  Filters: [All Sources ▼] [Open ▼] [High Relevance ▼] [CA ▼]   │
├─────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 🟢 92%  Downtown Medical Center - Glazing Package          │ │
│  │ BuildingConnected · Due Jan 15 · Los Angeles, CA           │ │
│  │ [Plans] [Specs] [Addendum 1]                    [View →]   │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 🟡 65%  City Hall Renovation - Signage                     │ │
│  │ PlanHub · Due Jan 20 · Sacramento, CA                      │ │
│  │ [Specs]                                         [View →]   │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Bid Detail
- Project info (title, address, due date, source link)
- Status dropdown (New → Reviewing → Bidding → Won/Lost/Passed)
- Relevance breakdown (keywords matched, which docs)
- Document list with download + preview
- "Open in [Platform]" button

### Connections
- List of connected accounts with status
- Connect buttons for each platform
- Last synced timestamp
- Manual "Sync Now" per connection

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Next.js app with NextAuth (Gmail OAuth)
- [ ] Postgres schema with Drizzle
- [ ] Connection management UI (add/remove platforms)
- [ ] Credential encryption utilities

### Phase 2: Platform Integrations
- [ ] PlanetBids scraper (port existing)
- [ ] Gmail sync (bid invite emails)
- [ ] PlanHub sync (login + scrape)
- [ ] BuildingConnected sync (login + scrape)

### Phase 3: Document Pipeline
- [ ] Document download jobs
- [ ] PDF text extraction
- [ ] Relevance scoring v1 (keywords)
- [ ] Storage integration

### Phase 4: Dashboard
- [ ] Bid inbox view
- [ ] Bid detail view
- [ ] Connections view
- [ ] Settings view

### Phase 5: Polish
- [ ] Error handling and retries
- [ ] Sync status visibility
- [ ] Manual sync triggers
- [ ] Basic analytics

---

## Future Enhancements

- [ ] Smarter relevance scoring (ML/LLM-based)
- [ ] Email/SMS alerts for high-relevance bids
- [ ] More platforms (Dodge, ConstructConnect, etc.)
- [ ] Takeoff generation from documents
- [ ] AI chat with bid documents
