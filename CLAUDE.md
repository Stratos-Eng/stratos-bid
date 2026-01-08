# Stratos Bid Aggregator

## What is Stratos?

Stratos is an **AI-native preconstruction platform** for specialty trade subcontractors (glazing, signage). The core value proposition is: **"Fewer misses. Tighter bids. More wins."**

The platform helps subcontractors:
1. **Centralize bid intake** from multiple platforms
2. **Auto-generate takeoffs** from construction documents
3. **Filter noise** to surface only relevant opportunities
4. **Win more bids** with better information, faster

## What is stratos-bid?

This repo is the **bid aggregation engine** — the system that scrapes, normalizes, and processes bid opportunities from multiple platforms into a unified database.

### Platforms to Support

| Platform | Type | Auth | Status |
|----------|------|------|--------|
| **PlanetBids** | Public/Gov bids | Per-portal registration | ✅ Working |
| **PlanHub** | Commercial bids | Email/password login | 🚧 Stub created |
| **BuildingConnected** | Commercial bids | Email/password login | 🚧 Stub created |

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                       STRATOS-BID                              │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   SCRAPERS (src/scrapers/)                                     │
│   ┌────────────┐  ┌────────────┐  ┌─────────────────┐         │
│   │ PlanetBids │  │  PlanHub   │  │ BuildingConnected│         │
│   └─────┬──────┘  └─────┬──────┘  └───────┬─────────┘         │
│         └───────────────┼─────────────────┘                   │
│                         ▼                                      │
│   ┌─────────────────────────────────────────┐                 │
│   │           UNIFIED BID SCHEMA            │                 │
│   │  (src/db/schema.ts)                     │                 │
│   └─────────────────────┬───────────────────┘                 │
│                         ▼                                      │
│   ┌─────────────────────────────────────────┐                 │
│   │            SQLite DATABASE              │                 │
│   │  • bids     • documents    • sources    │                 │
│   └─────────────────────┬───────────────────┘                 │
│                         ▼                                      │
│   ┌─────────────────────────────────────────┐                 │
│   │         DOC PIPELINE (TODO)             │                 │
│   │  • PDF download   • Text extraction     │                 │
│   │  • Trade classification                 │                 │
│   │  • Relevance scoring                    │                 │
│   └─────────────────────┬───────────────────┘                 │
│                         ▼                                      │
│   ┌─────────────────────────────────────────┐                 │
│   │           DASHBOARD (TODO)              │                 │
│   │  • View bids   • Filter   • Download    │                 │
│   └─────────────────────────────────────────┘                 │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
stratos-bid/
├── src/
│   ├── scrapers/           # Platform-specific scrapers
│   │   ├── base.ts         # Base scraper class
│   │   ├── planetbids.ts   # PlanetBids scraper (working)
│   │   ├── planhub.ts      # PlanHub scraper (stub)
│   │   └── buildingconnected.ts  # BC scraper (stub)
│   ├── pipeline/           # Document processing (TODO)
│   ├── db/
│   │   └── schema.ts       # Database schema + operations
│   ├── api/                # API routes (TODO)
│   ├── dashboard/          # Web UI (TODO)
│   └── cli.ts              # CLI entry point
├── docs/
│   └── pdfs/               # Downloaded bid documents
├── screenshots/            # Debug screenshots from scrapers
├── .env                    # Credentials (gitignored)
├── .env.example            # Credential template
└── stratos-bid.db          # SQLite database (gitignored)
```

## CLI Commands

```bash
# Seed California PlanetBids portals
npm run seed

# Scrape all platforms
npm run scrape

# Scrape specific platform
npm run cli -- scrape planetbids
npm run cli -- scrape planetbids 14319  # Specific portal

