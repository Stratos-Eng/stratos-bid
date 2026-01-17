# Stratos Bid Platform

## What is Stratos?

Stratos is an **AI-native preconstruction platform** for specialty trade subcontractors (glazing, signage). The core value proposition is: **"Fewer misses. Tighter bids. More wins."**

The platform helps subcontractors:
1. **Centralize bid intake** from multiple platforms
2. **Auto-generate takeoffs** from construction documents
3. **Filter noise** to surface only relevant opportunities
4. **Win more bids** with better information, faster

## Architecture Overview

This is a **Next.js 16 full-stack application** using:
- **Database**: PostgreSQL with Drizzle ORM
- **Auth**: NextAuth 5 with Google OAuth
- **Background Jobs**: Inngest
- **PDF Processing**: pdf.js (client) + PyMuPDF (Python service)
- **Browser Automation**: Playwright

```
┌─────────────────────────────────────────────────────────────────────┐
│                         STRATOS-BID                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  NEXT.JS APP (src/app/)                                            │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Dashboard      │  Takeoff Tool  │  Connections Manager     │   │
│  │  /              │  /takeoff/*    │  /connections            │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│  API ROUTES (src/app/api/)   ▼                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  /api/takeoff/*     PDF upload, vector extraction, render   │   │
│  │  /api/connections/* Platform connection management          │   │
│  │  /api/sync/*        Background sync triggers                │   │
│  │  /api/documents/*   Document viewing/download               │   │
│  │  /api/inngest       Background job webhook                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│  SCRAPERS (src/scrapers/)    ▼                                     │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────┐              │
│  │ PlanetBids │  │  PlanHub   │  │ BuildingConnected│              │
│  │  (working) │  │  (partial) │  │   (implemented)  │              │
│  └────────────┘  └────────────┘  └─────────────────┘              │
│                              │                                      │
│  PYTHON SERVICE (services/vector-extractor/)                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  FastAPI + PyMuPDF for vector extraction from PDFs          │   │
│  │  POST / - Extract vectors (base64 PDF → lines + snap points)│   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
stratos-bid/
├── src/
│   ├── app/
│   │   ├── (dashboard)/        # Main app pages
│   │   │   ├── takeoff/        # Takeoff tool (PDF viewer + measurements)
│   │   │   ├── connections/    # Platform connection management
│   │   │   └── page.tsx        # Dashboard home
│   │   ├── api/
│   │   │   ├── takeoff/        # Takeoff API (upload, vectors, render, export)
│   │   │   ├── connections/    # Connection CRUD
│   │   │   ├── documents/      # Document viewing
│   │   │   ├── sync/           # Sync triggers
│   │   │   ├── inngest/        # Background job webhook
│   │   │   ├── extension/      # Chrome extension endpoints
│   │   │   └── auth/           # NextAuth endpoints
│   │   └── extension/          # Extension connection page
│   ├── components/
│   │   ├── takeoff/            # PDF viewer, sheet panel, measurement tools
│   │   ├── upload/             # Chunked upload components
│   │   └── ui/                 # Shared UI components
│   ├── scrapers/               # Platform-specific scrapers
│   │   ├── base.ts             # Base scraper with Claude agent fallback
│   │   ├── planetbids.ts       # PlanetBids (public portals, working)
│   │   ├── planhub.ts          # PlanHub (login issues)
│   │   └── buildingconnected.ts # BuildingConnected (implemented)
│   ├── db/
│   │   └── schema.ts           # Drizzle schema (PostgreSQL)
│   ├── inngest/                # Background job definitions
│   ├── lib/
│   │   ├── auth.ts             # NextAuth config
│   │   ├── crypto.ts           # Credential encryption
│   │   ├── browser-agent.ts    # Claude agent for browser automation
│   │   └── validations/        # Zod schemas
│   └── hooks/                  # React hooks (chunked upload, etc.)
├── services/
│   └── vector-extractor/       # Python FastAPI service
│       ├── src/
│       │   ├── main.py         # FastAPI app
│       │   ├── extractor.py    # PyMuPDF extraction logic
│       │   └── geometry.py     # Geometry utilities
│       ├── pyproject.toml      # Python dependencies
│       └── README.md           # Service documentation
├── drizzle/                    # Database migrations
├── uploads/                    # Uploaded PDFs (gitignored)
├── screenshots/                # Debug screenshots from scrapers
└── docs/plans/                 # Architecture docs
```

