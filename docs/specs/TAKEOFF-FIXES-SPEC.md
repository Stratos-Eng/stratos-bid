# Takeoff System - Technical Fix Specification

**Version:** 1.0
**Date:** 2026-01-09
**Status:** Draft

---

## Executive Summary

This specification details the fixes required to bring the takeoff system from proof-of-concept to production-ready. Issues are prioritized by severity and grouped into phases.

---

## Phase 1: Critical Data Integrity Fixes

### 1.1 Measurement Type/Unit Persistence Bug

**Problem:**
The `type` and `unit` fields are stored in the Zustand store but not persisted to the database. The API derives `type` from `geometry.type`, which is incorrect:
- A polygon used for counting objects becomes an "area" measurement on reload
- User-set labels are lost on reload
- Unit preference (ft vs m) is lost

**Current Flow (Broken):**
```
User draws polygon for count → Store: {type: 'count', unit: 'EA'}
                             → API saves: {geometry: {type: 'Polygon'}}
Page reload                  → API returns: derives type='area' from Polygon
                             → Store: {type: 'area', unit: 'SF'} ← DATA CORRUPTED
```

**Root Cause:**
- `src/db/schema.ts` - `takeoffMeasurements` table missing `type`, `unit`, `label` columns
- `src/app/api/takeoff/measurements/route.ts` - POST doesn't save these fields, GET derives them

**Fix:**

1. **Schema migration** - Add columns to `takeoffMeasurements`:
```sql
ALTER TABLE takeoff_measurements
ADD COLUMN measurement_type TEXT NOT NULL DEFAULT 'count',
ADD COLUMN unit TEXT NOT NULL DEFAULT 'EA',
ADD COLUMN label TEXT;
```

2. **Update schema.ts:**
```typescript
export const takeoffMeasurements = pgTable('takeoff_measurements', {
  // ... existing fields
  measurementType: text('measurement_type').notNull(), // 'count' | 'linear' | 'area'
  unit: text('unit').notNull(), // 'EA', 'LF', 'SF', 'm', 'sqm'
  label: text('label'),
  // ... rest
});
```

3. **Update measurements API:**
```typescript
// POST - Save all fields
const { geometry, quantity, categoryId, sheetId, type, unit, label } = body;

await db.insert(takeoffMeasurements).values({
  categoryId,
  sheetId,
  geometry,
  quantity,
  measurementType: type,
  unit,
  label,
  createdBy: session.user.id,
});

// GET - Return stored fields, don't derive
const measurements = await db.select().from(takeoffMeasurements)...
return measurements.map(m => ({
  ...m,
  type: m.measurementType, // Use stored value
  unit: m.unit,
  label: m.label,
}));
```

4. **Update store type:**
```typescript
// Already correct, but ensure API matches
export interface TakeoffMeasurement {
  id: string;
  sheetId: string;
  categoryId: string;
  type: MeasurementType; // FROM DATABASE, not derived
  geometry: {...};
  quantity: number;
  unit: string; // FROM DATABASE
  label?: string; // FROM DATABASE
  createdAt: Date;
}
```

**Validation:**
- [ ] Create polygon measurement with type='count'
- [ ] Reload page
- [ ] Verify type is still 'count', not 'area'

---

### 1.2 API Request Validation (Security)

**Problem:**
All API endpoints accept unvalidated JSON. Malformed data can crash the system or corrupt the database.

**Examples of exploitable inputs:**
```json
// Crashes quantity calculation
{"geometry": {"type": "Point", "coordinates": ["not", "numbers"]}}

// SQL injection via label (if not parameterized - verify)
{"label": "'; DROP TABLE takeoff_measurements; --"}

// Memory exhaustion
{"geometry": {"type": "Polygon", "coordinates": [[[...millions of points...]]]}}
```

**Fix:**

