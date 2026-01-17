# Vector Extraction UX Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve vector extraction UX with batch extraction, progress indicators, error handling, and stale vector detection.

**Architecture:** Adds a batch extraction API endpoint that processes all sheets for a project. Frontend gets extraction state management with loading/error UI. GET endpoint enhanced to detect stale vectors by comparing extractedAt vs sheet createdAt.

**Tech Stack:** Next.js 14 API Routes, React hooks, Zod validation, PostgreSQL/Drizzle ORM

---

## Task 1: Add Zod Schema for Batch Extraction

**Files:**
- Modify: `src/lib/validations/takeoff.ts:149-157`

**Step 1: Add batch extraction schema**

Add after line 157 (after `getVectorsSchema`):

```typescript
export const batchExtractVectorsSchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
});

export const batchExtractVectorsResponseSchema = z.object({
  success: z.boolean(),
  total: z.number(),
  completed: z.number(),
  failed: z.number(),
  results: z.array(z.object({
    sheetId: z.string().uuid(),
    sheetName: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
    snapPointCount: z.number().optional(),
    lineCount: z.number().optional(),
    quality: z.string().optional(),
  })),
});
```

**Step 2: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/lib/validations/takeoff.ts
git commit -m "feat(takeoff): add Zod schema for batch vector extraction"
```

---

## Task 2: Create Batch Extraction API Endpoint

**Files:**
- Create: `src/app/api/takeoff/vectors/batch/route.ts`

**Step 1: Create the batch API route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffSheets, sheetVectors, takeoffProjects, documents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { batchExtractVectorsSchema, formatZodError } from '@/lib/validations/takeoff';

const PYTHON_VECTOR_API_URL = process.env.PYTHON_VECTOR_API_URL;

interface ExtractionResult {
  sheetId: string;
  sheetName: string;
  success: boolean;
  error?: string;
  snapPointCount?: number;
  lineCount?: number;
  quality?: string;
}

// Extract vectors for a single sheet (reused from main route logic)
async function extractVectorsForSheet(
  sheetId: string,
  sheetName: string,
  pdfPath: string,
  pageNumber: number,
  scale: number = 1.5
): Promise<ExtractionResult> {
  try {
    if (!fs.existsSync(pdfPath)) {
      return { sheetId, sheetName, success: false, error: 'PDF file not found' };
    }

    const pdfData = fs.readFileSync(pdfPath);
    const base64 = Buffer.from(pdfData).toString('base64');

    if (!PYTHON_VECTOR_API_URL) {
      return { sheetId, sheetName, success: false, error: 'Python API not configured' };
    }

    const response = await fetch(PYTHON_VECTOR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfData: base64, pageNum: pageNumber, scale }),
    });

    if (!response.ok) {
      return { sheetId, sheetName, success: false, error: 'Python extraction failed' };
    }

    const data = await response.json();

    if (!data.success) {
      return { sheetId, sheetName, success: false, error: data.error || 'Unknown error' };
    }

    // Store vectors in database
    await db
      .insert(sheetVectors)
      .values({
        sheetId,
        snapPoints: data.snapPoints,
        lines: data.lines,
        extractedAt: new Date(),
        rawPathCount: data.rawPathCount,
        cleanedPathCount: data.cleanedPathCount,
      })
      .onConflictDoUpdate({
        target: sheetVectors.sheetId,
        set: {
          snapPoints: data.snapPoints,
          lines: data.lines,
          extractedAt: new Date(),
          rawPathCount: data.rawPathCount,
          cleanedPathCount: data.cleanedPathCount,
        },
      });

    // Update sheet status
    await db
      .update(takeoffSheets)
      .set({ vectorsReady: true, vectorQuality: data.quality })
      .where(eq(takeoffSheets.id, sheetId));

    return {
      sheetId,
      sheetName,
      success: true,
      snapPointCount: data.snapPoints?.length || 0,
      lineCount: data.lines?.length || 0,
      quality: data.quality,
    };
  } catch (error) {
    return {
      sheetId,
      sheetName,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// POST /api/takeoff/vectors/batch - Extract vectors for all sheets in a project
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const validation = batchExtractVectorsSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { projectId } = validation.data;

    // Verify project ownership
    const [project] = await db
      .select()
      .from(takeoffProjects)
      .where(eq(takeoffProjects.id, projectId))
      .limit(1);

    if (!project || project.userId !== session.user.id) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Get all sheets for the project
    const sheets = await db
      .select({
        sheet: takeoffSheets,
        document: documents,
      })
      .from(takeoffSheets)
      .leftJoin(documents, eq(takeoffSheets.documentId, documents.id))
      .where(eq(takeoffSheets.projectId, projectId));

    if (sheets.length === 0) {
      return NextResponse.json({
        success: true,
        total: 0,
        completed: 0,
        failed: 0,
        results: [],
      });
    }

    // Find PDF path for the project
    let pdfPath: string | null = null;

    // Check if any sheet has a document with storage path
    for (const { document } of sheets) {
      if (document?.storagePath) {
        pdfPath = document.storagePath;
        if (!path.isAbsolute(pdfPath)) {
          pdfPath = path.join(process.cwd(), 'uploads', pdfPath);
        }
        break;
      }
    }

    // Fallback: check uploads/takeoff directory
    if (!pdfPath) {
      const uploadsDir = path.join(process.cwd(), 'uploads', 'takeoff', projectId);
      if (fs.existsSync(uploadsDir)) {
        const files = fs.readdirSync(uploadsDir).filter(f => f.toLowerCase().endsWith('.pdf'));
        if (files.length > 0) {
          pdfPath = path.join(uploadsDir, files[0]);
        }
      }
    }

    if (!pdfPath || !fs.existsSync(pdfPath)) {
      return NextResponse.json({ error: 'PDF file not found for project' }, { status: 404 });
    }

    // Process each sheet
    const results: ExtractionResult[] = [];

    for (const { sheet } of sheets) {
      const result = await extractVectorsForSheet(
        sheet.id,
        sheet.name || `Page ${sheet.pageNumber}`,
        pdfPath,
        sheet.pageNumber
      );
      results.push(result);
    }

    const completed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return NextResponse.json({
      success: failed === 0,
      total: sheets.length,
      completed,
      failed,
      results,
    });
  } catch (error) {
    console.error('Batch vector extraction error:', error);
    return NextResponse.json({ error: 'Batch extraction failed' }, { status: 500 });
  }
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/app/api/takeoff/vectors/batch/route.ts
git commit -m "feat(takeoff): add batch vector extraction API endpoint"
```