# List data
npm run cli -- list bids
npm run cli -- list sources
```

## Unified Bid Schema

All bids from all platforms are normalized to this schema:

| Field | Type | Description |
|-------|------|-------------|
| `id` | TEXT | `{source_type}-{source_id}-{bid_id}` |
| `source_type` | TEXT | `planetbids`, `planhub`, `buildingconnected` |
| `source_id` | TEXT | Portal/account identifier |
| `source_bid_id` | TEXT | Original ID from platform |
| `title` | TEXT | Bid/project title |
| `description` | TEXT | Full description |
| `bid_number` | TEXT | Official bid number |
| `status` | TEXT | `open`, `closed`, `awarded` |
| `posted_date` | DATETIME | When bid was posted |
| `due_date` | DATETIME | Bid submission deadline |
| `city` | TEXT | City location |
| `state` | TEXT | State (e.g., `CA`) |
| `relevance_score` | REAL | 0-1 computed relevance |
| `source_url` | TEXT | Link to original bid |
| `raw_json` | TEXT | Platform-specific raw data |

## MVP Roadmap

### Phase 1: Core Aggregation (Current)
- [x] PlanetBids scraper
- [ ] PlanHub scraper
- [ ] BuildingConnected scraper
- [ ] Document download pipeline
- [ ] Basic relevance scoring (keywords + Division 08)

### Phase 2: Intelligence
- [ ] PDF text extraction
- [ ] Trade classification (glazing, signage, etc.)
- [ ] Improved relevance scoring

### Phase 3: Interface
- [ ] Simple dashboard to view/filter bids
- [ ] Document viewer

### Phase 4: Scale
- [ ] More platforms
- [ ] Cron scheduling
- [ ] Notifications

## Trade Keywords for Relevance

**Glazing:**
- glazing, glass, window, curtain wall, storefront
- Division 08, 08 40 00, 08 44 00, 08 80 00

**Signage:**
- signage, sign, wayfinding, ADA signs, monument sign
- Division 10, 10 14 00

## PlanetBids Portal IDs (California)

| ID | Agency |
|----|--------|
| 14319 | Kern High School District |
| 21372 | Los Angeles Community College District |
| 15300 | City of Sacramento |
| 14769 | City of Fresno |
| 47426 | City of Torrance |
| 65093 | City of Santa Fe Springs |
| 24103 | City of National City |
| 16151 | Los Angeles Area Agency |

## Environment Variables

```bash
# PlanetBids (registration-based, not login)
PLANETBIDS_COMPANY_NAME=
PLANETBIDS_FEI_SSN=
PLANETBIDS_EMAIL=

# PlanHub
PLANHUB_EMAIL=
PLANHUB_PASSWORD=

# BuildingConnected
BUILDINGCONNECTED_EMAIL=
BUILDINGCONNECTED_PASSWORD=

# Configuration
TRADES=glazing,signage
STATES=CA
```

## Key Decisions Made

1. **SQLite over Postgres** — Simpler for MVP, can migrate later
2. **Visible browser (headless: false)** — PlanetBids blocks headless
3. **Per-platform scrapers** — Not a generic plugin system yet
4. **PDFs only** — Skip DWG/RVT parsing for MVP
5. **Keyword relevance** — Start simple before ML classification

## Design Document

See [docs/plans/2026-01-07-stratos-bid-architecture.md](docs/plans/2026-01-07-stratos-bid-architecture.md) for the full architecture design including:
- Tech stack decisions
- Data model
- Auth & connection flows
- Background job system (Inngest)
- Document pipeline
- Dashboard UI wireframes
- Implementation phases

## Implementation Phases

### Phase 1: Foundation
- [ ] Next.js app with NextAuth (Gmail OAuth)
- [ ] Postgres schema with Drizzle
- [ ] Connection management UI
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

### Phase 4: Dashboard
- [ ] Bid inbox view
- [ ] Bid detail view
- [ ] Connections view

### Phase 5: Polish
- [ ] Error handling and retries
- [ ] Sync status visibility
- [ ] Manual sync triggers

## Future Enhancements

- [ ] Smarter relevance scoring (ML/LLM-based)
- [ ] Email/SMS alerts
- [ ] More platforms
- [ ] Takeoff generation
- [ ] AI chat with documents