1. **Create shared validation schemas** (`src/lib/validations/takeoff.ts`):
```typescript
import { z } from 'zod';

// Coordinate validation
const coordinateSchema = z.tuple([z.number().finite(), z.number().finite()]);

// GeoJSON geometry schemas
const pointGeometrySchema = z.object({
  type: z.literal('Point'),
  coordinates: coordinateSchema,
});

const lineStringGeometrySchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(coordinateSchema).min(2).max(10000),
});

const polygonGeometrySchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(coordinateSchema).min(3).max(10000)).length(1),
});

export const geometrySchema = z.discriminatedUnion('type', [
  pointGeometrySchema,
  lineStringGeometrySchema,
  polygonGeometrySchema,
]);

// Measurement creation schema
export const createMeasurementSchema = z.object({
  sheetId: z.string().uuid(),
  categoryId: z.string().uuid(),
  projectId: z.string().uuid(),
  type: z.enum(['count', 'linear', 'area']),
  geometry: geometrySchema,
  quantity: z.number().positive().finite().max(1_000_000_000),
  unit: z.string().min(1).max(10),
  label: z.string().max(200).optional(),
});

// Category creation schema
export const createCategorySchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  measurementType: z.enum(['count', 'linear', 'area']),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

// Sheet creation schema
export const createSheetSchema = z.object({
  projectId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  pageNumber: z.number().int().min(1).max(10000),
  name: z.string().min(1).max(200),
  widthPx: z.number().int().min(1).max(100000),
  heightPx: z.number().int().min(1).max(100000),
  scale: z.number().positive().max(10000).optional(),
  scaleUnit: z.enum(['ft', 'm', 'in', 'cm']).optional(),
});
```

2. **Apply validation in each API route:**
```typescript
// measurements/route.ts
import { createMeasurementSchema } from '@/lib/validations/takeoff';

export async function POST(request: NextRequest) {
  const body = await request.json();

  const result = createMeasurementSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: result.error.flatten() },
      { status: 400 }
    );
  }

  const validated = result.data;
  // Use validated.geometry, validated.quantity, etc.
}
```

**Endpoints to update:**
- [ ] `POST /api/takeoff/measurements`
- [ ] `PATCH /api/takeoff/measurements`
- [ ] `DELETE /api/takeoff/measurements`
- [ ] `POST /api/takeoff/categories`
- [ ] `DELETE /api/takeoff/categories`
- [ ] `POST /api/takeoff/projects`
- [ ] `POST /api/takeoff/upload`
- [ ] `POST /api/takeoff/vectors`

---

### 1.3 Export Functionality (Currently 404)

**Problem:**
The export button in `data-panel.tsx` links to `/api/takeoff/projects/${projectId}/export` which doesn't exist.

**Fix:**