---

## Task 3: Add Stale Vector Detection to GET Endpoint

**Files:**
- Modify: `src/app/api/takeoff/vectors/route.ts:505-510`

**Step 1: Update GET response to include staleness check**

Replace lines 505-510 with:

```typescript
    // Check if vectors are stale (sheet created after extraction)
    const vectorsStale = result.vectors.extractedAt && result.sheet.createdAt
      ? new Date(result.sheet.createdAt) > new Date(result.vectors.extractedAt)
      : false;

    return NextResponse.json({
      vectorsReady: true,
      vectorsStale,
      quality: result.sheet.vectorQuality,
      snapPoints: result.vectors.snapPoints || [],
      lines: result.vectors.lines || [],
      extractedAt: result.vectors.extractedAt,
    });
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/app/api/takeoff/vectors/route.ts
git commit -m "feat(takeoff): add stale vector detection to GET endpoint"
```

---

## Task 4: Add Extraction State to pdf-viewer Component

**Files:**
- Modify: `src/components/takeoff/pdf-viewer.tsx`

**Step 1: Add extraction state variables after line 213**

Add after `const [imageLoading, setImageLoading] = useState(true);`:

```typescript
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [vectorsStale, setVectorsStale] = useState(false);
```

**Step 2: Update loadVectors function (lines 322-362)**