## Platform Scrapers

| Platform | Status | Auth | Notes |
|----------|--------|------|-------|
| **PlanetBids** | ✅ Working | Per-portal (no login) | Public gov bids, uses portal IDs |
| **PlanHub** | ⚠️ Partial | Email/password | Login fragile, needs testing |
| **BuildingConnected** | ✅ Implemented | Email/password + Autodesk SSO | Full implementation with SSO support |
| **Gmail** | 🚧 Partial | OAuth | Bid invite email parsing |

## Key Features

### Takeoff Tool
- PDF upload with chunked streaming (handles large files)
- Page-by-page rendering with OpenLayers
- Vector extraction for snapping (lines, endpoints, midpoints, intersections)
- Measurement tools (coming soon)
- Export to Excel

### Vector Extraction
The system has dual-mode vector extraction:

1. **Python Service (PyMuPDF)** - Higher quality, more accurate
   - Run: `cd services/vector-extractor && uvicorn src.main:app --port 8001`
   - Set: `PYTHON_VECTOR_API_URL=http://localhost:8001`

2. **pdf.js fallback** - Built into Next.js, always available
   - Used when Python service is unavailable
   - Lower quality but works everywhere

### Background Jobs (Inngest)
- `dailySync` - Runs at 6 AM, syncs all users
- `syncUser` - Syncs all connections for a user
- `syncConnection` - Syncs a single platform connection

## Development

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your credentials

# Run database migrations
npx drizzle-kit push

# Start development server
npm run dev

# Start Python vector service (optional, for better extraction)
cd services/vector-extractor
pip install -e .
uvicorn src.main:app --port 8001
```

## Environment Variables

```bash
# Database (PostgreSQL required)
DATABASE_URL=postgresql://user:password@localhost:5432/stratos_bid
ENCRYPTION_KEY=<64-char hex string>

# NextAuth
NEXTAUTH_SECRET=<random string>
NEXTAUTH_URL=http://localhost:3000

# Google OAuth (required for auth)
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>

# Inngest (for background jobs)
INNGEST_EVENT_KEY=<from Inngest dashboard>
INNGEST_SIGNING_KEY=<from Inngest dashboard>

# Python Vector Service (optional)
PYTHON_VECTOR_API_URL=http://localhost:8001

# Chrome Extension (optional)
EXTENSION_TOKEN_SECRET=<random string>
```

## API Routes

### Takeoff
- `POST /api/takeoff/upload` - Upload PDF
- `GET/POST /api/takeoff/vectors` - Extract/get vectors for sheet
- `GET /api/takeoff/render` - Render PDF page as image
- `GET /api/takeoff/projects` - List projects
- `POST /api/takeoff/measurements` - Save measurements
- `GET /api/takeoff/export` - Export to Excel

### Connections
- `GET/POST /api/connections` - CRUD for platform connections
- `POST /api/sync` - Trigger manual sync

### Upload (Chunked)
- `POST /api/upload/init` - Start upload session
- `PUT /api/upload/chunk` - Upload chunk
- `POST /api/upload/complete` - Finalize upload

## Database Schema

Key tables:
- `users` - NextAuth users
- `connections` - Platform connections (encrypted credentials)
- `bids` - Scraped bid opportunities
- `documents` - Downloaded bid documents
- `syncJobs` - Sync job tracking
- `takeoffProjects` - Takeoff projects
- `takeoffSheets` - PDF sheets within projects
- `sheetVectors` - Extracted vectors per sheet
- `takeoffMeasurements` - User measurements

## Testing

```bash
# Run Playwright tests
npm test

# Run with UI
npm run test:ui

# Run headed (see browser)
npm run test:headed
```

## Known Issues

1. **PlanHub login** - Frequently fails, may need captcha handling
2. **Python service deployment** - Not yet deployed to production
3. **Large PDF memory** - Very large PDFs may cause memory issues

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