Create `src/app/api/takeoff/projects/[projectId]/export/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffProjects, takeoffCategories, takeoffMeasurements, takeoffSheets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import * as XLSX from 'xlsx';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { projectId } = await params;
  const format = request.nextUrl.searchParams.get('format') || 'xlsx';

  // Verify ownership
  const [project] = await db
    .select()
    .from(takeoffProjects)
    .where(and(
      eq(takeoffProjects.id, projectId),
      eq(takeoffProjects.userId, session.user.id)
    ))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Get all data
  const categories = await db
    .select()
    .from(takeoffCategories)
    .where(eq(takeoffCategories.projectId, projectId));

  const sheets = await db
    .select()
    .from(takeoffSheets)
    .where(eq(takeoffSheets.projectId, projectId));

  const measurements = await db
    .select({
      id: takeoffMeasurements.id,
      categoryId: takeoffMeasurements.categoryId,
      sheetId: takeoffMeasurements.sheetId,
      quantity: takeoffMeasurements.quantity,
      measurementType: takeoffMeasurements.measurementType,
      unit: takeoffMeasurements.unit,
      label: takeoffMeasurements.label,
      createdAt: takeoffMeasurements.createdAt,
    })
    .from(takeoffMeasurements)
    .innerJoin(takeoffSheets, eq(takeoffMeasurements.sheetId, takeoffSheets.id))
    .where(eq(takeoffSheets.projectId, projectId));

  // Build category and sheet lookup maps
  const categoryMap = new Map(categories.map(c => [c.id, c]));
  const sheetMap = new Map(sheets.map(s => [s.id, s]));

  if (format === 'csv') {
    // CSV export
    const rows = measurements.map(m => ({
      'Category': categoryMap.get(m.categoryId)?.name || 'Unknown',
      'Sheet': sheetMap.get(m.sheetId)?.name || 'Unknown',
      'Type': m.measurementType,
      'Quantity': m.quantity,
      'Unit': m.unit,
      'Label': m.label || '',
      'Created': m.createdAt?.toISOString() || '',
    }));

    const headers = Object.keys(rows[0] || {}).join(',');
    const csvRows = rows.map(r => Object.values(r).map(v => `"${v}"`).join(','));
    const csv = [headers, ...csvRows].join('\n');

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${project.name}-takeoff.csv"`,
      },
    });
  }

  // Excel export with multiple sheets
  const workbook = XLSX.utils.book_new();

  // Summary sheet - quantities by category
  const summaryData = categories.map(cat => {
    const catMeasurements = measurements.filter(m => m.categoryId === cat.id);
    const total = catMeasurements.reduce((sum, m) => sum + m.quantity, 0);
    return {
      'Category': cat.name,
      'Type': cat.measurementType,
      'Total Quantity': total,
      'Unit': catMeasurements[0]?.unit || cat.measurementType === 'count' ? 'EA' : cat.measurementType === 'linear' ? 'LF' : 'SF',
      'Count': catMeasurements.length,
    };
  });
  const summarySheet = XLSX.utils.json_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

  // Detail sheet - all measurements
  const detailData = measurements.map(m => ({
    'ID': m.id,
    'Category': categoryMap.get(m.categoryId)?.name || 'Unknown',
    'Sheet': sheetMap.get(m.sheetId)?.name || 'Unknown',
    'Type': m.measurementType,
    'Quantity': m.quantity,
    'Unit': m.unit,
    'Label': m.label || '',
    'Created': m.createdAt?.toISOString() || '',
  }));
  const detailSheet = XLSX.utils.json_to_sheet(detailData);
  XLSX.utils.book_append_sheet(workbook, detailSheet, 'Details');

  // Per-category sheets
  for (const cat of categories) {
    const catMeasurements = measurements.filter(m => m.categoryId === cat.id);
    if (catMeasurements.length === 0) continue;

    const catData = catMeasurements.map(m => ({
      'Sheet': sheetMap.get(m.sheetId)?.name || 'Unknown',
      'Quantity': m.quantity,
      'Unit': m.unit,
      'Label': m.label || '',
    }));

    // Add total row
    catData.push({
      'Sheet': 'TOTAL',
      'Quantity': catMeasurements.reduce((sum, m) => sum + m.quantity, 0),
      'Unit': catMeasurements[0]?.unit || '',
      'Label': '',
    });

    const catSheet = XLSX.utils.json_to_sheet(catData);
    const sheetName = cat.name.substring(0, 31).replace(/[\\/*?:\[\]]/g, '_');
    XLSX.utils.book_append_sheet(workbook, catSheet, sheetName);
  }

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${project.name}-takeoff.xlsx"`,
    },
  });
}
```

---

### 1.4 Canvas Package Vercel Incompatibility

**Problem:**
The `canvas` npm package is a native module requiring compilation. It won't work in Vercel's serverless environment without special configuration.

**Affected endpoints:**
- `src/app/api/takeoff/render/route.ts`
- `src/app/api/documents/[id]/page/[pageNum]/route.ts`

**Options:**

#### Option A: Use Vercel Edge Runtime with @vercel/og (Limited)
Not suitable - needs full canvas API.

#### Option B: Use external rendering service
Move PDF rendering to a dedicated service (AWS Lambda with layers, or dedicated server).

#### Option C: Use pdf.js browser-side rendering (Recommended for MVP)
Render PDFs client-side instead of server-side.

**Recommended Fix (Option C):**

1. **Remove server-side render endpoint** - or make it optional/fallback

2. **Update PdfViewer to render PDF client-side:**
```typescript
// pdf-viewer.tsx - Add client-side PDF rendering
import * as pdfjsLib from 'pdfjs-dist';

// Set worker
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';

// In useEffect, render PDF to canvas and use as image source
useEffect(() => {
  if (!pdfUrl || !sheetId) return;

  const loadPdf = async () => {
    const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.5 });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    const imageDataUrl = canvas.toDataURL('image/png');
    setRenderedImage(imageDataUrl);
  };

  loadPdf();
}, [pdfUrl, pageNumber]);
```

3. **Update API to serve raw PDF:**
```typescript
// GET /api/takeoff/pdf/[projectId]/[filename]
// Just stream the raw PDF file, no rendering
export async function GET(request, { params }) {
  const filePath = path.join(uploadsDir, params.filename);
  const file = fs.readFileSync(filePath);
  return new NextResponse(file, {
    headers: { 'Content-Type': 'application/pdf' },
  });
}
```

4. **Keep server-side render as optional** for environments that support it:
```typescript
const USE_SERVER_RENDER = process.env.USE_SERVER_RENDER === 'true';

// In sheet creation, set tileUrlTemplate based on capability
if (USE_SERVER_RENDER) {
  tileUrlTemplate = `/api/takeoff/render?projectId=${projectId}&file=${filename}&page=${pageNum}`;
} else {
  tileUrlTemplate = null; // Client will render
  pdfUrl = `/api/takeoff/pdf/${projectId}/${filename}`;
}
```

---

## Phase 2: High Priority Fixes

### 2.1 Scale Calibration Workflow

**Problem:**
Users can't set scale without editing the database. Professional tools let you draw a known dimension.

**Solution:**

1. **Add scale calibration mode to toolbar:**
```typescript
// toolbar.tsx
type MeasurementTool = 'select' | 'count' | 'linear' | 'area' | 'rectangle' | 'calibrate';

// New button
<button onClick={() => setActiveTool('calibrate')} title="Calibrate Scale (K)">
  📏
</button>
```

2. **Add calibration interaction in pdf-viewer:**
```typescript
// When tool is 'calibrate', draw a line and prompt for known length
if (activeTool === 'calibrate') {
  draw.on('drawend', (event) => {
    const geometry = event.feature.getGeometry() as LineString;
    const pixelLength = geometry.getLength();

    // Prompt user for actual length
    const actualLength = prompt('Enter the actual length of this line (e.g., "10 ft"):');
    if (!actualLength) return;

    const match = actualLength.match(/^([\d.]+)\s*(ft|m|in|cm)?$/i);
    if (!match) {
      alert('Invalid format. Use: 10 ft, 5.5 m, etc.');
      return;
    }

    const value = parseFloat(match[1]);
    const unit = (match[2] || 'ft').toLowerCase();

    // Calculate scale: pixels per unit
    const scale = pixelLength / value;

    // Save to sheet
    onScaleCalibrated(scale, unit);
  });
}
```

3. **Add API endpoint to update sheet scale:**
```typescript
// PATCH /api/takeoff/sheets/[sheetId]
export async function PATCH(request, { params }) {
  const { scale, scaleUnit } = await request.json();

  await db.update(takeoffSheets)
    .set({ scaleValue: scale, scaleUnit })
    .where(eq(takeoffSheets.id, params.sheetId));
}
```

4. **Update schema to include scaleUnit:**
```sql
ALTER TABLE takeoff_sheets ADD COLUMN scale_unit TEXT DEFAULT 'ft';
```

---

### 2.2 Category Quantity Rollups

**Problem:**
Data panel shows individual measurements but no totals per category.

**Fix in data-panel.tsx:**

```typescript
// Add totals calculation
const categoryTotals = useMemo(() => {
  const totals = new Map<string, { count: number; quantity: number; unit: string }>();

  for (const [categoryId, items] of measurementsByCategory) {
    const total = items.reduce((sum, m) => sum + m.quantity, 0);
    const unit = items[0]?.unit || 'EA';
    totals.set(categoryId, { count: items.length, quantity: total, unit });
  }

  return totals;
}, [measurementsByCategory]);

// In render, show totals in category header
{categories.map((category) => {
  const total = categoryTotals.get(category.id);
  return (
    <div key={category.id}>
      <div className="flex justify-between items-center p-2 bg-gray-50">
        <span className="font-medium">{category.name}</span>
        <span className="text-sm text-gray-600">
          {total ? `${total.quantity.toFixed(2)} ${total.unit} (${total.count} items)` : '0'}
        </span>
      </div>
      {/* measurements list */}
    </div>
  );
})}
```

---

### 2.3 Fix Data Panel Search

**Problem:**
Search input exists but `searchQuery` state doesn't exist and filtering isn't implemented.

**Fix:**

```typescript
// data-panel.tsx
const [searchQuery, setSearchQuery] = useState('');