Replace the entire `loadVectors` function with:

```typescript
  // Load vectors for sheet
  useEffect(() => {
    async function loadVectors() {
      setExtractionError(null);

      try {
        const response = await fetch(`/api/takeoff/vectors?sheetId=${sheetId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch vectors');
        }

        const data = await response.json();

        if (data.vectorsReady && !data.vectorsStale) {
          setSnapPoints(data.snapPoints || []);
          setSnapLines(data.lines || []);
          setVectorQuality(data.quality);
          setVectorsLoaded(true);
          setVectorsStale(false);
        } else if (data.vectorsStale) {
          // Vectors exist but are stale - show warning, allow re-extract
          setSnapPoints(data.snapPoints || []);
          setSnapLines(data.lines || []);
          setVectorQuality(data.quality);
          setVectorsLoaded(true);
          setVectorsStale(true);
        } else {
          // Trigger vector extraction
          setIsExtracting(true);

          try {
            const extractResponse = await fetch('/api/takeoff/vectors', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sheetId }),
            });

            if (!extractResponse.ok) {
              const errData = await extractResponse.json();
              throw new Error(errData.error || 'Extraction failed');
            }

            const extractData = await extractResponse.json();

            // Reload vectors after extraction
            const reloadResponse = await fetch(`/api/takeoff/vectors?sheetId=${sheetId}`);
            if (reloadResponse.ok) {
              const reloadData = await reloadResponse.json();
              setSnapPoints(reloadData.snapPoints || []);
              setSnapLines(reloadData.lines || []);
              setVectorQuality(extractData.quality);
              setVectorsLoaded(true);
              setVectorsStale(false);
            }
          } finally {
            setIsExtracting(false);
          }
        }
      } catch (err) {
        console.error('Failed to load vectors:', err);
        setExtractionError(err instanceof Error ? err.message : 'Failed to load snap points');
        setIsExtracting(false);
      }
    }

    if (sheetId) {
      // Reset state when sheet changes
      setVectorsLoaded(false);
      setVectorsStale(false);
      setExtractionError(null);
      loadVectors();
    }
  }, [sheetId]);
```

**Step 3: Add re-extract handler after loadVectors useEffect**

```typescript
  // Handler to re-extract vectors (for stale or error cases)
  const handleReExtract = async () => {
    setIsExtracting(true);
    setExtractionError(null);

    try {
      const extractResponse = await fetch('/api/takeoff/vectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetId }),
      });

      if (!extractResponse.ok) {
        const errData = await extractResponse.json();
        throw new Error(errData.error || 'Extraction failed');
      }

      const extractData = await extractResponse.json();

      // Reload vectors
      const reloadResponse = await fetch(`/api/takeoff/vectors?sheetId=${sheetId}`);
      if (reloadResponse.ok) {
        const reloadData = await reloadResponse.json();
        setSnapPoints(reloadData.snapPoints || []);
        setSnapLines(reloadData.lines || []);
        setVectorQuality(extractData.quality);
        setVectorsLoaded(true);
        setVectorsStale(false);
      }
    } catch (err) {
      console.error('Re-extraction failed:', err);
      setExtractionError(err instanceof Error ? err.message : 'Re-extraction failed');
    } finally {
      setIsExtracting(false);
    }
  };
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/components/takeoff/pdf-viewer.tsx
git commit -m "feat(takeoff): add extraction state management to pdf-viewer"
```

---

## Task 5: Add Extraction UI Overlays to pdf-viewer

**Files:**
- Modify: `src/components/takeoff/pdf-viewer.tsx`

**Step 1: Add extraction loading overlay**

Add after the image loading indicator (around line 1100, after `{imageLoading && ...}`):

```typescript
      {/* Vector extraction loading indicator */}
      {isExtracting && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-30">
          <div className="text-center">
            <div className="animate-spin w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full mx-auto mb-3" />
            <p className="text-gray-700 font-medium">Extracting snap points...</p>
            <p className="text-gray-500 text-sm mt-1">This may take a few seconds</p>
          </div>
        </div>
      )}
