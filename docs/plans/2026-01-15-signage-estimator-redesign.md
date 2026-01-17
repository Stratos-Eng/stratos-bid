# Signage Estimator Redesign

## Overview

Streamline the Stratos platform to focus on the core workflow for sign shop operators:

```
Upload PDFs → AI extracts sign items → User verifies/edits → Export to Excel
```

## Core Workflow

### 1. Upload Flow

**Entry point:** `/projects/new`

1. Drop zone for PDF or folder of PDFs
2. Chunked upload with progress bar
3. Tile generation runs on upload complete (for snappy viewing)
4. AI extraction triggers automatically
5. Redirect to verification view

### 2. AI Extraction (Existing - Keep)

Two-pass signage extraction:
- **Pass 1:** Legend detection + room counting (deterministic, fast)
- **Pass 2:** AI extraction with context (Claude analyzes relevant pages)

Output: `lineItems` table with description, quantity, unit, page number, symbol code, confidence

### 3. Verification UI

**Layout:**
```
┌──────────────────────────────────────────────────────────────────────────┐
│  Project: Great Parks Community Center          [Export] [Settings]      │
├─────┬────────────────────────────────────────────────────────────────────┤
│     │                                                        ┌─────────┐ │
│ ┌─┐ │                    PDF PAGE                            │ TS-01   │ │
│ │1│ │                                                        │ Tactile │ │
│ └─┘ │      ┌──────┐                                          │ Exit    │ │
│ ┌─┐ │      │ •TS01│ ←── inline marker                        │ Qty: 4  │ │
│ │2│ │      └──────┘                                          │         │ │
│ └─┘ │                        ┌──────┐                        │[Approve]│ │
│ ┌─┐ │                        │ •RR  │                        │[Edit]   │ │
│ │3│ │                        └──────┘                        │[Skip]   │ │
│ └─┘ │                                                        └─────────┘ │
│ ... │                    [+] click to add                     slide-out  │
│     │                                                           panel    │
├─────┴────────────────────────────────────────────────────────────────────┤
│  Page 3 of 47  │  Zoom: [−][100%][+]  │  15 items │ 8 approved │ 2 skip  │
└──────────────────────────────────────────────────────────────────────────┘
```

**Components:**
- **Filmstrip sidebar:** Vertical thumbnails, click to jump
- **PDF viewer:** OpenLayers with tile-based rendering, smooth zoom/pan
- **Inline markers:** Findings shown as pins on PDF pages
- **Slide-out panel:** Details + actions when marker clicked
- **Quick Add:** Click anywhere on PDF → popup form

**Actions per item:**
- **Approve** - Accept as-is
- **Edit** - Modify quantity/description, then approve
- **Skip** - Move past, come back later
- **Add** - Click on PDF, fill minimal form (description, qty, unit)

**Keyboard shortcuts:**
- `←/→` - Previous/next page
- `A` - Approve current item
- `E` - Edit current item
- `S` - Skip current item
- `+/-` - Zoom in/out

### 4. Data Model (Keep Current)

Line items:
- `description` - e.g., "Tactile Exit Sign"
- `estimatedQty` - quantity
- `unit` - EA, SF, LF
- `pageNumber` - source page
- `symbolCode` - e.g., "TS-01"
- `notes` - optional
- `extractionConfidence` - 0-1 from AI
- `reviewStatus` - pending/approved/skipped

### 5. Export

Excel export with approved items for estimation in external tools.

---

## Code Changes

### Remove

| File/Directory | Lines | Reason |
|----------------|-------|--------|
| `src/lib/browser-agent.ts` | 424 | Premature AI complexity |
| `src/lib/scrapers/base.ts` | 247 | Duplicate (keep `src/scrapers/base.ts`) |
| `src/scrapers/planhub.ts` | ~400 | Broken, not validated |
| `src/lib/extension-auth.ts` | ~150 | No extension exists |
| `src/lib/crypto.ts` | 78 | Duplicate (keep `encryption.ts`) |
| `src/extraction/prompts/glazing.ts` | ~100 | Not signage |
| `src/app/api/extension/*` | ~100 | No extension exists |
| `src/components/verification/tile-viewer.tsx` | 149 | Use openlayers version |

### Simplify

| File | Action |
|------|--------|
| `src/scrapers/gmail.ts` | Reduce to stub (~50 lines) or delete |
| `src/scrapers/base.ts` | Remove Claude agent fallback methods |

### Keep (Hidden from UI)

| File | Reason |
|------|--------|
| `src/components/takeoff/*` | Measurement tools for future |
| `src/app/(dashboard)/takeoff/*` | Remove from nav, keep code |
| `src/lib/stores/takeoff-store.ts` | May reuse patterns |

### Keep (Core)

| File/Directory | Reason |
|----------------|--------|
| `src/extraction/signage/*` | Core AI extraction |
| `src/lib/tile-generator.ts` | Tile generation for snappy viewing |
| `src/components/verification/openlayers-tile-viewer.tsx` | Base for PDF viewer |
| `src/inngest/functions.ts` | Background jobs (extraction, tiles) |

### New/Modified Files

| File | Purpose |
|------|---------|
| `src/app/(dashboard)/projects/new/page.tsx` | Upload flow |
| `src/app/(dashboard)/projects/[id]/page.tsx` | Verification UI |
| `src/components/viewer/pdf-viewer.tsx` | Unified tile-based viewer |
| `src/components/viewer/filmstrip.tsx` | Thumbnail sidebar |
| `src/components/viewer/finding-marker.tsx` | Inline markers |
| `src/components/viewer/item-panel.tsx` | Slide-out detail panel |
| `src/components/viewer/quick-add-form.tsx` | Click-to-add popup |

---

## Implementation Phases

### Phase 1: Cleanup
- [ ] Delete identified files
- [ ] Simplify gmail scraper
- [ ] Remove takeoff from navigation
- [ ] Verify tile generation works

### Phase 2: Upload Flow
- [ ] Create `/projects/new` page
- [ ] Wire up chunked upload
- [ ] Trigger tile generation on upload
- [ ] Trigger AI extraction on upload
- [ ] Show progress UI

### Phase 3: Verification UI
- [ ] Build filmstrip component
- [ ] Extend openlayers viewer with marker support
- [ ] Build slide-out panel component
- [ ] Build quick-add form
- [ ] Wire up approve/edit/skip actions
- [ ] Add keyboard shortcuts

### Phase 4: Polish
- [ ] Loading states
- [ ] Error handling
- [ ] Export flow
- [ ] Mobile responsiveness (if needed)

---

## Future (Out of Scope)

- Scraper integrations (scaffolding kept)
- Manual measurement tools (code kept, UI hidden)
- Multi-user collaboration
- Pricing/estimation inline