// Filter measurements by search
const filteredMeasurements = useMemo(() => {
  if (!searchQuery.trim()) return measurements;

  const query = searchQuery.toLowerCase();
  return measurements.filter(m => {
    const category = categories.find(c => c.id === m.categoryId);
    return (
      m.label?.toLowerCase().includes(query) ||
      category?.name.toLowerCase().includes(query) ||
      m.quantity.toString().includes(query)
    );
  });
}, [measurements, searchQuery, categories]);

// Use filteredMeasurements instead of measurements in grouping
const measurementsByCategory = useMemo(() => {
  const grouped = new Map<string, TakeoffMeasurement[]>();
  for (const m of filteredMeasurements) { // Changed from measurements
    // ...
  }
  return grouped;
}, [filteredMeasurements]);

// In render
<input
  type="text"
  placeholder="Search measurements..."
  value={searchQuery}
  onChange={(e) => setSearchQuery(e.target.value)}
  className="w-full px-3 py-2 border rounded-lg text-sm"
/>
```

---

### 2.4 Measurement Pagination

**Problem:**
GET /api/takeoff/measurements returns all measurements, causing performance issues for large projects.

**Fix:**

```typescript
// measurements/route.ts
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');
  const sheetId = searchParams.get('sheetId');
  const categoryId = searchParams.get('categoryId');
  const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 1000);
  const offset = parseInt(searchParams.get('offset') || '0');

  // Build query with filters
  let query = db.select().from(takeoffMeasurements);

  const conditions = [];
  if (sheetId) conditions.push(eq(takeoffMeasurements.sheetId, sheetId));
  if (categoryId) conditions.push(eq(takeoffMeasurements.categoryId, categoryId));

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  // Get total count
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(takeoffMeasurements)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const total = countResult[0]?.count || 0;

  // Get paginated results
  const measurements = await query
    .limit(limit)
    .offset(offset)
    .orderBy(desc(takeoffMeasurements.createdAt));

  return NextResponse.json({
    measurements,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + measurements.length < total,
    },
  });
}
```

---

## Phase 3: Medium Priority Fixes

### 3.1 Visual Snap Point Layer Toggle

Add a button to show/hide all snap points on the map for better visibility.

### 3.2 Measurement Editing

Allow editing measurement properties (label, quantity override) without deleting and recreating.

### 3.3 Vector Extraction Progress

Show a loading indicator and progress during vector extraction.

### 3.4 Bi-directional Selection Sync

When clicking a measurement in the data panel, zoom to it on the canvas. When selecting on canvas, scroll to it in the list.

---

## Phase 4: Architecture Improvements

### 4.1 Split pdf-viewer.tsx

Break the 945-line component into:
- `PdfViewer.tsx` - Main container, map initialization
- `DrawingTools.tsx` - Drawing interaction logic
- `SnapManager.tsx` - Snap point loading and feedback
- `MeasurementLayer.tsx` - Rendering measurements on map
- `ScaleCalibration.tsx` - Scale calibration mode

### 4.2 Add Offline Support

Use IndexedDB to cache measurements locally, sync when online.

### 4.3 Move to S3 for PDF Storage

Replace filesystem storage with S3/R2 for production scalability.

---

## Migration Plan

### Step 1: Database Migration
```sql
-- Add missing columns
ALTER TABLE takeoff_measurements
ADD COLUMN measurement_type TEXT,
ADD COLUMN unit TEXT,
ADD COLUMN label TEXT;