```

**Step 2: Add extraction error overlay**

Add after the extraction loading indicator:

```typescript
      {/* Vector extraction error */}
      {extractionError && !isExtracting && (
        <div className="absolute top-4 right-20 bg-red-50 border border-red-200 rounded-lg shadow-lg px-4 py-3 z-20 max-w-xs">
          <div className="flex items-start gap-2">
            <span className="text-red-500 text-lg">⚠️</span>
            <div>
              <p className="text-red-700 font-medium text-sm">Snap points unavailable</p>
              <p className="text-red-600 text-xs mt-1">{extractionError}</p>
              <button
                onClick={handleReExtract}
                className="mt-2 text-xs text-red-700 hover:text-red-800 underline"
              >
                Retry extraction
              </button>
            </div>
          </div>
        </div>
      )}
```

**Step 3: Add stale vectors warning**

Add after the extraction error overlay:

```typescript
      {/* Stale vectors warning */}
      {vectorsStale && !isExtracting && !extractionError && (
        <div className="absolute top-4 right-20 bg-yellow-50 border border-yellow-200 rounded-lg shadow-lg px-4 py-3 z-20 max-w-xs">
          <div className="flex items-start gap-2">
            <span className="text-yellow-500 text-lg">⏰</span>
            <div>
              <p className="text-yellow-700 font-medium text-sm">Snap points may be outdated</p>
              <p className="text-yellow-600 text-xs mt-1">Sheet was updated after extraction</p>
              <button
                onClick={handleReExtract}
                className="mt-2 text-xs text-yellow-700 hover:text-yellow-800 underline"
              >
                Re-extract snap points
              </button>
            </div>
          </div>
        </div>
      )}
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/components/takeoff/pdf-viewer.tsx
git commit -m "feat(takeoff): add extraction UI overlays (loading, error, stale)"
```

---

## Task 6: Add Batch Extraction Button to Sheet Panel

**Files:**
- Modify: `src/components/takeoff/sheet-panel.tsx`

**Step 1: Add state for batch extraction at top of component (after line 16)**

```typescript
  const [isBatchExtracting, setIsBatchExtracting] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number } | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
```

**Step 2: Add batch extraction handler after handleCancelRename (around line 99)**

```typescript
  const handleBatchExtractVectors = async () => {
    if (!project) return;

    setIsBatchExtracting(true);
    setBatchError(null);
    setBatchProgress({ completed: 0, total: sheets.length });

    try {
      const response = await fetch('/api/takeoff/vectors/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Batch extraction failed');
      }

      const data = await response.json();
      setBatchProgress({ completed: data.completed, total: data.total });

      if (data.failed > 0) {
        setBatchError(`${data.failed} of ${data.total} sheets failed to extract`);
      }

      // Refresh project to update vectorsReady flags
      // The parent component should handle this, but for now we just update local state
      if (project) {
        setProject({
          ...project,
          sheets: project.sheets.map(sheet => {
            const result = data.results.find((r: { sheetId: string }) => r.sheetId === sheet.id);
            if (result?.success) {
              return { ...sheet, vectorsReady: true, vectorQuality: result.quality };
            }
            return sheet;
          }),
        });
      }
    } catch (err) {
      console.error('Batch extraction failed:', err);
      setBatchError(err instanceof Error ? err.message : 'Batch extraction failed');
    } finally {
      setIsBatchExtracting(false);
    }
  };
```

**Step 3: Add batch extraction button in header (around line 113, after the "+ Add" button)**

```typescript
          <button
            onClick={handleBatchExtractVectors}
            disabled={isBatchExtracting || sheets.length === 0}
            className="text-xs px-2 py-1 text-green-600 hover:bg-green-50 rounded disabled:opacity-50 disabled:cursor-not-allowed"
            title="Extract snap points for all sheets"
          >
            {isBatchExtracting ? '...' : '⚡ Extract All'}
          </button>
