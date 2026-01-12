# Takeoff Platform Architecture

Best-in-class solution for fast, accurate construction takeoffs.

**Business Model**: Service built on platform (operators doing takeoffs)
**Priority**: UX + service first, AI later
**Goal**: Optimize for speed

---

## Table of Contents

1. [Time Analysis](#time-analysis)
2. [System Architecture](#system-architecture)
3. [Module 1: PDF Processing Pipeline](#module-1-pdf-processing-pipeline)
4. [Module 2: Display & Navigation](#module-2-display--navigation)
5. [Module 3: Scale System](#module-3-scale-system)
6. [Module 4: Measurement & Snapping](#module-4-measurement--snapping)
7. [Module 5: Takeoff Data Panel](#module-5-takeoff-data-panel)
8. [Module 6: Symbol Library & Find Similar](#module-6-symbol-library--find-similar)
9. [Module 7: Keyboard-First Design](#module-7-keyboard-first-design)
10. [Module 8: Export System](#module-8-export-system)
11. [Data Model](#data-model)
12. [Implementation Phases](#implementation-phases)
13. [Scope Cutting Guide](#scope-cutting-guide)

---

## Time Analysis

What makes takeoffs slow:

| Activity | Time | Pain Level | Fixable? |
|----------|------|------------|----------|
| Document navigation (find sheet) | 10% | Medium | YES |
| Understanding drawing | 20% | High | Partially (AI) |
| Scale setup/calibration | 5% | High | YES |
| Precision clicking (zoom/place) | 25% | High | YES (snapping) |
| Repetitive counting (same symbol) | 15% | High | YES |
| Data entry (descriptions, codes) | 10% | Medium | YES |
| Context switching (drawing↔data) | 10% | Medium | YES |
| QA/Review | 5% | Low | YES |

**Biggest wins**: Precision clicking (25%) + Repetitive counting (15%) = 40% of time, highly fixable

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SYSTEM ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                        FRONTEND                                  │    │
│  │                                                                  │    │
│  │   React + TypeScript                                             │    │
│  │   ├── OpenLayers (map engine)                                    │    │
│  │   │   ├── TileLayer (PDF display)                                │    │
│  │   │   ├── VectorLayer (annotations)                              │    │
│  │   │   └── SnapLayer (PDF geometry - invisible)                   │    │
│  │   ├── Zustand (state management)                                 │    │
│  │   ├── React Query (server state)                                 │    │
│  │   └── Keyboard-first interaction design                          │    │
│  │                                                                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                        BACKEND                                   │    │
│  │                                                                  │    │
│  │   Python + FastAPI                                               │    │
│  │   ├── PDF Processing Service (PyMuPDF)                           │    │
│  │   │   ├── Tile generation                                        │    │
│  │   │   ├── Vector extraction + cleaning                           │    │
│  │   │   ├── Text extraction (OCR where needed)                     │    │
│  │   │   └── Metadata extraction                                    │    │
│  │   ├── Project/Annotation Service                                 │    │
│  │   ├── Export Service                                             │    │
│  │   └── (Future) AI Service                                        │    │
│  │                                                                  │    │
│  │   Celery + Redis (async task queue)                              │    │
│  │                                                                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                              │                                           │
│                              ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                        STORAGE                                   │    │
│  │                                                                  │    │
│  │   PostgreSQL + PostGIS                                           │    │
│  │   ├── Projects, sheets, annotations (GeoJSON)                    │    │
│  │   ├── Vector geometry (for snapping)                             │    │
│  │   ├── User/org data                                              │    │
│  │   └── Audit log                                                  │    │
│  │                                                                  │    │
│  │   S3/GCS                                                         │    │
│  │   ├── Original PDFs                                              │    │
│  │   ├── Generated tiles                                            │    │
│  │   └── Exports                                                    │    │
│  │                                                                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tech Stack Summary

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Frontend Framework | React + TypeScript | Industry standard, strong typing |
| Map Engine | OpenLayers | Battle-tested for tile-based maps, good drawing tools |
| State Management | Zustand | Simple, performant, less boilerplate than Redux |
| Server State | React Query | Caching, sync, optimistic updates |
| Backend | Python + FastAPI | Async support, great for PDF processing |
| PDF Processing | PyMuPDF | Best Python library for PDF manipulation |
| Task Queue | Celery + Redis | Reliable async processing |
| Database | PostgreSQL + PostGIS | Spatial queries for geometry |
| File Storage | S3/GCS | Scalable, CDN-friendly |

---

## Module 1: PDF Processing Pipeline

**Goal**: Fast upload → immediately usable, with progressive enhancement

### Processing Phases

```
PHASE 1: Immediate (< 5 seconds)
├── Extract page count, dimensions
├── Generate low-res thumbnails (for sheet list)
├── Extract text layer (for search)
└── User can START browsing sheets

PHASE 2: Fast (< 30 seconds per sheet)
├── Generate tiles at zoom levels 0-4
├── Run scale detection (multiple methods)
└── User can START measuring on processed sheets

PHASE 3: Background (< 2 minutes per sheet)
├── Extract vectors
├── Clean vectors (filter noise, merge segments)
├── Classify vector quality (good/medium/poor/none)
├── Generate snap geometry
└── Snapping becomes available when ready

PHASE 4: Optional (AI - future)
├── Sheet classification
├── Symbol detection
└── Element detection
```

### Vector Extraction & Cleaning

```python
def extract_and_clean_vectors(page, dpi=150):
    """
    Extract vectors from PDF page, clean them for snapping use.
    """
    raw_paths = []

    # Extract all paths using PyMuPDF
    for item in page.get_drawings():
        if item["type"] == "l":  # line
            raw_paths.append({
                "type": "line",
                "start": item["points"][0],
                "end": item["points"][1],
                "width": item.get("width", 1)
            })
        elif item["type"] == "re":  # rectangle
            raw_paths.append({
                "type": "rect",
                "rect": item["rect"]
            })
        # ... handle curves, polygons, etc.

    # CLEANING PHASE
    cleaned = []

    for path in raw_paths:
        # Filter 1: Minimum length (remove tiny fragments)
        if path["type"] == "line":
            length = distance(path["start"], path["end"])
            if length < 5:  # Less than 5 pixels
                continue

        # Filter 2: Remove likely hatching (many parallel short lines)
        # (implement hatching detection heuristic)

        # Filter 3: Merge collinear segments
        # (if line A end ≈ line B start and same angle, merge)

        cleaned.append(path)

    # Build snap points
    snap_points = []

    for path in cleaned:
        if path["type"] == "line":
            # Endpoints
            snap_points.append({"type": "endpoint", "coords": path["start"]})
            snap_points.append({"type": "endpoint", "coords": path["end"]})
            # Midpoint
            mid = midpoint(path["start"], path["end"])
            snap_points.append({"type": "midpoint", "coords": mid})

    # Find intersections
    for i, path1 in enumerate(cleaned):
        for path2 in cleaned[i+1:]:
            intersection = find_intersection(path1, path2)
            if intersection:
                snap_points.append({"type": "intersection", "coords": intersection})

    # Dedupe nearby points (within 2px)
    snap_points = dedupe_nearby(snap_points, tolerance=2)

    # Assess quality
    quality = assess_vector_quality(raw_paths, cleaned)
    # "good" = >70% of paths survived cleaning, reasonable density
    # "medium" = 30-70% survived
    # "poor" = <30% survived or too dense (likely garbage)
    # "none" = no vectors found (scanned PDF)

    return {
        "lines": cleaned,
        "snap_points": snap_points,
        "quality": quality
    }
```

### Tile Generation

```python
def generate_tiles(page, sheet_id, output_bucket):
    """
    Generate map tiles for a PDF page.
    """
    # Render at high DPI for quality
    dpi = 150
    pix = page.get_pixmap(dpi=dpi)

    tile_size = 256
    max_zoom = calculate_max_zoom(pix.width, pix.height, tile_size)

    for zoom in range(max_zoom + 1):
        scale = 2 ** (max_zoom - zoom)
        scaled_width = pix.width // scale
        scaled_height = pix.height // scale

        # Resize for this zoom level
        scaled_image = resize(pix, scaled_width, scaled_height)

        # Cut into tiles
        cols = math.ceil(scaled_width / tile_size)
        rows = math.ceil(scaled_height / tile_size)

        for x in range(cols):
            for y in range(rows):
                tile = crop(scaled_image,
                           x * tile_size,
                           y * tile_size,
                           tile_size,
                           tile_size)

                # Upload to storage
                path = f"tiles/{sheet_id}/{zoom}/{x}/{y}.png"
                upload_to_bucket(output_bucket, path, tile)

    return f"https://cdn.example.com/tiles/{sheet_id}/{{z}}/{{x}}/{{y}}.png"
```

---

## Module 2: Display & Navigation

**Goal**: Instant, fluid navigation through large document sets

### Sheet Panel Design

```
┌─────────────────────────────────────────────────────────────────┐
│  SHEET PANEL (left sidebar)                                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  🔍 Search sheets...                     [Filter ▼]             │
│  ─────────────────────────────────────────────────              │
│                                                                  │
│  📁 Architectural (12 sheets)                    [▼]            │
│     ┌──────┐ A1.0 - Cover Sheet                                 │
│     │thumb │ Scale: N/A │ 0 items                               │
│     └──────┘                                                    │
│     ┌──────┐ A2.1 - Floor Plan Level 1          ← ACTIVE        │
│     │thumb │ Scale: 1/4"=1'-0" │ 47 items       [✓ snapping]   │
│     └──────┘                                                    │
│     ┌──────┐ A2.2 - Floor Plan Level 2                          │
│     │thumb │ Scale: 1/4"=1'-0" │ 0 items        [processing...] │
│     └──────┘                                                    │
│                                                                  │
│  📁 Electrical (8 sheets)                        [▶]            │
│  📁 Mechanical (15 sheets)                       [▶]            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

KEY FEATURES:
• Auto-categorize sheets by prefix (A=Arch, E=Elec, M=Mech)
• Show scale per sheet
• Show item count per sheet
• Show vector/snap availability
• Pre-load adjacent sheets for instant switching
• Keyboard: ↑↓ to navigate, Enter to select
```

### Tile Loading Strategy

```
PRIORITY 1: Current viewport
• Load tiles for what user is looking at RIGHT NOW
• Start with low-res, upgrade to high-res

PRIORITY 2: Adjacent tiles
• Pre-load tiles just outside viewport
• Smooth panning without loading flicker

PRIORITY 3: Next/prev sheets
• Pre-load thumbnails and zoom-0 tiles for adjacent sheets
• Instant sheet switching

PRIORITY 4: All sheets at zoom-0
• Background load overview of all sheets
• Fast navigation to any sheet

CACHING:
• IndexedDB for tile cache (persist across sessions)
• LRU eviction when cache exceeds 500MB
• Cache key: {project_id}/{sheet_id}/{z}/{x}/{y}
```

---

## Module 3: Scale System

**Goal**: Get scale right the first time, every time

### Auto-Detection Methods

| Method | How It Works | Confidence |
|--------|--------------|------------|
| Title block OCR | Find title block, OCR for "SCALE: 1/4" = 1'-0"" | HIGH if found |
| Scale bar detection | Find graphical scale bar, measure pixels, OCR label | HIGH if found |
| Dimension sampling | Find dimension labels, measure leader lines, calculate | MEDIUM |
| Sheet name heuristics | "DETAIL" = large scale, "FLOOR PLAN" = small scale | LOW (fallback) |

### Manual Calibration UX

```
1. User clicks "Calibrate Scale" or presses 'C'

2. Prompt: "Click two points of a known distance"
   • Snapping enabled (use PDF vectors or grid)
   • Show rubber-band line as user draws

3. User enters distance: [___24___] ft [___6___] in
   • Smart parsing: "24'6", "24-6", "24.5'" all work

4. System calculates and shows verification:
   "At this scale, a 10' line would be [===] this long"
   • Visual sanity check

5. Apply to: [This sheet only] [All similar sheets] [All]
```

### Scale Inheritance

- Sheets with same prefix (A2.1, A2.2) likely same scale
- When user sets scale on A2.1, offer to apply to A2.x series
- Track scale "confidence" per sheet
- Low confidence = show warning icon

---

## Module 4: Measurement & Snapping

**Goal**: One click = precise measurement, every time

### Snap Sources (Priority Order)

| Priority | Source | Description |
|----------|--------|-------------|
| 1 | Active drawing | When drawing a polygon, snap to your own vertices |
| 2 | Existing annotations | Other measurements you've placed |
| 3 | PDF vectors | Endpoints, midpoints, intersections (when quality is good) |
| 4 | Grid | Optional, user-enabled |

### Snap Types

| Icon | Type | Description |
|------|------|-------------|
| ● | Endpoint | Corners, line ends |
| ◆ | Midpoint | Center of line |
| ╳ | Intersection | Where lines cross |
| ┴ | Perpendicular | 90° from reference |
| ○ | On-line | Any point on line |
| ◎ | Center | Center of shape |

### Visual Feedback

```
As cursor approaches snap point:

   No snap nearby          Snap available          Snapped
   ┌───────────┐          ┌───────────┐          ┌───────────┐
   │           │          │     □     │          │     ■     │
   │     +     │          │     +     │          │     ■     │
   │           │          │           │          │           │
   └───────────┘          └───────────┘          └───────────┘
   Normal cursor          Indicator appears      Cursor snaps
                          (different shape       Click lands
                           for snap type)        at snap point

ALSO: Highlight the source geometry (line lights up)
```

### Keyboard Modifiers

| Key | Action |
|-----|--------|
| SHIFT | Constrain to horizontal/vertical |
| ALT | Temporarily disable snapping |
| CTRL | Snap to grid only |
| TAB | Cycle through nearby snap points |

### Measurement Tools

```
TOOLBAR (left edge or floating)
┌────┐
│ ➤  │  Select (V)         - Select/edit existing measurements
├────┤
│ ●  │  Count (C)          - Single click to place count marker
├────┤
│ /  │  Linear (L)         - Click-click for line, shows length
├────┤
│ ▭  │  Area (A)           - Click vertices, double-click to close
├────┤
│ □  │  Rectangle (R)      - Click-drag for rectangular area
├────┤
│ ○  │  Circle (O)         - Click center, drag radius
├────┤
│ ⊞  │  Multi-count (M)    - Rectangle select to count items inside
└────┘
```

### Smart Behaviors

- Auto-close polygon when clicking near start point
- Show running total while drawing (area updates live)
- Double-click to finish multi-segment line
- ESC to cancel current drawing
- Right-click to undo last point
- ENTER to finish and immediately start new measurement

---

## Module 5: Takeoff Data Panel

**Goal**: Always see your data, always in sync with the drawing

### Panel Design

```
┌─────────────────────────────────────────────────────────────────┐
│  PROJECT: ABC Office Building                      [Export ▼]   │
│  ─────────────────────────────────────────────────────────────  │
│                                                                  │
│  🔍 Search items...                    [+ New Category]         │
│                                                                  │
│  ─────────────────────────────────────────────────────────────  │
│                                                                  │
│  📁 ELECTRICAL                                         142 EA   │
│  │                                                               │
│  ├─ Duplex Outlet (20A)                                47 EA    │
│  │  └─ A2.1: 23  │  A2.2: 18  │  A2.3: 6              [👁 ✎ 🗑] │
│  │                                                               │
│  ├─ GFCI Outlet                                        12 EA    │
│  │  └─ A2.1: 8   │  A2.2: 4                           [👁 ✎ 🗑] │
│  │                                                               │
│  ├─ Recessed Downlight                                 67 EA    │
│  │  └─ A2.1: 34  │  A2.2: 33                          [👁 ✎ 🗑] │
│  │                                                               │
│  └─ Panel (200A)                                        2 EA    │
│     └─ A2.1: 1   │  A2.2: 1                           [👁 ✎ 🗑] │
│                                                                  │
│  📁 DRYWALL                                          4,892 SF   │
│  │                                                               │
│  ├─ Wall Type A (5/8" GWB)                          2,341 SF    │
│  │  └─ 847 LF perimeter  │  12 openings              [👁 ✎ 🗑] │
│  │                                                               │
│  └─ Ceiling (5/8" GWB)                              2,551 SF    │
│     └─ A2.1: 1,247 SF  │  A2.2: 1,304 SF            [👁 ✎ 🗑] │
│                                                                  │
│  ─────────────────────────────────────────────────────────────  │
│                                                                  │
│  TOTALS                                                          │
│  Count items:     142 EA                                         │
│  Linear items:    847 LF                                         │
│  Area items:    4,892 SF                                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Interactions

| Action | Result |
|--------|--------|
| Click row | Highlights all instances on drawing |
| Click sheet count | Jumps to that sheet, zooms to fit items |
| 👁 button | Toggle visibility of this item type |
| ✎ button | Edit item (name, category, style) |
| 🗑 button | Delete (with confirmation) |
| Drag rows | Reorder/recategorize |
| Right-click | Context menu (duplicate, merge, split) |

---

## Module 6: Symbol Library & Find Similar

**Goal**: Count 50 identical symbols with 3 clicks, not 50 clicks

### How Symbols Get Added

1. **MANUAL**: User places first count, assigns to category
   - System captures image crop + vector signature

2. **FROM LEGEND**: User clicks "Import from legend"
   - OCR extracts symbol + description pairs
   - Each becomes a library entry

3. **FROM PREVIOUS PROJECT**: Import library from similar project
   - Useful for same client/architect

### "Find Similar" Workflow

```
Step 1: User places first instance (or clicks existing)

Step 2: Press 'F' or click "Find Similar"

Step 3: System searches (shows progress)
   ┌──────────────────────────────────────────────────────┐
   │  Searching... Sheet A2.1 ████████░░ 80%              │
   │                                                      │
   │  Found so far: 47 matches                            │
   │    • 42 high confidence (>95%)                       │
   │    • 5 medium confidence (80-95%)                    │
   └──────────────────────────────────────────────────────┘

Step 4: Review results
   ┌──────────────────────────────────────────────────────┐
   │  Found 47 matches for "Duplex Outlet"                │
   │                                                      │
   │  [✓ Accept All High Confidence (42)]                 │
   │                                                      │
   │  Review medium confidence (5):                       │
   │  ┌────┐ 92% ─ Sheet A2.1   [✓] [✗]                  │
   │  │crop│                                              │
   │  └────┘                                              │
   │  ┌────┐ 87% ─ Sheet A2.2   [✓] [✗]                  │
   │  │crop│     (might be GFCI?)                        │
   │  └────┘                                              │
   │  ...                                                 │
   │                                                      │
   │  [Apply Selections]  [Cancel]                        │
   └──────────────────────────────────────────────────────┘

Step 5: All accepted matches become count items
```

### Matching Algorithm

Run BOTH methods, combine results:

**1. Vector hash matching (when vectors available)**
- Extract paths in region → hash → find identical hashes
- 100% confidence when matched
- Zero false positives

**2. Image template matching**
- Crop region → normalized template
- Slide across sheet, compute similarity
- Confidence = similarity score
- Works on any PDF

**Final score** = max(vector_match, image_match)

---

## Module 7: Keyboard-First Design

**Goal**: Expert operators never touch the mouse for common actions

### Keyboard Shortcuts

| Category | Key | Action |
|----------|-----|--------|
| **Tools** | V | Select |
| | C | Count |
| | L | Linear |
| | A | Area |
| | R | Rectangle |
| | ESC | Cancel current tool |
| **Navigation** | ↑↓ | Previous/next sheet |
| | PgUp/PgDn | Pan up/down |
| | Home | Fit sheet to view |
| | End | Zoom to selected item |
| | +/- | Zoom in/out |
| | Space+drag | Pan (like Photoshop) |
| **Editing** | Delete | Remove selected |
| | Ctrl+Z | Undo |
| | Ctrl+Y | Redo |
| | Ctrl+D | Duplicate |
| | Ctrl+G | Group selected |
| **Data** | 1-9 | Assign to category 1-9 |
| | Tab | Next item in list |
| | Enter | Confirm and continue |
| | E | Edit selected item |
| **Precision** | Shift | Constrain H/V |
| | Alt | Disable snap |
| | Tab | Cycle snap points |
| | G | Toggle grid |
| **Workflow** | F | Find similar |
| | S | Scale calibration |
| | ? | Show all shortcuts |
| | Ctrl+E | Export |

**Goal**: Complete a full takeoff without moving hand from keyboard

---

## Module 8: Export System

**Goal**: Output exactly what the customer needs, in their preferred format

### Format Options

| Format | Contents |
|--------|----------|
| **Excel (.xlsx)** | Summary sheet (totals by category), Detail sheet (every item with location), Formatted for direct pricing |
| **PDF Report** | Cover page with project info, Summary tables, Annotated drawings (optional) |
| **CSV** | Raw data for import into other systems |
| **API/Webhook** | Push to external system (Procore, Sage, etc.) |

### Excel Template

| Column A | Column B | Column C | Column D | Column E |
|----------|----------|----------|----------|----------|
| Category | Item | Quantity | Unit | Sheet(s) |
| Electrical | Duplex Outlet | 47 | EA | A2.1,A2.2 |
| Electrical | GFCI Outlet | 12 | EA | A2.1 |
| Drywall | Wall Type A | 847 | LF | A2.1-A2.4 |
| Drywall | Ceiling | 2,551 | SF | A2.1-A2.4 |

Customizable: column order, included fields, formulas

---

## Data Model

```typescript
// Core entities

interface Project {
  id: string;
  name: string;
  client_name?: string;
  address?: string;
  created_at: Date;
  updated_at: Date;
  status: 'active' | 'completed' | 'archived';

  // Settings
  default_measurement_unit: 'imperial' | 'metric';
}

interface Document {
  id: string;
  project_id: string;
  filename: string;
  original_url: string;  // S3/GCS path to original PDF
  page_count: number;
  uploaded_at: Date;
  processing_status: 'pending' | 'processing' | 'ready' | 'error';
}

interface Sheet {
  id: string;
  document_id: string;
  page_number: number;
  name: string;  // Extracted or user-assigned

  // Dimensions
  width_px: number;
  height_px: number;

  // Scale
  scale_value: number | null;  // pixels per foot
  scale_source: 'auto_titleblock' | 'auto_scalebar' | 'auto_dimension' | 'manual' | null;
  scale_confidence: number;  // 0-1

  // Processing
  tiles_ready: boolean;
  vectors_ready: boolean;
  vector_quality: 'good' | 'medium' | 'poor' | 'none';

  // Tile URL pattern
  tile_url_template: string;  // e.g., "https://cdn.../tiles/{z}/{x}/{y}.png"
}

interface Category {
  id: string;
  project_id: string;
  name: string;
  color: string;
  measurement_type: 'count' | 'linear' | 'area';
  sort_order: number;
}

interface ItemType {
  id: string;
  category_id: string;
  name: string;
  description?: string;

  // Symbol template (for "find similar")
  symbol_image_crop?: string;  // Base64 or URL
  symbol_vector_hash?: string; // Hash of vector paths

  // Style
  style: {
    color: string;
    stroke_width: number;
    fill_opacity: number;
    marker_shape: 'circle' | 'square' | 'triangle' | 'cross';
    marker_size: number;
  };
}

interface Measurement {
  id: string;
  item_type_id: string;
  sheet_id: string;

  // Geometry (GeoJSON)
  geometry: {
    type: 'Point' | 'LineString' | 'Polygon';
    coordinates: number[] | number[][] | number[][][];
  };

  // Calculated values
  quantity: number;  // count=1, linear=feet, area=sqft

  // Metadata
  created_at: Date;
  created_by: string;  // user_id
  source: 'manual' | 'find_similar' | 'ai_detected';
  confidence?: number;  // For AI-generated

  // For auditing
  snapped_to?: 'pdf_vector' | 'annotation' | 'grid' | 'none';
}

// Vector geometry (for snapping)
interface SheetVectors {
  sheet_id: string;

  // Simplified geometry for client
  snap_points: Array<{
    type: 'endpoint' | 'midpoint' | 'intersection';
    coords: [number, number];
  }>;

  lines: Array<{
    start: [number, number];
    end: [number, number];
  }>;

  // Full geometry stored separately (for future AI use)
  full_vectors_url?: string;
}
```

---

## Implementation Phases

### Phase 1: Foundation (6-8 weeks)

- [ ] PDF upload + tile generation
- [ ] Basic sheet navigation (list, thumbnails, switch)
- [ ] OpenLayers display with tile layer
- [ ] Manual scale calibration
- [ ] Basic measurement tools (count, linear, area)
- [ ] Annotation storage (PostgreSQL + GeoJSON)
- [ ] Simple takeoff panel (flat list, totals)
- [ ] Excel export (basic)

**DELIVERABLE**: Operators can do basic takeoffs

---

### Phase 2: Precision (4-6 weeks)

- [ ] Vector extraction pipeline
- [ ] Vector quality assessment
- [ ] Snap-to-vectors implementation
- [ ] Snap-to-annotations
- [ ] Visual snap feedback (indicators, highlighting)
- [ ] Keyboard modifiers (Shift=constrain, Alt=no-snap)

**DELIVERABLE**: Precision measurements with snapping

---

### Phase 3: Speed (4-6 weeks)

- [ ] Symbol library system
- [ ] "Find similar" with image matching
- [ ] "Find similar" with vector matching
- [ ] Bulk accept/reject UI
- [ ] Auto scale detection (title block, scale bar)
- [ ] Keyboard shortcuts (full set)
- [ ] Category/item type templates

**DELIVERABLE**: Fast symbol counting, minimal manual entry

---

### Phase 4: Polish (4-6 weeks)

- [ ] Progressive tile loading (priority queue)
- [ ] Tile caching (IndexedDB)
- [ ] Hierarchical takeoff panel (categories, collapse/expand)
- [ ] Click item → highlight on drawing
- [ ] Export templates (customizable Excel)
- [ ] PDF report generation
- [ ] Undo/redo system
- [ ] Project/item duplication

**DELIVERABLE**: Production-ready, polished UX

---

### Phase 5: Collaboration (3-4 weeks)

- [ ] User accounts + authentication
- [ ] Project sharing
- [ ] Edit locking (one editor at a time)
- [ ] Audit log (who changed what)
- [ ] Comments/notes on items

**DELIVERABLE**: Multi-user support

---

### Phase 6: AI Foundation (6-8 weeks) - FUTURE

- [ ] Training data pipeline (capture corrections)
- [ ] Sheet classification model
- [ ] Symbol detection model (one trade)
- [ ] AI suggestions UI
- [ ] Feedback loop (accept/reject improves model)

**DELIVERABLE**: AI-assisted takeoffs

---

## Scope Cutting Guide

If you need to ship faster, cut in this order:

### Cut FIRST (least impact)

- Multiple snap types → Just endpoints is fine initially
- Hierarchical categories → Flat list works
- Legend import → Manual symbol library is fine
- Custom export templates → Fixed format is fine

### Cut MIDDLE

- Vector extraction → Can work with annotation-only snapping
- Auto scale detection → Manual calibration works
- PDF reports → Excel is enough initially
- Tile caching → Acceptable to re-fetch

### Cut LAST (most valuable for speed)

- Snapping (Phase 2) → Huge time savings
- Find Similar (Phase 3) → Huge time savings for counts
- Keyboard shortcuts (Phase 3) → Expert operator speed

---

## Appendix: Comparison with Competitors

### ibeam.ai

| Aspect | ibeam | Our Approach |
|--------|-------|--------------|
| PDF Rendering | Server tiles (OpenLayers) | Same |
| Vector Snapping | No | Yes (when available) |
| Business Model | Service + credits | Service on platform |
| AI | Server-side ATS | Future phase |
| Real-time | Firebase locks | Same initially |

### Togal.AI

| Aspect | Togal | Our Approach |
|--------|-------|--------------|
| PDF Rendering | MuPDF WASM (client) | Server tiles (simpler) |
| Vector Snapping | Yes (client-side) | Yes (server-extracted) |
| Business Model | SaaS subscription | Service on platform |
| 3D | Yes (Three.js) | Not initially |
| Real-time | WebSocket | Locks initially |

---

*Document generated from architecture analysis session*
*Last updated: January 2026*