-- Backfill existing data
UPDATE takeoff_measurements
SET measurement_type = CASE
  WHEN geometry->>'type' = 'Point' THEN 'count'
  WHEN geometry->>'type' = 'LineString' THEN 'linear'
  ELSE 'area'
END,
unit = CASE
  WHEN geometry->>'type' = 'Point' THEN 'EA'
  WHEN geometry->>'type' = 'LineString' THEN 'LF'
  ELSE 'SF'
END
WHERE measurement_type IS NULL;

-- Make columns NOT NULL after backfill
ALTER TABLE takeoff_measurements
ALTER COLUMN measurement_type SET NOT NULL,
ALTER COLUMN unit SET NOT NULL;

-- Add scale_unit to sheets
ALTER TABLE takeoff_sheets ADD COLUMN scale_unit TEXT DEFAULT 'ft';
```

### Step 2: Deploy API Changes
1. Deploy validation schemas
2. Deploy updated measurement routes
3. Deploy export route
4. Test thoroughly

### Step 3: Deploy Frontend Changes
1. Deploy updated store types
2. Deploy data-panel fixes
3. Deploy scale calibration
4. Test end-to-end

---

## Testing Checklist

### Critical Path Tests
- [ ] Create measurement → reload → type preserved
- [ ] Create measurement with label → reload → label preserved
- [ ] Invalid geometry rejected by API
- [ ] Export downloads valid Excel file
- [ ] Export contains all measurements with correct totals

### Regression Tests
- [ ] Drawing tools still work
- [ ] Snap points still appear
- [ ] Undo/redo still works
- [ ] Sheet switching still works
- [ ] Category creation still works

### Performance Tests
- [ ] Load project with 1000 measurements < 2s
- [ ] Draw measurement with 5000 snap points < 100ms lag
- [ ] Export 5000 measurements < 5s

---

## Success Metrics

1. **Data Integrity:** 0% data loss on page reload
2. **API Reliability:** 100% of invalid requests rejected with clear error
3. **Export Accuracy:** 100% match between UI totals and export totals
4. **Performance:** P95 page load < 3s for 1000-measurement project

---

## Appendix: File Changes Summary

| File | Changes |
|------|---------|
| `src/db/schema.ts` | Add measurementType, unit, label, scaleUnit columns |
| `src/lib/validations/takeoff.ts` | NEW - Zod schemas |
| `src/app/api/takeoff/measurements/route.ts` | Add validation, save/return all fields |
| `src/app/api/takeoff/categories/route.ts` | Add validation |
| `src/app/api/takeoff/projects/[projectId]/export/route.ts` | NEW - Export endpoint |
| `src/app/api/takeoff/sheets/[sheetId]/route.ts` | NEW - PATCH for scale |
| `src/components/takeoff/data-panel.tsx` | Fix search, add totals |
| `src/components/takeoff/toolbar.tsx` | Add calibrate tool |
| `src/components/takeoff/pdf-viewer.tsx` | Add calibration mode, client-side render option |
| `drizzle/migrations/XXXX_add_measurement_fields.sql` | NEW - Migration |