```

**Step 4: Add progress/error indicator in footer (replace lines 228-230)**

```typescript
      {/* Footer */}
      <div className="p-3 border-t bg-gray-50 text-xs text-gray-500 space-y-1">
        <div>{sheets.length} sheets • {measurements.length} measurements</div>

        {/* Batch extraction progress */}
        {isBatchExtracting && batchProgress && (
          <div className="flex items-center gap-2 text-blue-600">
            <div className="animate-spin w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full" />
            <span>Extracting {batchProgress.completed}/{batchProgress.total}...</span>
          </div>
        )}

        {/* Batch extraction error */}
        {batchError && !isBatchExtracting && (
          <div className="text-red-600">
            {batchError}
            <button
              onClick={handleBatchExtractVectors}
              className="ml-2 underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* Batch extraction success */}
        {batchProgress && !isBatchExtracting && !batchError && batchProgress.completed > 0 && (
          <div className="text-green-600">
            ✓ Extracted {batchProgress.completed} sheets
          </div>
        )}
      </div>
```

**Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add src/components/takeoff/sheet-panel.tsx
git commit -m "feat(takeoff): add batch vector extraction UI to sheet panel"
```

---

## Task 7: Integration Test

**Step 1: Start Python vector service**

```bash
cd services/vector-extractor
source ~/stratos/vector-extractor-venv/bin/activate
uvicorn src.main:app --host 0.0.0.0 --port 8001 &
```

**Step 2: Start Next.js dev server**

```bash
npm run dev
```

**Step 3: Manual testing checklist**

1. Open a takeoff project with multiple sheets
2. Verify "⚡ Extract All" button appears in sheet panel header
3. Click "Extract All" and verify:
   - Button shows loading state
   - Footer shows progress counter
   - Sheet vectorsReady flags update after completion
4. Navigate to a sheet without vectors:
   - Verify extraction loading overlay appears
   - Verify snap points work after extraction
5. Force an extraction error (e.g., stop Python service):
   - Verify error message appears with retry button
   - Verify retry works after restarting service

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(takeoff): complete vector extraction UX improvements

- Batch extraction API for all project sheets
- Progress indicator during extraction
- Error handling with retry functionality
- Stale vector detection and re-extraction prompt"
```

---

## Summary

| Task | Component | Description |
|------|-----------|-------------|
| 1 | Validation | Zod schema for batch extraction |
| 2 | API | Batch extraction endpoint |
| 3 | API | Stale vector detection |
| 4 | Frontend | Extraction state management |
| 5 | Frontend | Loading/error/stale UI overlays |
| 6 | Frontend | Batch extraction button + progress |
| 7 | Testing | Manual integration test |

---

## Future Improvements (Backlog)

### Large PDF Support (100MB+)

**Problem:** Current implementation sends PDFs as base64 over HTTP, adding 33% overhead and requiring full PDF in Node.js memory.

**Solution:** Add file-path mode to Python service for local deployments:

```python
# Python service accepts either:
# 1. pdfData (base64) - for remote/serverless
# 2. pdfPath (string) - for local/same-server deployment

class SyncExtractionRequest(BaseModel):
    pdfData: Optional[str] = None  # Base64 encoded PDF
    pdfPath: Optional[str] = None  # Direct file path (local only)
    pageNum: int = 1
    scale: float = 1.5
```

```typescript
// Next.js checks if Python service is local
if (isLocalPythonService) {
  // Send file path directly - no base64 overhead
  body: JSON.stringify({ pdfPath: absolutePath, pageNum, scale })
} else {
  // Send base64 for remote deployments
  body: JSON.stringify({ pdfData: base64, pageNum, scale })
}
```

**Benefits:**
- Eliminates base64 encoding overhead (33% size reduction)
- No memory duplication in Node.js
- Handles 100MB+ PDFs without issues
- PyMuPDF streams directly from disk

**Priority:** Low (current 41MB limit sufficient for most construction PDFs)
