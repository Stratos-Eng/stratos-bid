# Takeoff Measurement System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the view-only OpenLayers PDF viewer into a full interactive measurement and takeoff tool with drawing, snapping, scale calibration, and keyboard-first workflows.

**Architecture:** Server-side vector extraction (Python/PyMuPDF) generates snap geometry stored in PostgreSQL. Client-side OpenLayers handles drawing interactions with real-time snapping to extracted vectors. Zustand manages tool state, measurements, and scale. All interactions are keyboard-accessible.

**Tech Stack:**
- Backend: Python 3.11+, PyMuPDF (fitz), FastAPI, Celery/Redis
- Frontend: React 19, OpenLayers 10, Zustand 5, TypeScript 5
- Database: PostgreSQL + Drizzle ORM (existing)
- Storage: Local filesystem (tiles), PostgreSQL (vectors/measurements)

---

## Table of Contents

1. [Module 1: Vector Extraction Backend](#module-1-vector-extraction-backend) - Python service to extract PDF vectors
2. [Module 2: Scale System](#module-2-scale-system) - Manual scale calibration UI
3. [Module 3: Drawing Tools](#module-3-drawing-tools) - Count, Linear, Area measurement tools
4. [Module 4: Snap System](#module-4-snap-system) - Snap to vectors, annotations, visual feedback
5. [Module 5: Keyboard Shortcuts](#module-5-keyboard-shortcuts) - Full keyboard-first interaction
6. [Execution Plan](#execution-plan) - Phased rollout with checkpoints

---

## Dependencies Between Modules

```
Module 1: Vector Extraction ──┐
                              ├──► Module 4: Snap System ──┐
Module 2: Scale System ───────┤                            ├──► Module 5: Keyboard Shortcuts
                              │                            │
Module 3: Drawing Tools ──────┴────────────────────────────┘
```

**Critical Path:** Module 1 → Module 4 (snapping needs vectors)
**Parallel Work:** Module 2 + Module 3 can proceed while Module 1 builds

---

## Module 1: Vector Extraction Backend

**Purpose:** Extract vector geometry (lines, paths, shapes) from PDF pages for snapping. This is the foundation - without vectors, snapping is impossible.

**Deliverables:**
- Python FastAPI service with `/extract` endpoint
- Vector extraction using PyMuPDF
- Snap point generation (endpoints, midpoints, intersections)
- Quality assessment (good/medium/poor/none)
- Database storage via API callback to Next.js
- Background processing with status polling

### Task 1.1: Python Project Setup

**Files:**
- Create: `services/vector-extractor/pyproject.toml`
- Create: `services/vector-extractor/src/__init__.py`
- Create: `services/vector-extractor/src/main.py`
- Create: `services/vector-extractor/.env.example`

**Step 1: Create project directory structure**

```bash
cd /Users/hamza/stratos/stratos-bid/.worktrees/openlayers-viewer
mkdir -p services/vector-extractor/src
mkdir -p services/vector-extractor/tests
```

**Step 2: Create pyproject.toml**

```toml
# services/vector-extractor/pyproject.toml
[project]
name = "vector-extractor"
version = "0.1.0"
description = "PDF vector extraction service for takeoff snapping"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.34.0",
    "pymupdf>=1.25.0",
    "pydantic>=2.10.0",
    "httpx>=0.28.0",
    "python-multipart>=0.0.20",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.25.0",
    "httpx>=0.28.0",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

**Step 3: Create main FastAPI application**

```python
# services/vector-extractor/src/main.py
"""
Vector Extraction Service

Extracts vector geometry from PDF pages for snapping in the takeoff tool.
"""
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import uuid

app = FastAPI(
    title="Vector Extractor",
    description="PDF vector extraction for takeoff snapping",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job status (replace with Redis in production)
jobs: dict[str, dict] = {}


class ExtractionRequest(BaseModel):
    document_id: str
    page_number: int
    pdf_path: str
    callback_url: str  # Next.js API to receive results


class ExtractionStatus(BaseModel):
    job_id: str
    status: str  # pending, processing, completed, failed
    progress: Optional[float] = None
    error: Optional[str] = None


@app.get("/health")
async def health():
    return {"status": "ok", "service": "vector-extractor"}


@app.post("/extract", response_model=ExtractionStatus)
async def extract_vectors(request: ExtractionRequest, background_tasks: BackgroundTasks):
    """
    Queue vector extraction for a PDF page.
    Returns immediately with job_id for status polling.
    """
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "status": "pending",
        "progress": 0,
        "request": request.model_dump(),
    }

    # Queue background extraction
    background_tasks.add_task(run_extraction, job_id, request)

    return ExtractionStatus(job_id=job_id, status="pending", progress=0)


@app.get("/status/{job_id}", response_model=ExtractionStatus)
async def get_status(job_id: str):
    """Get extraction job status."""
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]
    return ExtractionStatus(
        job_id=job_id,
        status=job["status"],
        progress=job.get("progress"),
        error=job.get("error"),
    )


async def run_extraction(job_id: str, request: ExtractionRequest):
    """Background task to extract vectors."""
    # Import here to avoid startup delay
    from .extractor import extract_page_vectors
    import httpx

    jobs[job_id]["status"] = "processing"
    jobs[job_id]["progress"] = 0.1

    try:
        # Extract vectors
        result = extract_page_vectors(
            pdf_path=request.pdf_path,
            page_number=request.page_number,
            on_progress=lambda p: jobs[job_id].update({"progress": p}),
        )

        jobs[job_id]["progress"] = 0.9

        # Send results to callback URL
        async with httpx.AsyncClient() as client:
            await client.post(
                request.callback_url,
                json={
                    "document_id": request.document_id,
                    "page_number": request.page_number,
                    "vectors": result,
                },
                timeout=30.0,
            )

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["progress"] = 1.0

    except Exception as e:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(e)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
```

**Step 4: Create .env.example**

```bash
# services/vector-extractor/.env.example
# Vector Extractor Service Configuration

# Server
HOST=0.0.0.0
PORT=8001

# Callback URL (Next.js API)
NEXTJS_API_URL=http://localhost:3000/api

# PDF Storage Path
PDF_STORAGE_PATH=/tmp/pdfs
```

**Step 5: Commit**

```bash
git add services/vector-extractor/
git commit -m "feat(vector-extractor): initialize Python FastAPI service

- Add pyproject.toml with FastAPI, PyMuPDF dependencies
- Add main.py with /extract and /status endpoints
- Add background task infrastructure for async extraction"
```

---

### Task 1.2: Vector Extraction Core Logic

**Files:**
- Create: `services/vector-extractor/src/extractor.py`
- Create: `services/vector-extractor/src/geometry.py`
- Test: `services/vector-extractor/tests/test_extractor.py`

**Step 1: Create geometry utilities**

```python
# services/vector-extractor/src/geometry.py
"""
Geometry utilities for vector processing.
"""
import math
from typing import TypeAlias

Point: TypeAlias = tuple[float, float]
Line: TypeAlias = tuple[Point, Point]


def distance(p1: Point, p2: Point) -> float:
    """Euclidean distance between two points."""
    return math.sqrt((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2)


def midpoint(p1: Point, p2: Point) -> Point:
    """Midpoint of a line segment."""
    return ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)


def line_angle(line: Line) -> float:
    """Angle of line in radians, normalized to [0, π)."""
    dx = line[1][0] - line[0][0]
    dy = line[1][1] - line[0][1]
    angle = math.atan2(dy, dx)
    # Normalize to [0, π) for direction-agnostic comparison
    if angle < 0:
        angle += math.pi
    if angle >= math.pi:
        angle -= math.pi
    return angle


def lines_collinear(line1: Line, line2: Line, angle_tolerance: float = 0.05) -> bool:
    """Check if two lines are approximately collinear."""
    angle1 = line_angle(line1)
    angle2 = line_angle(line2)
    angle_diff = abs(angle1 - angle2)
    # Handle wrap-around near π
    if angle_diff > math.pi / 2:
        angle_diff = math.pi - angle_diff
    return angle_diff < angle_tolerance


def point_on_line(point: Point, line: Line, tolerance: float = 2.0) -> bool:
    """Check if a point lies on a line segment within tolerance."""
    # Distance from point to line
    x, y = point
    x1, y1 = line[0]
    x2, y2 = line[1]

    line_len = distance(line[0], line[1])
    if line_len < 0.001:
        return distance(point, line[0]) < tolerance

    # Perpendicular distance
    dist = abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / line_len

    if dist > tolerance:
        return False

    # Check if point is between endpoints
    t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / (line_len ** 2)
    return -0.01 <= t <= 1.01


def line_intersection(line1: Line, line2: Line) -> Point | None:
    """
    Find intersection point of two line segments.
    Returns None if lines don't intersect or are parallel.
    """
    x1, y1 = line1[0]
    x2, y2 = line1[1]
    x3, y3 = line2[0]
    x4, y4 = line2[1]

    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 0.0001:
        return None  # Parallel or coincident

    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom

    # Check if intersection is within both segments
    if 0 <= t <= 1 and 0 <= u <= 1:
        x = x1 + t * (x2 - x1)
        y = y1 + t * (y2 - y1)
        return (x, y)

    return None


def dedupe_points(points: list[dict], tolerance: float = 2.0) -> list[dict]:
    """Remove duplicate points within tolerance, keeping highest priority type."""
    if not points:
        return []

    # Priority: intersection > endpoint > midpoint
    type_priority = {"intersection": 0, "endpoint": 1, "midpoint": 2}

    # Sort by priority so we keep best type when deduping
    sorted_points = sorted(points, key=lambda p: type_priority.get(p["type"], 99))

    result = []
    for point in sorted_points:
        coords = point["coords"]
        is_dup = False
        for existing in result:
            if distance(coords, existing["coords"]) < tolerance:
                is_dup = True
                break
        if not is_dup:
            result.append(point)

    return result
```

**Step 2: Create extractor core logic**

```python
# services/vector-extractor/src/extractor.py
"""
PDF vector extraction using PyMuPDF.

Extracts lines, rectangles, and paths from PDF pages,
cleans them for snapping use, and generates snap points.
"""
import fitz  # PyMuPDF
from typing import Callable
from .geometry import (
    distance, midpoint, line_intersection, dedupe_points,
    lines_collinear, Point, Line
)


# Minimum line length to keep (pixels at 150 DPI)
MIN_LINE_LENGTH = 5.0

# Tolerance for merging collinear segments
MERGE_TOLERANCE = 3.0


def extract_page_vectors(
    pdf_path: str,
    page_number: int,
    dpi: float = 150.0,
    on_progress: Callable[[float], None] | None = None,
) -> dict:
    """
    Extract and clean vectors from a PDF page.

    Args:
        pdf_path: Path to PDF file
        page_number: 0-indexed page number
        dpi: Resolution for coordinate scaling
        on_progress: Optional callback for progress updates (0.0 to 1.0)

    Returns:
        {
            "lines": [{"start": [x, y], "end": [x, y], "width": float}, ...],
            "snap_points": [{"type": str, "coords": [x, y]}, ...],
            "quality": "good" | "medium" | "poor" | "none",
            "stats": {"raw_count": int, "cleaned_count": int, "snap_count": int}
        }
    """
    if on_progress:
        on_progress(0.1)

    doc = fitz.open(pdf_path)
    if page_number >= len(doc):
        doc.close()
        raise ValueError(f"Page {page_number} not found (document has {len(doc)} pages)")

    page = doc[page_number]

    # Scale factor: PDF points (72 DPI) to our coordinate system
    scale = dpi / 72.0

    if on_progress:
        on_progress(0.2)

    # Extract raw paths
    raw_lines = extract_raw_lines(page, scale)
    raw_count = len(raw_lines)

    if on_progress:
        on_progress(0.4)

    # Clean and filter
    cleaned_lines = clean_lines(raw_lines)

    if on_progress:
        on_progress(0.6)

    # Generate snap points
    snap_points = generate_snap_points(cleaned_lines)

    if on_progress:
        on_progress(0.8)

    # Assess quality
    quality = assess_quality(raw_count, len(cleaned_lines), len(snap_points))

    doc.close()

    if on_progress:
        on_progress(1.0)

    return {
        "lines": [
            {"start": list(line["start"]), "end": list(line["end"]), "width": line["width"]}
            for line in cleaned_lines
        ],
        "snap_points": [
            {"type": sp["type"], "coords": list(sp["coords"])}
            for sp in snap_points
        ],
        "quality": quality,
        "stats": {
            "raw_count": raw_count,
            "cleaned_count": len(cleaned_lines),
            "snap_count": len(snap_points),
        },
    }


def extract_raw_lines(page: fitz.Page, scale: float) -> list[dict]:
    """Extract raw line segments from page drawings."""
    lines = []

    for drawing in page.get_drawings():
        items = drawing.get("items", [])

        for item in items:
            item_type = item[0]

            if item_type == "l":  # Line
                # item = ("l", p1, p2)
                p1 = (item[1].x * scale, item[1].y * scale)
                p2 = (item[2].x * scale, item[2].y * scale)
                width = drawing.get("width", 1.0) * scale
                lines.append({"start": p1, "end": p2, "width": width})

            elif item_type == "re":  # Rectangle
                # item = ("re", rect)
                rect = item[1]
                x0, y0 = rect.x0 * scale, rect.y0 * scale
                x1, y1 = rect.x1 * scale, rect.y1 * scale
                width = drawing.get("width", 1.0) * scale
                # Add 4 lines for rectangle
                lines.append({"start": (x0, y0), "end": (x1, y0), "width": width})
                lines.append({"start": (x1, y0), "end": (x1, y1), "width": width})
                lines.append({"start": (x1, y1), "end": (x0, y1), "width": width})
                lines.append({"start": (x0, y1), "end": (x0, y0), "width": width})

            elif item_type == "c":  # Curve (bezier)
                # Approximate with line from start to end
                # item = ("c", p1, p2, p3, p4)
                p1 = (item[1].x * scale, item[1].y * scale)
                p4 = (item[4].x * scale, item[4].y * scale)
                width = drawing.get("width", 1.0) * scale
                lines.append({"start": p1, "end": p4, "width": width})

    return lines


def clean_lines(lines: list[dict]) -> list[dict]:
    """
    Clean line segments:
    1. Filter too-short lines
    2. Merge collinear segments
    3. Remove likely hatching patterns
    """
    # Step 1: Filter short lines
    filtered = [
        line for line in lines
        if distance(line["start"], line["end"]) >= MIN_LINE_LENGTH
    ]

    # Step 2: Merge collinear segments
    merged = merge_collinear_segments(filtered)

    # Step 3: Remove hatching (TODO: implement heuristic)
    # For now, skip this step

    return merged


def merge_collinear_segments(lines: list[dict]) -> list[dict]:
    """Merge collinear line segments that are close together."""
    if len(lines) < 2:
        return lines

    result = []
    used = set()

    for i, line1 in enumerate(lines):
        if i in used:
            continue

        current = line1.copy()
        used.add(i)

        # Look for lines to merge
        for j, line2 in enumerate(lines):
            if j in used or j == i:
                continue

            l1 = (current["start"], current["end"])
            l2 = (line2["start"], line2["end"])

            if not lines_collinear(l1, l2):
                continue

            # Check if endpoints are close
            min_dist = min(
                distance(current["end"], line2["start"]),
                distance(current["end"], line2["end"]),
                distance(current["start"], line2["start"]),
                distance(current["start"], line2["end"]),
            )

            if min_dist < MERGE_TOLERANCE:
                # Merge by extending to furthest points
                all_points = [current["start"], current["end"], line2["start"], line2["end"]]
                # Find the two points with maximum distance
                max_dist = 0
                best_pair = (all_points[0], all_points[1])
                for pi, p1 in enumerate(all_points):
                    for p2 in all_points[pi + 1:]:
                        d = distance(p1, p2)
                        if d > max_dist:
                            max_dist = d
                            best_pair = (p1, p2)

                current["start"] = best_pair[0]
                current["end"] = best_pair[1]
                current["width"] = max(current["width"], line2["width"])
                used.add(j)

        result.append(current)

    return result


def generate_snap_points(lines: list[dict]) -> list[dict]:
    """Generate snap points from cleaned lines."""
    points = []

    # Endpoints and midpoints
    for line in lines:
        points.append({"type": "endpoint", "coords": line["start"]})
        points.append({"type": "endpoint", "coords": line["end"]})
        points.append({"type": "midpoint", "coords": midpoint(line["start"], line["end"])})

    # Intersections
    for i, line1 in enumerate(lines):
        for line2 in lines[i + 1:]:
            l1 = (line1["start"], line1["end"])
            l2 = (line2["start"], line2["end"])
            intersection = line_intersection(l1, l2)
            if intersection:
                points.append({"type": "intersection", "coords": intersection})

    # Dedupe nearby points
    return dedupe_points(points, tolerance=2.0)


def assess_quality(raw_count: int, cleaned_count: int, snap_count: int) -> str:
    """
    Assess vector quality for snapping.

    Returns:
        "good": >70% of paths survived cleaning, good snap density
        "medium": 30-70% survived
        "poor": <30% survived or too dense (likely garbage)
        "none": No vectors found (scanned PDF)
    """
    if raw_count == 0:
        return "none"

    survival_rate = cleaned_count / raw_count

    if survival_rate >= 0.7 and snap_count >= 10:
        return "good"
    elif survival_rate >= 0.3:
        return "medium"
    else:
        return "poor"
```

**Step 3: Write tests**

```python
# services/vector-extractor/tests/test_extractor.py
"""Tests for vector extraction."""
import pytest
from src.geometry import distance, midpoint, line_intersection, dedupe_points


class TestGeometry:
    def test_distance(self):
        assert distance((0, 0), (3, 4)) == 5.0
        assert distance((0, 0), (0, 0)) == 0.0

    def test_midpoint(self):
        assert midpoint((0, 0), (10, 10)) == (5.0, 5.0)
        assert midpoint((0, 0), (0, 0)) == (0.0, 0.0)

    def test_line_intersection_crossing(self):
        # Two lines that cross
        line1 = ((0, 0), (10, 10))
        line2 = ((0, 10), (10, 0))
        result = line_intersection(line1, line2)
        assert result is not None
        assert abs(result[0] - 5.0) < 0.01
        assert abs(result[1] - 5.0) < 0.01

    def test_line_intersection_parallel(self):
        # Parallel lines
        line1 = ((0, 0), (10, 0))
        line2 = ((0, 5), (10, 5))
        result = line_intersection(line1, line2)
        assert result is None

    def test_line_intersection_no_overlap(self):
        # Lines that would intersect if extended
        line1 = ((0, 0), (5, 0))
        line2 = ((10, 0), (10, 10))
        result = line_intersection(line1, line2)
        assert result is None

    def test_dedupe_points(self):
        points = [
            {"type": "endpoint", "coords": (0, 0)},
            {"type": "endpoint", "coords": (0.5, 0.5)},  # Close to first
            {"type": "midpoint", "coords": (10, 10)},
            {"type": "intersection", "coords": (0.1, 0.1)},  # Close to first, higher priority
        ]
        result = dedupe_points(points, tolerance=2.0)

        # Should keep intersection (highest priority) and midpoint
        assert len(result) == 2
        types = {p["type"] for p in result}
        assert "intersection" in types
        assert "midpoint" in types
```

**Step 4: Run tests**

```bash
cd services/vector-extractor
pip install -e ".[dev]"
pytest tests/ -v
```

Expected: All tests pass

**Step 5: Commit**

```bash
git add services/vector-extractor/src/extractor.py
git add services/vector-extractor/src/geometry.py
git add services/vector-extractor/tests/test_extractor.py
git commit -m "feat(vector-extractor): add core extraction logic

- Add geometry utilities (distance, midpoint, intersection)
- Add PyMuPDF-based vector extraction
- Add line cleaning and merging
- Add snap point generation
- Add quality assessment
- Add unit tests for geometry functions"
```

---

### Task 1.3: Database Schema for Vectors

**Files:**
- Modify: `src/db/schema.ts` (add sheetVectors table)
- Create: `drizzle/0002_add_sheet_vectors.sql` (migration)

**Step 1: Add sheetVectors table to schema**

```typescript
// Add to src/db/schema.ts after lineItems table

export const sheetVectors = pgTable("sheet_vectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),

  // Vector data (stored as JSONB for flexibility)
  lines: jsonb("lines").$type<Array<{
    start: [number, number];
    end: [number, number];
    width: number;
  }>>().default([]),

  snapPoints: jsonb("snap_points").$type<Array<{
    type: "endpoint" | "midpoint" | "intersection";
    coords: [number, number];
  }>>().default([]),

  // Quality assessment
  quality: text("quality").$type<"good" | "medium" | "poor" | "none">().default("none"),

  // Stats
  rawCount: integer("raw_count").default(0),
  cleanedCount: integer("cleaned_count").default(0),
  snapCount: integer("snap_count").default(0),

  // Extraction status
  extractionStatus: text("extraction_status")
    .$type<"pending" | "processing" | "completed" | "failed">()
    .default("pending"),
  extractionError: text("extraction_error"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  docPageIdx: uniqueIndex("sheet_vectors_doc_page_idx").on(table.documentId, table.pageNumber),
}));
```

**Step 2: Generate migration**

```bash
npx drizzle-kit generate
```

**Step 3: Run migration**

```bash
npx drizzle-kit migrate
```

**Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): add sheet_vectors table for snap geometry

- Store extracted lines and snap points per page
- Track quality assessment (good/medium/poor/none)
- Track extraction status and errors
- Add unique index on (document_id, page_number)"
```

---

### Task 1.4: Next.js API for Vector Storage

**Files:**
- Create: `src/app/api/vectors/route.ts` (receive extraction results)
- Create: `src/app/api/vectors/[documentId]/[pageNumber]/route.ts` (fetch vectors)

**Step 1: Create POST endpoint to receive extraction results**

```typescript
// src/app/api/vectors/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sheetVectors } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

const VectorResultSchema = z.object({
  document_id: z.string().uuid(),
  page_number: z.number().int().min(0),
  vectors: z.object({
    lines: z.array(z.object({
      start: z.tuple([z.number(), z.number()]),
      end: z.tuple([z.number(), z.number()]),
      width: z.number(),
    })),
    snap_points: z.array(z.object({
      type: z.enum(["endpoint", "midpoint", "intersection"]),
      coords: z.tuple([z.number(), z.number()]),
    })),
    quality: z.enum(["good", "medium", "poor", "none"]),
    stats: z.object({
      raw_count: z.number(),
      cleaned_count: z.number(),
      snap_count: z.number(),
    }),
  }),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = VectorResultSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.format() },
        { status: 400 }
      );
    }

    const { document_id, page_number, vectors } = parsed.data;

    // Upsert vector data
    await db
      .insert(sheetVectors)
      .values({
        documentId: document_id,
        pageNumber: page_number,
        lines: vectors.lines,
        snapPoints: vectors.snap_points,
        quality: vectors.quality,
        rawCount: vectors.stats.raw_count,
        cleanedCount: vectors.stats.cleaned_count,
        snapCount: vectors.stats.snap_count,
        extractionStatus: "completed",
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [sheetVectors.documentId, sheetVectors.pageNumber],
        set: {
          lines: vectors.lines,
          snapPoints: vectors.snap_points,
          quality: vectors.quality,
          rawCount: vectors.stats.raw_count,
          cleanedCount: vectors.stats.cleaned_count,
          snapCount: vectors.stats.snap_count,
          extractionStatus: "completed",
          updatedAt: new Date(),
        },
      });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error storing vectors:", error);
    return NextResponse.json(
      { error: "Failed to store vectors" },
      { status: 500 }
    );
  }
}
```

**Step 2: Create GET endpoint to fetch vectors**

```typescript
// src/app/api/vectors/[documentId]/[pageNumber]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sheetVectors } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string; pageNumber: string }> }
) {
  const { documentId, pageNumber } = await params;
  const pageNum = parseInt(pageNumber, 10);

  if (isNaN(pageNum) || pageNum < 0) {
    return NextResponse.json(
      { error: "Invalid page number" },
      { status: 400 }
    );
  }

  try {
    const result = await db
      .select()
      .from(sheetVectors)
      .where(
        and(
          eq(sheetVectors.documentId, documentId),
          eq(sheetVectors.pageNumber, pageNum)
        )
      )
      .limit(1);

    if (result.length === 0) {
      return NextResponse.json(
        { error: "Vectors not found", status: "not_extracted" },
        { status: 404 }
      );
    }

    const vectors = result[0];

    return NextResponse.json({
      documentId: vectors.documentId,
      pageNumber: vectors.pageNumber,
      lines: vectors.lines,
      snapPoints: vectors.snapPoints,
      quality: vectors.quality,
      extractionStatus: vectors.extractionStatus,
      stats: {
        rawCount: vectors.rawCount,
        cleanedCount: vectors.cleanedCount,
        snapCount: vectors.snapCount,
      },
    });
  } catch (error) {
    console.error("Error fetching vectors:", error);
    return NextResponse.json(
      { error: "Failed to fetch vectors" },
      { status: 500 }
    );
  }
}
```

**Step 3: Commit**

```bash
git add src/app/api/vectors/
git commit -m "feat(api): add vector storage and retrieval endpoints

- POST /api/vectors - receive extraction results from Python service
- GET /api/vectors/[documentId]/[pageNumber] - fetch vectors for page
- Validate with Zod schema
- Handle upsert for re-extraction"
```

---

### Task 1.5: Trigger Extraction on Document Upload

**Files:**
- Modify: `src/lib/tile-generator.ts` (add extraction trigger)
- Create: `src/lib/vector-client.ts` (Python service client)

**Step 1: Create Python service client**

```typescript
// src/lib/vector-client.ts
/**
 * Client for the Python vector extraction service.
 */

const VECTOR_SERVICE_URL = process.env.VECTOR_SERVICE_URL || "http://localhost:8001";

interface ExtractionRequest {
  documentId: string;
  pageNumber: number;
  pdfPath: string;
}

interface ExtractionStatus {
  job_id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  error?: string;
}

export async function triggerVectorExtraction(
  request: ExtractionRequest
): Promise<ExtractionStatus> {
  const callbackUrl = `${process.env.NEXTAUTH_URL || "http://localhost:3000"}/api/vectors`;

  const response = await fetch(`${VECTOR_SERVICE_URL}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_id: request.documentId,
      page_number: request.pageNumber,
      pdf_path: request.pdfPath,
      callback_url: callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(`Vector extraction failed: ${response.statusText}`);
  }

  return response.json();
}

export async function getExtractionStatus(jobId: string): Promise<ExtractionStatus> {
  const response = await fetch(`${VECTOR_SERVICE_URL}/status/${jobId}`);

  if (!response.ok) {
    throw new Error(`Failed to get extraction status: ${response.statusText}`);
  }

  return response.json();
}

export async function extractAllPages(
  documentId: string,
  pdfPath: string,
  pageCount: number
): Promise<string[]> {
  const jobIds: string[] = [];

  for (let page = 0; page < pageCount; page++) {
    try {
      const result = await triggerVectorExtraction({
        documentId,
        pageNumber: page,
        pdfPath,
      });
      jobIds.push(result.job_id);
    } catch (error) {
      console.error(`Failed to trigger extraction for page ${page}:`, error);
    }
  }

  return jobIds;
}
```

**Step 2: Commit**

```bash
git add src/lib/vector-client.ts
git commit -m "feat: add Python vector service client

- triggerVectorExtraction() to queue extraction
- getExtractionStatus() to poll job status
- extractAllPages() helper for full documents"
```

---

This completes **Module 1: Vector Extraction Backend**.

**Checkpoint:** At this point you have:
- ✅ Python FastAPI service with extraction endpoint
- ✅ PyMuPDF-based vector extraction with cleaning
- ✅ Snap point generation (endpoints, midpoints, intersections)
- ✅ Database schema for storing vectors
- ✅ Next.js API for storing/retrieving vectors
- ✅ Client to trigger extraction from Next.js

---

## Module 2: Scale System

**Purpose:** Allow users to calibrate the scale of each sheet so measurements are accurate. Without correct scale, linear and area measurements are meaningless.

**Deliverables:**
- Scale calibration modal (click two points, enter distance)
- Scale state in Zustand store
- Scale persistence in database
- Scale indicator in UI
- Pixels-to-real-world conversion utilities

### Task 2.1: Database Schema for Scale

**Files:**
- Modify: `src/db/schema.ts` (add scale fields to documents table)

**Step 1: Add scale fields to documents table**

```typescript
// In src/db/schema.ts, modify the documents table to add:

// After existing fields, add:
  // Scale calibration
  scalePixelsPerFoot: real("scale_pixels_per_foot"),  // null = not calibrated
  scaleSource: text("scale_source").$type<
    "manual" | "auto_titleblock" | "auto_scalebar" | "auto_dimension" | null
  >(),
  scaleConfidence: real("scale_confidence"),  // 0-1, null for manual
  scaleCalibrationData: jsonb("scale_calibration_data").$type<{
    point1: [number, number];
    point2: [number, number];
    distanceFeet: number;
    distanceInches: number;
  } | null>(),
```

**Step 2: Generate and run migration**

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

**Step 3: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): add scale calibration fields to documents table

- scalePixelsPerFoot for conversion calculations
- scaleSource to track how scale was determined
- scaleConfidence for auto-detected scales
- scaleCalibrationData to store click points for re-calibration"
```

---

### Task 2.2: Scale Store (Zustand)

**Files:**
- Create: `src/lib/stores/scale-store.ts`

**Step 1: Create the scale store**

```typescript
// src/lib/stores/scale-store.ts
import { create } from "zustand";

interface CalibrationPoint {
  x: number;
  y: number;
}

interface CalibrationData {
  point1: CalibrationPoint;
  point2: CalibrationPoint;
  distanceFeet: number;
  distanceInches: number;
}

interface ScaleState {
  // Current calibration mode
  isCalibrating: boolean;
  calibrationStep: "idle" | "point1" | "point2" | "input";

  // Calibration in progress
  pendingPoint1: CalibrationPoint | null;
  pendingPoint2: CalibrationPoint | null;

  // Per-document scale data (documentId -> scale)
  documentScales: Map<string, {
    pixelsPerFoot: number;
    source: "manual" | "auto_titleblock" | "auto_scalebar" | "auto_dimension";
    confidence: number | null;
    calibrationData: CalibrationData | null;
  }>;

  // Actions
  startCalibration: () => void;
  cancelCalibration: () => void;
  setPoint1: (point: CalibrationPoint) => void;
  setPoint2: (point: CalibrationPoint) => void;
  completeCalibration: (
    documentId: string,
    distanceFeet: number,
    distanceInches: number
  ) => number; // Returns pixelsPerFoot

  setDocumentScale: (
    documentId: string,
    pixelsPerFoot: number,
    source: "manual" | "auto_titleblock" | "auto_scalebar" | "auto_dimension",
    confidence?: number,
    calibrationData?: CalibrationData
  ) => void;

  getDocumentScale: (documentId: string) => number | null;
  hasScale: (documentId: string) => boolean;

  // Conversion utilities
  pixelsToFeet: (documentId: string, pixels: number) => number | null;
  pixelsToInches: (documentId: string, pixels: number) => number | null;
  pixelsToSquareFeet: (documentId: string, squarePixels: number) => number | null;
  formatDistance: (documentId: string, pixels: number) => string;
  formatArea: (documentId: string, squarePixels: number) => string;
}

export const useScaleStore = create<ScaleState>((set, get) => ({
  // Initial state
  isCalibrating: false,
  calibrationStep: "idle",
  pendingPoint1: null,
  pendingPoint2: null,
  documentScales: new Map(),

  // Start calibration mode
  startCalibration: () => {
    set({
      isCalibrating: true,
      calibrationStep: "point1",
      pendingPoint1: null,
      pendingPoint2: null,
    });
  },

  // Cancel calibration
  cancelCalibration: () => {
    set({
      isCalibrating: false,
      calibrationStep: "idle",
      pendingPoint1: null,
      pendingPoint2: null,
    });
  },

  // Set first calibration point
  setPoint1: (point) => {
    set({
      pendingPoint1: point,
      calibrationStep: "point2",
    });
  },

  // Set second calibration point
  setPoint2: (point) => {
    set({
      pendingPoint2: point,
      calibrationStep: "input",
    });
  },

  // Complete calibration with distance input
  completeCalibration: (documentId, distanceFeet, distanceInches) => {
    const state = get();
    const { pendingPoint1, pendingPoint2 } = state;

    if (!pendingPoint1 || !pendingPoint2) {
      throw new Error("Calibration points not set");
    }

    // Calculate pixel distance
    const dx = pendingPoint2.x - pendingPoint1.x;
    const dy = pendingPoint2.y - pendingPoint1.y;
    const pixelDistance = Math.sqrt(dx * dx + dy * dy);

    // Convert to total feet
    const totalFeet = distanceFeet + distanceInches / 12;

    if (totalFeet <= 0) {
      throw new Error("Distance must be positive");
    }

    // Calculate pixels per foot
    const pixelsPerFoot = pixelDistance / totalFeet;

    // Store calibration data
    const calibrationData: CalibrationData = {
      point1: pendingPoint1,
      point2: pendingPoint2,
      distanceFeet,
      distanceInches,
    };

    // Update document scale
    const newScales = new Map(state.documentScales);
    newScales.set(documentId, {
      pixelsPerFoot,
      source: "manual",
      confidence: null,
      calibrationData,
    });

    set({
      documentScales: newScales,
      isCalibrating: false,
      calibrationStep: "idle",
      pendingPoint1: null,
      pendingPoint2: null,
    });

    return pixelsPerFoot;
  },

  // Set scale directly (for loading from DB or auto-detection)
  setDocumentScale: (documentId, pixelsPerFoot, source, confidence, calibrationData) => {
    const newScales = new Map(get().documentScales);
    newScales.set(documentId, {
      pixelsPerFoot,
      source,
      confidence: confidence ?? null,
      calibrationData: calibrationData ?? null,
    });
    set({ documentScales: newScales });
  },

  // Get scale for document
  getDocumentScale: (documentId) => {
    const scale = get().documentScales.get(documentId);
    return scale?.pixelsPerFoot ?? null;
  },

  // Check if document has scale
  hasScale: (documentId) => {
    return get().documentScales.has(documentId);
  },

  // Conversion: pixels to feet
  pixelsToFeet: (documentId, pixels) => {
    const ppf = get().getDocumentScale(documentId);
    if (ppf === null) return null;
    return pixels / ppf;
  },

  // Conversion: pixels to inches
  pixelsToInches: (documentId, pixels) => {
    const feet = get().pixelsToFeet(documentId, pixels);
    if (feet === null) return null;
    return feet * 12;
  },

  // Conversion: square pixels to square feet
  pixelsToSquareFeet: (documentId, squarePixels) => {
    const ppf = get().getDocumentScale(documentId);
    if (ppf === null) return null;
    return squarePixels / (ppf * ppf);
  },

  // Format distance as feet-inches string
  formatDistance: (documentId, pixels) => {
    const totalFeet = get().pixelsToFeet(documentId, pixels);
    if (totalFeet === null) return "No scale";

    const feet = Math.floor(totalFeet);
    const inches = Math.round((totalFeet - feet) * 12);

    if (inches === 12) {
      return `${feet + 1}'-0"`;
    }
    return `${feet}'-${inches}"`;
  },

  // Format area as square feet string
  formatArea: (documentId, squarePixels) => {
    const sqft = get().pixelsToSquareFeet(documentId, squarePixels);
    if (sqft === null) return "No scale";
    return `${sqft.toFixed(1)} SF`;
  },
}));
```

**Step 2: Commit**

```bash
git add src/lib/stores/scale-store.ts
git commit -m "feat(store): add scale calibration Zustand store

- Calibration flow: startCalibration → setPoint1 → setPoint2 → completeCalibration
- Per-document scale storage with Map
- Conversion utilities: pixelsToFeet, pixelsToSquareFeet
- Formatting: formatDistance (feet-inches), formatArea (SF)"
```

---

### Task 2.3: Scale Calibration UI Component

**Files:**
- Create: `src/components/verification/scale-calibration-modal.tsx`
- Create: `src/components/verification/scale-indicator.tsx`

**Step 1: Create scale calibration modal**

```typescript
// src/components/verification/scale-calibration-modal.tsx
"use client";

import { useState, useEffect } from "react";
import { useScaleStore } from "@/lib/stores/scale-store";

interface ScaleCalibrationModalProps {
  documentId: string;
  onComplete: (pixelsPerFoot: number) => void;
  onCancel: () => void;
}

export function ScaleCalibrationModal({
  documentId,
  onComplete,
  onCancel,
}: ScaleCalibrationModalProps) {
  const {
    calibrationStep,
    pendingPoint1,
    pendingPoint2,
    completeCalibration,
    cancelCalibration,
  } = useScaleStore();

  const [feet, setFeet] = useState("");
  const [inches, setInches] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Calculate pixel distance for preview
  const pixelDistance =
    pendingPoint1 && pendingPoint2
      ? Math.sqrt(
          Math.pow(pendingPoint2.x - pendingPoint1.x, 2) +
            Math.pow(pendingPoint2.y - pendingPoint1.y, 2)
        )
      : 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const feetNum = parseInt(feet) || 0;
    const inchesNum = parseInt(inches) || 0;

    if (feetNum === 0 && inchesNum === 0) {
      setError("Please enter a distance");
      return;
    }

    if (feetNum < 0 || inchesNum < 0) {
      setError("Distance cannot be negative");
      return;
    }

    if (inchesNum >= 12) {
      setError("Inches must be less than 12");
      return;
    }

    try {
      const pixelsPerFoot = completeCalibration(documentId, feetNum, inchesNum);
      onComplete(pixelsPerFoot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Calibration failed");
    }
  };

  const handleCancel = () => {
    cancelCalibration();
    onCancel();
  };

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Show instructions based on step
  if (calibrationStep === "point1") {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-xl p-6 max-w-md">
          <h2 className="text-lg font-semibold mb-4">Scale Calibration</h2>
          <p className="text-gray-600 mb-4">
            Click the <strong>first point</strong> of a known distance on the drawing.
          </p>
          <p className="text-sm text-gray-500 mb-4">
            Tip: Use a dimension line or a known wall length for best accuracy.
          </p>
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
          >
            Cancel (Esc)
          </button>
        </div>
      </div>
    );
  }

  if (calibrationStep === "point2") {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-xl p-6 max-w-md">
          <h2 className="text-lg font-semibold mb-4">Scale Calibration</h2>
          <p className="text-gray-600 mb-4">
            Click the <strong>second point</strong> of the known distance.
          </p>
          {pendingPoint1 && (
            <p className="text-sm text-green-600 mb-4">
              ✓ First point set at ({Math.round(pendingPoint1.x)}, {Math.round(pendingPoint1.y)})
            </p>
          )}
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
          >
            Cancel (Esc)
          </button>
        </div>
      </div>
    );
  }

  if (calibrationStep === "input") {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-xl p-6 max-w-md">
          <h2 className="text-lg font-semibold mb-4">Enter Distance</h2>

          <p className="text-sm text-gray-500 mb-4">
            Measured {Math.round(pixelDistance)} pixels between the two points.
          </p>

          <form onSubmit={handleSubmit}>
            <div className="flex items-center gap-2 mb-4">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Feet</label>
                <input
                  type="number"
                  min="0"
                  value={feet}
                  onChange={(e) => setFeet(e.target.value)}
                  className="w-20 px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500"
                  placeholder="0"
                  autoFocus
                />
              </div>
              <span className="mt-6 text-xl">'-</span>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Inches</label>
                <input
                  type="number"
                  min="0"
                  max="11"
                  value={inches}
                  onChange={(e) => setInches(e.target.value)}
                  className="w-20 px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500"
                  placeholder="0"
                />
              </div>
              <span className="mt-6 text-xl">"</span>
            </div>

            {error && (
              <p className="text-red-500 text-sm mb-4">{error}</p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Set Scale
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return null;
}
```

**Step 2: Create scale indicator component**

```typescript
// src/components/verification/scale-indicator.tsx
"use client";

import { useScaleStore } from "@/lib/stores/scale-store";

interface ScaleIndicatorProps {
  documentId: string;
  onCalibrateClick: () => void;
}

export function ScaleIndicator({ documentId, onCalibrateClick }: ScaleIndicatorProps) {
  const { hasScale, getDocumentScale, documentScales } = useScaleStore();

  const scaleData = documentScales.get(documentId);
  const pixelsPerFoot = getDocumentScale(documentId);

  // Calculate human-readable scale (e.g., "1/4" = 1'-0"")
  const getScaleString = () => {
    if (!pixelsPerFoot) return null;

    // Common architectural scales and their pixels per foot at 150 DPI
    // At 150 DPI: 1" on paper = 150 pixels
    // 1/4" = 1'-0" means 1/4" (37.5 pixels) = 1 foot
    const scales = [
      { name: '1" = 1\'-0"', ppf: 150 },      // Full scale
      { name: '1/2" = 1\'-0"', ppf: 75 },
      { name: '1/4" = 1\'-0"', ppf: 37.5 },
      { name: '1/8" = 1\'-0"', ppf: 18.75 },
      { name: '3/16" = 1\'-0"', ppf: 28.125 },
      { name: '3/32" = 1\'-0"', ppf: 14.0625 },
      { name: '1/16" = 1\'-0"', ppf: 9.375 },
    ];

    // Find closest match
    let closest = scales[0];
    let minDiff = Math.abs(pixelsPerFoot - scales[0].ppf);

    for (const scale of scales) {
      const diff = Math.abs(pixelsPerFoot - scale.ppf);
      if (diff < minDiff) {
        minDiff = diff;
        closest = scale;
      }
    }

    // If within 10% of a standard scale, show it
    if (minDiff / closest.ppf < 0.1) {
      return closest.name;
    }

    // Otherwise show pixels per foot
    return `${pixelsPerFoot.toFixed(1)} px/ft`;
  };

  if (!hasScale(documentId)) {
    return (
      <button
        onClick={onCalibrateClick}
        className="flex items-center gap-2 px-3 py-1.5 bg-yellow-100 text-yellow-800 rounded-lg hover:bg-yellow-200 text-sm font-medium"
      >
        <span className="text-yellow-600">⚠</span>
        No Scale - Click to Calibrate
      </button>
    );
  }

  return (
    <button
      onClick={onCalibrateClick}
      className="flex items-center gap-2 px-3 py-1.5 bg-green-100 text-green-800 rounded-lg hover:bg-green-200 text-sm"
      title="Click to recalibrate"
    >
      <span className="text-green-600">✓</span>
      <span className="font-medium">{getScaleString()}</span>
      {scaleData?.source === "manual" && (
        <span className="text-green-600 text-xs">(manual)</span>
      )}
    </button>
  );
}
```

**Step 3: Commit**

```bash
git add src/components/verification/scale-calibration-modal.tsx
git add src/components/verification/scale-indicator.tsx
git commit -m "feat(ui): add scale calibration modal and indicator

- ScaleCalibrationModal: step-by-step calibration flow
- ScaleIndicator: shows current scale, warns if not set
- Keyboard support (Esc to cancel)
- Feet-inches input with validation"
```

---

### Task 2.4: Integrate Scale into OpenLayers Viewer

**Files:**
- Modify: `src/components/verification/openlayers-tile-viewer.tsx`

**Step 1: Add calibration click handling**

Add to the OpenLayersTileViewer component:

```typescript
// Add to props interface:
  onCalibrationClick?: (point: { x: number; y: number }) => void;
  showCalibrationLine?: boolean;
  calibrationPoint1?: { x: number; y: number } | null;

// Add click handler in map initialization (after existing click handler):
    // Handle calibration clicks
    map.on("click", (e) => {
      if (onCalibrationClick) {
        const coordinate = e.coordinate;
        // Convert from map coordinates to PDF coordinates
        onCalibrationClick({ x: coordinate[0], y: -coordinate[1] });
      }
    });

// Add calibration line layer (after vector layer creation):
    // Calibration visualization layer
    const calibrationSource = new VectorSource();
    const calibrationLayer = new VectorLayer({
      source: calibrationSource,
      style: new Style({
        stroke: new Stroke({
          color: "#ff6b00",
          width: 3,
          lineDash: [10, 5],
        }),
        image: new CircleStyle({
          radius: 8,
          fill: new Fill({ color: "#ff6b00" }),
          stroke: new Stroke({ color: "#ffffff", width: 2 }),
        }),
      }),
      zIndex: 1000,
    });
    map.addLayer(calibrationLayer);

// Add effect to update calibration line:
  useEffect(() => {
    if (!calibrationLayerRef.current) return;
    const source = calibrationLayerRef.current.getSource();
    if (!source) return;

    source.clear();

    if (calibrationPoint1) {
      // Add point marker
      const point = new Feature({
        geometry: new Point([calibrationPoint1.x, -calibrationPoint1.y]),
      });
      source.addFeature(point);
    }
  }, [calibrationPoint1, showCalibrationLine]);
```

**Step 2: Commit**

```bash
git add src/components/verification/openlayers-tile-viewer.tsx
git commit -m "feat(viewer): add calibration click handling and visualization

- Accept onCalibrationClick prop for calibration mode
- Show calibration points and line during calibration
- Convert between map and PDF coordinates"
```

---

### Task 2.5: API for Scale Persistence

**Files:**
- Create: `src/app/api/documents/[documentId]/scale/route.ts`

**Step 1: Create scale API endpoint**

```typescript
// src/app/api/documents/[documentId]/scale/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

const ScaleUpdateSchema = z.object({
  pixelsPerFoot: z.number().positive(),
  source: z.enum(["manual", "auto_titleblock", "auto_scalebar", "auto_dimension"]),
  confidence: z.number().min(0).max(1).optional(),
  calibrationData: z.object({
    point1: z.tuple([z.number(), z.number()]),
    point2: z.tuple([z.number(), z.number()]),
    distanceFeet: z.number(),
    distanceInches: z.number(),
  }).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const { documentId } = await params;

  try {
    const result = await db
      .select({
        pixelsPerFoot: documents.scalePixelsPerFoot,
        source: documents.scaleSource,
        confidence: documents.scaleConfidence,
        calibrationData: documents.scaleCalibrationData,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (result.length === 0) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const doc = result[0];

    if (doc.pixelsPerFoot === null) {
      return NextResponse.json({ hasScale: false });
    }

    return NextResponse.json({
      hasScale: true,
      pixelsPerFoot: doc.pixelsPerFoot,
      source: doc.source,
      confidence: doc.confidence,
      calibrationData: doc.calibrationData,
    });
  } catch (error) {
    console.error("Error fetching scale:", error);
    return NextResponse.json({ error: "Failed to fetch scale" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const { documentId } = await params;

  try {
    const body = await request.json();
    const parsed = ScaleUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.format() },
        { status: 400 }
      );
    }

    const { pixelsPerFoot, source, confidence, calibrationData } = parsed.data;

    await db
      .update(documents)
      .set({
        scalePixelsPerFoot: pixelsPerFoot,
        scaleSource: source,
        scaleConfidence: confidence ?? null,
        scaleCalibrationData: calibrationData ?? null,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating scale:", error);
    return NextResponse.json({ error: "Failed to update scale" }, { status: 500 });
  }
}
```

**Step 2: Commit**

```bash
git add src/app/api/documents/[documentId]/scale/route.ts
git commit -m "feat(api): add scale persistence endpoint

- GET /api/documents/[documentId]/scale - fetch scale
- PUT /api/documents/[documentId]/scale - update scale
- Store calibration data for re-calibration"
```

---

This completes **Module 2: Scale System**.

**Checkpoint:** At this point you have:
- ✅ Database schema for scale storage
- ✅ Zustand store for scale state and conversions
- ✅ Scale calibration modal with step-by-step flow
- ✅ Scale indicator showing calibration status
- ✅ API endpoints for scale persistence
- ✅ Integration points in OpenLayers viewer

---

## Module 3: Drawing Tools

**Purpose:** Enable users to create measurements on the document - counts (points), linear measurements (lines), and area measurements (polygons). This is the core of the takeoff tool.

**Deliverables:**
- Tool store (Zustand) for active tool state
- OpenLayers Draw interactions for Point, LineString, Polygon
- Measurement store for persisting drawn features
- Real-time measurement display (length, area) during drawing
- Toolbar component for tool selection

### Task 3.1: Tool Store (Zustand)

**Files:**
- Create: `src/lib/stores/tool-store.ts`

**Step 1: Create the tool store**

```typescript
// src/lib/stores/tool-store.ts
import { create } from "zustand";

export type ToolType =
  | "select"      // V - Select/edit existing measurements
  | "count"       // C - Place count markers
  | "linear"      // L - Draw lines for length
  | "area"        // A - Draw polygons for area
  | "rectangle"   // R - Draw rectangles for area
  | "calibrate";  // S - Scale calibration mode

interface ToolState {
  // Active tool
  activeTool: ToolType;
  setActiveTool: (tool: ToolType) => void;

  // Drawing state
  isDrawing: boolean;
  setIsDrawing: (drawing: boolean) => void;

  // Pending measurement (during draw)
  pendingMeasurement: {
    type: ToolType;
    coordinates: [number, number][];
    pixelLength?: number;
    pixelArea?: number;
  } | null;
  setPendingMeasurement: (measurement: typeof ToolState.prototype.pendingMeasurement) => void;
  clearPendingMeasurement: () => void;

  // Modifiers
  constrainToAxis: boolean;  // SHIFT held
  setConstrainToAxis: (constrain: boolean) => void;
  snapEnabled: boolean;      // ALT toggles off
  setSnapEnabled: (enabled: boolean) => void;

  // Current category for new measurements
  activeCategory: string | null;
  setActiveCategory: (category: string | null) => void;

  // Convenience
  isDrawingTool: () => boolean;
}

export const useToolStore = create<ToolState>((set, get) => ({
  // Initial state
  activeTool: "select",
  isDrawing: false,
  pendingMeasurement: null,
  constrainToAxis: false,
  snapEnabled: true,
  activeCategory: null,

  // Set active tool
  setActiveTool: (tool) => {
    set({
      activeTool: tool,
      isDrawing: false,
      pendingMeasurement: null,
    });
  },

  // Set drawing state
  setIsDrawing: (drawing) => {
    set({ isDrawing: drawing });
  },

  // Set pending measurement
  setPendingMeasurement: (measurement) => {
    set({ pendingMeasurement: measurement });
  },

  // Clear pending measurement
  clearPendingMeasurement: () => {
    set({ pendingMeasurement: null, isDrawing: false });
  },

  // Set constrain modifier
  setConstrainToAxis: (constrain) => {
    set({ constrainToAxis: constrain });
  },

  // Set snap enabled
  setSnapEnabled: (enabled) => {
    set({ snapEnabled: enabled });
  },

  // Set active category
  setActiveCategory: (category) => {
    set({ activeCategory: category });
  },

  // Check if current tool is a drawing tool
  isDrawingTool: () => {
    const tool = get().activeTool;
    return ["count", "linear", "area", "rectangle"].includes(tool);
  },
}));

// Keyboard shortcut mapping
export const TOOL_SHORTCUTS: Record<string, ToolType> = {
  v: "select",
  c: "count",
  l: "linear",
  a: "area",
  r: "rectangle",
  s: "calibrate",
};
```

**Step 2: Commit**

```bash
git add src/lib/stores/tool-store.ts
git commit -m "feat(store): add tool state Zustand store

- Track active tool (select, count, linear, area, rectangle, calibrate)
- Track drawing state and pending measurements
- Track modifiers (constrainToAxis, snapEnabled)
- Track active category for new measurements
- Define keyboard shortcut mapping"
```

---

### Task 3.2: Measurement Store (Zustand)

**Files:**
- Create: `src/lib/stores/measurement-store.ts`

**Step 1: Create the measurement store**

```typescript
// src/lib/stores/measurement-store.ts
import { create } from "zustand";

export interface Measurement {
  id: string;
  documentId: string;
  pageNumber: number;

  // Type
  type: "count" | "linear" | "area";

  // Geometry (in PDF pixel coordinates)
  geometry: {
    type: "Point" | "LineString" | "Polygon";
    coordinates: number[] | number[][] | number[][][];
  };

  // Calculated values (in pixels, converted to real units via scale)
  pixelLength?: number;   // For linear
  pixelArea?: number;     // For area

  // Category/classification
  categoryId: string | null;
  itemTypeId: string | null;
  label?: string;

  // Visual
  color: string;

  // Metadata
  createdAt: Date;
  source: "manual" | "find_similar" | "ai_detected";
}

interface MeasurementState {
  // All measurements for current document
  measurements: Measurement[];
  setMeasurements: (measurements: Measurement[]) => void;

  // Add measurement
  addMeasurement: (measurement: Omit<Measurement, "id" | "createdAt">) => Measurement;

  // Update measurement
  updateMeasurement: (id: string, updates: Partial<Measurement>) => void;

  // Delete measurement
  deleteMeasurement: (id: string) => void;
  deleteMeasurements: (ids: string[]) => void;

  // Selection
  selectedMeasurementIds: Set<string>;
  selectMeasurement: (id: string, addToSelection?: boolean) => void;
  deselectMeasurement: (id: string) => void;
  clearSelection: () => void;
  selectAll: () => void;

  // Filtering
  getMeasurementsForPage: (documentId: string, pageNumber: number) => Measurement[];
  getMeasurementsByCategory: (categoryId: string) => Measurement[];

  // Totals
  getTotalCount: (categoryId?: string) => number;
  getTotalLinearPixels: (categoryId?: string) => number;
  getTotalAreaPixels: (categoryId?: string) => number;
}

export const useMeasurementStore = create<MeasurementState>((set, get) => ({
  measurements: [],
  selectedMeasurementIds: new Set(),

  setMeasurements: (measurements) => {
    set({ measurements });
  },

  addMeasurement: (measurementData) => {
    const measurement: Measurement = {
      ...measurementData,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };

    set((state) => ({
      measurements: [...state.measurements, measurement],
    }));

    return measurement;
  },

  updateMeasurement: (id, updates) => {
    set((state) => ({
      measurements: state.measurements.map((m) =>
        m.id === id ? { ...m, ...updates } : m
      ),
    }));
  },

  deleteMeasurement: (id) => {
    set((state) => ({
      measurements: state.measurements.filter((m) => m.id !== id),
      selectedMeasurementIds: new Set(
        [...state.selectedMeasurementIds].filter((sid) => sid !== id)
      ),
    }));
  },

  deleteMeasurements: (ids) => {
    const idSet = new Set(ids);
    set((state) => ({
      measurements: state.measurements.filter((m) => !idSet.has(m.id)),
      selectedMeasurementIds: new Set(
        [...state.selectedMeasurementIds].filter((sid) => !idSet.has(sid))
      ),
    }));
  },

  selectMeasurement: (id, addToSelection = false) => {
    set((state) => {
      if (addToSelection) {
        const newSet = new Set(state.selectedMeasurementIds);
        newSet.add(id);
        return { selectedMeasurementIds: newSet };
      }
      return { selectedMeasurementIds: new Set([id]) };
    });
  },

  deselectMeasurement: (id) => {
    set((state) => {
      const newSet = new Set(state.selectedMeasurementIds);
      newSet.delete(id);
      return { selectedMeasurementIds: newSet };
    });
  },

  clearSelection: () => {
    set({ selectedMeasurementIds: new Set() });
  },

  selectAll: () => {
    set((state) => ({
      selectedMeasurementIds: new Set(state.measurements.map((m) => m.id)),
    }));
  },

  getMeasurementsForPage: (documentId, pageNumber) => {
    return get().measurements.filter(
      (m) => m.documentId === documentId && m.pageNumber === pageNumber
    );
  },

  getMeasurementsByCategory: (categoryId) => {
    return get().measurements.filter((m) => m.categoryId === categoryId);
  },

  getTotalCount: (categoryId) => {
    const measurements = categoryId
      ? get().getMeasurementsByCategory(categoryId)
      : get().measurements;
    return measurements.filter((m) => m.type === "count").length;
  },

  getTotalLinearPixels: (categoryId) => {
    const measurements = categoryId
      ? get().getMeasurementsByCategory(categoryId)
      : get().measurements;
    return measurements
      .filter((m) => m.type === "linear")
      .reduce((sum, m) => sum + (m.pixelLength ?? 0), 0);
  },

  getTotalAreaPixels: (categoryId) => {
    const measurements = categoryId
      ? get().getMeasurementsByCategory(categoryId)
      : get().measurements;
    return measurements
      .filter((m) => m.type === "area")
      .reduce((sum, m) => sum + (m.pixelArea ?? 0), 0);
  },
}));
```

**Step 2: Commit**

```bash
git add src/lib/stores/measurement-store.ts
git commit -m "feat(store): add measurement Zustand store

- CRUD operations for measurements
- Selection management (single, multi, all)
- Filtering by page, category
- Aggregations: totalCount, totalLinear, totalArea
- Geometry storage in GeoJSON format"
```

---

### Task 3.3: Toolbar Component

**Files:**
- Create: `src/components/verification/measurement-toolbar.tsx`

**Step 1: Create the toolbar component**

```typescript
// src/components/verification/measurement-toolbar.tsx
"use client";

import { useToolStore, ToolType, TOOL_SHORTCUTS } from "@/lib/stores/tool-store";
import { useScaleStore } from "@/lib/stores/scale-store";
import { useMeasurementStore } from "@/lib/stores/measurement-store";

interface ToolButtonProps {
  tool: ToolType;
  icon: string;
  label: string;
  shortcut: string;
  disabled?: boolean;
}

function ToolButton({ tool, icon, label, shortcut, disabled }: ToolButtonProps) {
  const { activeTool, setActiveTool } = useToolStore();
  const isActive = activeTool === tool;

  return (
    <button
      onClick={() => setActiveTool(tool)}
      disabled={disabled}
      className={`
        flex flex-col items-center justify-center w-12 h-12 rounded-lg
        transition-colors relative group
        ${isActive
          ? "bg-blue-600 text-white"
          : "bg-gray-100 text-gray-700 hover:bg-gray-200"
        }
        ${disabled ? "opacity-50 cursor-not-allowed" : ""}
      `}
      title={`${label} (${shortcut.toUpperCase()})`}
    >
      <span className="text-lg">{icon}</span>
      <span className="text-[10px] mt-0.5">{label}</span>

      {/* Keyboard shortcut badge */}
      <span className={`
        absolute -top-1 -right-1 w-4 h-4 rounded text-[10px] font-bold
        flex items-center justify-center
        ${isActive ? "bg-blue-800 text-white" : "bg-gray-300 text-gray-600"}
      `}>
        {shortcut.toUpperCase()}
      </span>
    </button>
  );
}

interface MeasurementToolbarProps {
  documentId: string;
  onCalibrateClick: () => void;
}

export function MeasurementToolbar({ documentId, onCalibrateClick }: MeasurementToolbarProps) {
  const { activeTool, setActiveTool, snapEnabled, setSnapEnabled } = useToolStore();
  const { hasScale } = useScaleStore();
  const { selectedMeasurementIds, deleteMeasurements, clearSelection } = useMeasurementStore();

  const scaleSet = hasScale(documentId);
  const hasSelection = selectedMeasurementIds.size > 0;

  const handleDelete = () => {
    if (hasSelection) {
      deleteMeasurements([...selectedMeasurementIds]);
    }
  };

  const handleCalibrate = () => {
    setActiveTool("calibrate");
    onCalibrateClick();
  };

  return (
    <div className="flex flex-col gap-2 p-2 bg-white rounded-lg shadow-lg border">
      {/* Main tools */}
      <div className="flex flex-col gap-1">
        <ToolButton tool="select" icon="➤" label="Select" shortcut="v" />
        <div className="h-px bg-gray-200 my-1" />
        <ToolButton tool="count" icon="●" label="Count" shortcut="c" />
        <ToolButton
          tool="linear"
          icon="/"
          label="Linear"
          shortcut="l"
          disabled={!scaleSet}
        />
        <ToolButton
          tool="area"
          icon="▭"
          label="Area"
          shortcut="a"
          disabled={!scaleSet}
        />
        <ToolButton
          tool="rectangle"
          icon="□"
          label="Rect"
          shortcut="r"
          disabled={!scaleSet}
        />
      </div>

      <div className="h-px bg-gray-200" />

      {/* Scale calibration */}
      <button
        onClick={handleCalibrate}
        className={`
          flex flex-col items-center justify-center w-12 h-12 rounded-lg
          transition-colors
          ${!scaleSet
            ? "bg-yellow-100 text-yellow-700 hover:bg-yellow-200"
            : "bg-gray-100 text-gray-700 hover:bg-gray-200"
          }
          ${activeTool === "calibrate" ? "ring-2 ring-blue-500" : ""}
        `}
        title="Calibrate Scale (S)"
      >
        <span className="text-lg">📏</span>
        <span className="text-[10px] mt-0.5">Scale</span>
      </button>

      <div className="h-px bg-gray-200" />

      {/* Modifiers */}
      <button
        onClick={() => setSnapEnabled(!snapEnabled)}
        className={`
          flex flex-col items-center justify-center w-12 h-12 rounded-lg
          transition-colors
          ${snapEnabled
            ? "bg-green-100 text-green-700"
            : "bg-gray-100 text-gray-400"
          }
        `}
        title={`Snap ${snapEnabled ? "On" : "Off"} (hold ALT to toggle)`}
      >
        <span className="text-lg">🧲</span>
        <span className="text-[10px] mt-0.5">Snap</span>
      </button>

      {/* Delete selection */}
      {hasSelection && (
        <>
          <div className="h-px bg-gray-200" />
          <button
            onClick={handleDelete}
            className="flex flex-col items-center justify-center w-12 h-12 rounded-lg
              bg-red-100 text-red-700 hover:bg-red-200 transition-colors"
            title="Delete Selected (Del)"
          >
            <span className="text-lg">🗑</span>
            <span className="text-[10px] mt-0.5">{selectedMeasurementIds.size}</span>
          </button>
        </>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/verification/measurement-toolbar.tsx
git commit -m "feat(ui): add measurement toolbar component

- Tool buttons with keyboard shortcut badges
- Disable linear/area tools when no scale set
- Scale calibration button with warning state
- Snap toggle
- Delete selection button
- Visual feedback for active tool"
```

---

### Task 3.4: Drawing Interactions Component

**Files:**
- Create: `src/components/verification/drawing-layer.tsx`

**Step 1: Create the drawing layer component**

```typescript
// src/components/verification/drawing-layer.tsx
"use client";

import { useEffect, useRef, useCallback } from "react";
import type OLMap from "ol/Map";
import Draw from "ol/interaction/Draw";
import Modify from "ol/interaction/Modify";
import Select from "ol/interaction/Select";
import VectorSource from "ol/source/Vector";
import VectorLayer from "ol/layer/Vector";
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style";
import { click } from "ol/events/condition";
import type { Feature } from "ol";
import type { Geometry, Point, LineString, Polygon } from "ol/geom";

import { useToolStore, ToolType } from "@/lib/stores/tool-store";
import { useMeasurementStore, Measurement } from "@/lib/stores/measurement-store";
import { useScaleStore } from "@/lib/stores/scale-store";

interface DrawingLayerProps {
  map: OLMap | null;
  documentId: string;
  pageNumber: number;
}

// Map tool type to OL geometry type
const TOOL_TO_GEOMETRY: Record<string, "Point" | "LineString" | "Polygon" | "Circle"> = {
  count: "Point",
  linear: "LineString",
  area: "Polygon",
  rectangle: "Circle", // Use Circle with geometryFunction for box
};

// Calculate line length in pixels
function calculateLineLength(coords: number[][]): number {
  let length = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length;
}

// Calculate polygon area in square pixels (shoelace formula)
function calculatePolygonArea(coords: number[][]): number {
  let area = 0;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += coords[i][0] * coords[j][1];
    area -= coords[j][0] * coords[i][1];
  }
  return Math.abs(area / 2);
}

export function DrawingLayer({ map, documentId, pageNumber }: DrawingLayerProps) {
  const { activeTool, isDrawingTool, setIsDrawing, setPendingMeasurement, clearPendingMeasurement, constrainToAxis } = useToolStore();
  const { addMeasurement, measurements, selectedMeasurementIds, selectMeasurement, clearSelection } = useMeasurementStore();
  const { formatDistance, formatArea, hasScale } = useScaleStore();

  const drawInteractionRef = useRef<Draw | null>(null);
  const selectInteractionRef = useRef<Select | null>(null);
  const modifyInteractionRef = useRef<Modify | null>(null);
  const drawSourceRef = useRef<VectorSource | null>(null);
  const measurementLayerRef = useRef<VectorLayer | null>(null);

  // Style for measurements
  const createMeasurementStyle = useCallback((feature: Feature<Geometry>, isSelected: boolean) => {
    const props = feature.getProperties();
    const measurementType = props.measurementType as string;
    const color = props.color || "#3b82f6";

    const baseStyles: Style[] = [];

    if (measurementType === "count") {
      baseStyles.push(new Style({
        image: new CircleStyle({
          radius: isSelected ? 12 : 10,
          fill: new Fill({ color: isSelected ? "#2563eb" : color }),
          stroke: new Stroke({ color: "#ffffff", width: 2 }),
        }),
      }));
    } else if (measurementType === "linear") {
      baseStyles.push(new Style({
        stroke: new Stroke({
          color: isSelected ? "#2563eb" : color,
          width: isSelected ? 4 : 3,
        }),
      }));

      // Add endpoint markers
      const geom = feature.getGeometry();
      if (geom && geom.getType() === "LineString") {
        const coords = (geom as LineString).getCoordinates();
        if (coords.length >= 2) {
          // Start point
          baseStyles.push(new Style({
            geometry: new (await import("ol/geom")).Point(coords[0]),
            image: new CircleStyle({
              radius: 6,
              fill: new Fill({ color }),
              stroke: new Stroke({ color: "#ffffff", width: 2 }),
            }),
          }));
          // End point
          baseStyles.push(new Style({
            geometry: new (await import("ol/geom")).Point(coords[coords.length - 1]),
            image: new CircleStyle({
              radius: 6,
              fill: new Fill({ color }),
              stroke: new Stroke({ color: "#ffffff", width: 2 }),
            }),
          }));
        }
      }

      // Add length label
      if (props.label) {
        baseStyles.push(new Style({
          text: new Text({
            text: props.label,
            font: "bold 12px sans-serif",
            fill: new Fill({ color: "#1f2937" }),
            stroke: new Stroke({ color: "#ffffff", width: 3 }),
            offsetY: -15,
          }),
        }));
      }
    } else if (measurementType === "area") {
      baseStyles.push(new Style({
        fill: new Fill({ color: `${color}33` }),
        stroke: new Stroke({
          color: isSelected ? "#2563eb" : color,
          width: isSelected ? 3 : 2,
        }),
      }));

      // Add area label
      if (props.label) {
        baseStyles.push(new Style({
          text: new Text({
            text: props.label,
            font: "bold 12px sans-serif",
            fill: new Fill({ color: "#1f2937" }),
            stroke: new Stroke({ color: "#ffffff", width: 3 }),
          }),
        }));
      }
    }

    return baseStyles;
  }, []);

  // Initialize layers
  useEffect(() => {
    if (!map) return;

    // Create source for drawn features
    const drawSource = new VectorSource();
    drawSourceRef.current = drawSource;

    // Create measurement display layer
    const measurementLayer = new VectorLayer({
      source: drawSource,
      style: (feature) => {
        const isSelected = selectedMeasurementIds.has(feature.get("measurementId"));
        return createMeasurementStyle(feature as Feature<Geometry>, isSelected);
      },
      zIndex: 100,
    });
    measurementLayerRef.current = measurementLayer;
    map.addLayer(measurementLayer);

    // Create select interaction
    const select = new Select({
      condition: click,
      layers: [measurementLayer],
      style: (feature) => createMeasurementStyle(feature as Feature<Geometry>, true),
    });
    selectInteractionRef.current = select;

    select.on("select", (e) => {
      if (e.selected.length > 0) {
        const measurementId = e.selected[0].get("measurementId");
        if (measurementId) {
          selectMeasurement(measurementId, e.mapBrowserEvent.originalEvent.shiftKey);
        }
      } else {
        clearSelection();
      }
    });

    // Create modify interaction
    const modify = new Modify({
      source: drawSource,
    });
    modifyInteractionRef.current = modify;

    return () => {
      map.removeLayer(measurementLayer);
      if (drawInteractionRef.current) {
        map.removeInteraction(drawInteractionRef.current);
      }
      map.removeInteraction(select);
      map.removeInteraction(modify);
    };
  }, [map]);

  // Update drawing interaction when tool changes
  useEffect(() => {
    if (!map || !drawSourceRef.current) return;

    // Remove existing draw interaction
    if (drawInteractionRef.current) {
      map.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }

    // Remove other interactions based on mode
    if (selectInteractionRef.current) {
      if (activeTool === "select") {
        map.addInteraction(selectInteractionRef.current);
        if (modifyInteractionRef.current) {
          map.addInteraction(modifyInteractionRef.current);
        }
      } else {
        map.removeInteraction(selectInteractionRef.current);
        if (modifyInteractionRef.current) {
          map.removeInteraction(modifyInteractionRef.current);
        }
      }
    }

    // Add draw interaction for drawing tools
    if (isDrawingTool() && activeTool !== "select") {
      const geometryType = TOOL_TO_GEOMETRY[activeTool];
      if (!geometryType) return;

      const drawOptions: any = {
        source: drawSourceRef.current,
        type: geometryType,
      };

      // Rectangle tool uses createBox
      if (activeTool === "rectangle") {
        const { createBox } = require("ol/interaction/Draw");
        drawOptions.type = "Circle";
        drawOptions.geometryFunction = createBox();
      }

      const draw = new Draw(drawOptions);
      drawInteractionRef.current = draw;

      draw.on("drawstart", (e) => {
        setIsDrawing(true);
      });

      draw.on("drawend", (e) => {
        const feature = e.feature;
        const geometry = feature.getGeometry();
        if (!geometry) return;

        let measurementType: "count" | "linear" | "area" = "count";
        let pixelLength: number | undefined;
        let pixelArea: number | undefined;
        let geometryData: Measurement["geometry"];
        let label: string | undefined;

        const geomType = geometry.getType();

        if (geomType === "Point") {
          measurementType = "count";
          const coords = (geometry as Point).getCoordinates();
          geometryData = {
            type: "Point",
            coordinates: [coords[0], -coords[1]], // Convert back to PDF coords
          };
        } else if (geomType === "LineString") {
          measurementType = "linear";
          const coords = (geometry as LineString).getCoordinates();
          pixelLength = calculateLineLength(coords);
          geometryData = {
            type: "LineString",
            coordinates: coords.map(([x, y]) => [x, -y]),
          };
          label = formatDistance(documentId, pixelLength);
        } else if (geomType === "Polygon") {
          measurementType = "area";
          const coords = (geometry as Polygon).getCoordinates()[0];
          pixelArea = calculatePolygonArea(coords);
          geometryData = {
            type: "Polygon",
            coordinates: [coords.map(([x, y]) => [x, -y])],
          };
          label = formatArea(documentId, pixelArea);
        } else {
          // Remove the feature if unknown type
          drawSourceRef.current?.removeFeature(feature);
          return;
        }

        // Create measurement in store
        const measurement = addMeasurement({
          documentId,
          pageNumber,
          type: measurementType,
          geometry: geometryData,
          pixelLength,
          pixelArea,
          categoryId: null,
          itemTypeId: null,
          label,
          color: "#3b82f6",
          source: "manual",
        });

        // Store measurement ID on feature for selection
        feature.set("measurementId", measurement.id);
        feature.set("measurementType", measurementType);
        feature.set("label", label);
        feature.set("color", "#3b82f6");

        setIsDrawing(false);
        clearPendingMeasurement();
      });

      map.addInteraction(draw);
    }
  }, [map, activeTool, documentId, pageNumber, isDrawingTool, addMeasurement, formatDistance, formatArea, setIsDrawing, clearPendingMeasurement]);

  // Load existing measurements onto map
  useEffect(() => {
    if (!drawSourceRef.current) return;

    // Clear existing features
    drawSourceRef.current.clear();

    // Add features for current page's measurements
    const pageMeasurements = measurements.filter(
      (m) => m.documentId === documentId && m.pageNumber === pageNumber
    );

    for (const measurement of pageMeasurements) {
      let geometry: Geometry | null = null;

      if (measurement.geometry.type === "Point") {
        const coords = measurement.geometry.coordinates as number[];
        const { Point } = require("ol/geom");
        geometry = new Point([coords[0], -coords[1]]);
      } else if (measurement.geometry.type === "LineString") {
        const coords = measurement.geometry.coordinates as number[][];
        const { LineString } = require("ol/geom");
        geometry = new LineString(coords.map(([x, y]) => [x, -y]));
      } else if (measurement.geometry.type === "Polygon") {
        const coords = measurement.geometry.coordinates as number[][][];
        const { Polygon } = require("ol/geom");
        geometry = new Polygon([coords[0].map(([x, y]) => [x, -y])]);
      }

      if (geometry) {
        const { Feature } = require("ol");
        const feature = new Feature({ geometry });
        feature.set("measurementId", measurement.id);
        feature.set("measurementType", measurement.type);
        feature.set("label", measurement.label);
        feature.set("color", measurement.color);
        drawSourceRef.current?.addFeature(feature);
      }
    }
  }, [measurements, documentId, pageNumber]);

  // Re-render when selection changes
  useEffect(() => {
    measurementLayerRef.current?.changed();
  }, [selectedMeasurementIds]);

  return null; // This component just manages OL interactions
}
```

**Step 2: Commit**

```bash
git add src/components/verification/drawing-layer.tsx
git commit -m "feat(ui): add OpenLayers drawing interaction layer

- Draw interactions for count (Point), linear (LineString), area (Polygon), rectangle
- Select interaction for clicking on measurements
- Modify interaction for editing measurements
- Automatic calculation of length and area
- Label display with formatted measurements
- Sync with measurement store"
```

---

### Task 3.5: Database Schema for Measurements

**Files:**
- Modify: `src/db/schema.ts` (add measurements table)

**Step 1: Add measurements table to schema**

```typescript
// Add to src/db/schema.ts

export const measurements = pgTable("measurements", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  bidId: uuid("bid_id")
    .references(() => bids.id, { onDelete: "cascade" }),

  // Type
  type: text("type").$type<"count" | "linear" | "area">().notNull(),

  // Geometry (GeoJSON)
  geometry: jsonb("geometry").$type<{
    type: "Point" | "LineString" | "Polygon";
    coordinates: number[] | number[][] | number[][][];
  }>().notNull(),

  // Calculated values (pixels)
  pixelLength: real("pixel_length"),
  pixelArea: real("pixel_area"),

  // Category/classification
  categoryId: uuid("category_id"),
  itemTypeId: uuid("item_type_id"),
  label: text("label"),

  // Visual
  color: text("color").default("#3b82f6"),

  // Metadata
  source: text("source").$type<"manual" | "find_similar" | "ai_detected">().default("manual"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  docPageIdx: index("measurements_doc_page_idx").on(table.documentId, table.pageNumber),
  bidIdx: index("measurements_bid_idx").on(table.bidId),
  categoryIdx: index("measurements_category_idx").on(table.categoryId),
}));
```

**Step 2: Generate and run migration**

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

**Step 3: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): add measurements table

- Store measurement geometry as GeoJSON
- Track pixel length/area for conversions
- Category and item type references
- Indexes for efficient queries by page, bid, category"
```

---

### Task 3.6: API for Measurements

**Files:**
- Create: `src/app/api/measurements/route.ts`
- Create: `src/app/api/measurements/[measurementId]/route.ts`

**Step 1: Create measurements API**

```typescript
// src/app/api/measurements/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { measurements } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

const CreateMeasurementSchema = z.object({
  documentId: z.string().uuid(),
  pageNumber: z.number().int().min(0),
  bidId: z.string().uuid().optional(),
  type: z.enum(["count", "linear", "area"]),
  geometry: z.object({
    type: z.enum(["Point", "LineString", "Polygon"]),
    coordinates: z.any(),
  }),
  pixelLength: z.number().optional(),
  pixelArea: z.number().optional(),
  categoryId: z.string().uuid().optional(),
  itemTypeId: z.string().uuid().optional(),
  label: z.string().optional(),
  color: z.string().optional(),
  source: z.enum(["manual", "find_similar", "ai_detected"]).optional(),
});

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const documentId = searchParams.get("documentId");
  const pageNumber = searchParams.get("pageNumber");
  const bidId = searchParams.get("bidId");

  try {
    let query = db.select().from(measurements);

    if (documentId && pageNumber) {
      query = query.where(
        and(
          eq(measurements.documentId, documentId),
          eq(measurements.pageNumber, parseInt(pageNumber))
        )
      );
    } else if (bidId) {
      query = query.where(eq(measurements.bidId, bidId));
    }

    const result = await query;
    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching measurements:", error);
    return NextResponse.json({ error: "Failed to fetch measurements" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = CreateMeasurementSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.format() },
        { status: 400 }
      );
    }

    const data = parsed.data;

    const result = await db
      .insert(measurements)
      .values({
        documentId: data.documentId,
        pageNumber: data.pageNumber,
        bidId: data.bidId,
        type: data.type,
        geometry: data.geometry,
        pixelLength: data.pixelLength,
        pixelArea: data.pixelArea,
        categoryId: data.categoryId,
        itemTypeId: data.itemTypeId,
        label: data.label,
        color: data.color || "#3b82f6",
        source: data.source || "manual",
      })
      .returning();

    return NextResponse.json(result[0], { status: 201 });
  } catch (error) {
    console.error("Error creating measurement:", error);
    return NextResponse.json({ error: "Failed to create measurement" }, { status: 500 });
  }
}
```

**Step 2: Create single measurement API**

```typescript
// src/app/api/measurements/[measurementId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { measurements } from "@/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

const UpdateMeasurementSchema = z.object({
  categoryId: z.string().uuid().nullable().optional(),
  itemTypeId: z.string().uuid().nullable().optional(),
  label: z.string().optional(),
  color: z.string().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ measurementId: string }> }
) {
  const { measurementId } = await params;

  try {
    const result = await db
      .select()
      .from(measurements)
      .where(eq(measurements.id, measurementId))
      .limit(1);

    if (result.length === 0) {
      return NextResponse.json({ error: "Measurement not found" }, { status: 404 });
    }

    return NextResponse.json(result[0]);
  } catch (error) {
    console.error("Error fetching measurement:", error);
    return NextResponse.json({ error: "Failed to fetch measurement" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ measurementId: string }> }
) {
  const { measurementId } = await params;

  try {
    const body = await request.json();
    const parsed = UpdateMeasurementSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.format() },
        { status: 400 }
      );
    }

    const updates: any = { updatedAt: new Date() };
    if (parsed.data.categoryId !== undefined) updates.categoryId = parsed.data.categoryId;
    if (parsed.data.itemTypeId !== undefined) updates.itemTypeId = parsed.data.itemTypeId;
    if (parsed.data.label !== undefined) updates.label = parsed.data.label;
    if (parsed.data.color !== undefined) updates.color = parsed.data.color;

    const result = await db
      .update(measurements)
      .set(updates)
      .where(eq(measurements.id, measurementId))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: "Measurement not found" }, { status: 404 });
    }

    return NextResponse.json(result[0]);
  } catch (error) {
    console.error("Error updating measurement:", error);
    return NextResponse.json({ error: "Failed to update measurement" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ measurementId: string }> }
) {
  const { measurementId } = await params;

  try {
    const result = await db
      .delete(measurements)
      .where(eq(measurements.id, measurementId))
      .returning();

    if (result.length === 0) {
      return NextResponse.json({ error: "Measurement not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting measurement:", error);
    return NextResponse.json({ error: "Failed to delete measurement" }, { status: 500 });
  }
}
```

**Step 3: Commit**

```bash
git add src/app/api/measurements/
git commit -m "feat(api): add measurements CRUD endpoints

- GET /api/measurements?documentId=&pageNumber= - list by page
- GET /api/measurements?bidId= - list by bid
- POST /api/measurements - create measurement
- GET /api/measurements/[id] - get single
- PATCH /api/measurements/[id] - update category, label, color
- DELETE /api/measurements/[id] - delete"
```

---

This completes **Module 3: Drawing Tools**.

**Checkpoint:** At this point you have:
- ✅ Tool store for managing active tool state
- ✅ Measurement store for tracking drawn measurements
- ✅ Toolbar component with tool buttons and shortcuts
- ✅ Drawing layer with OpenLayers Draw/Select/Modify interactions
- ✅ Database schema for persisting measurements
- ✅ API endpoints for measurement CRUD

---

## Module 4: Snap System

**Purpose:** Enable precision clicking by snapping the cursor to nearby geometric features - PDF vectors (endpoints, midpoints, intersections), existing measurements, and optionally a grid. This is what makes takeoffs fast and accurate.

**Deliverables:**
- Snap store for managing snap state and nearest snap point
- Snap layer to visualize available snap points
- Snap indicator component showing current snap type
- Integration with Draw interactions for snapped drawing
- Visual feedback (cursor change, highlight source geometry)

### Task 4.1: Snap Store (Zustand)

**Files:**
- Create: `src/lib/stores/snap-store.ts`

**Step 1: Create the snap store**

```typescript
// src/lib/stores/snap-store.ts
import { create } from "zustand";

export type SnapType =
  | "endpoint"      // ● Corners, line ends
  | "midpoint"      // ◆ Center of line
  | "intersection"  // ╳ Where lines cross
  | "perpendicular" // ┴ 90° from reference
  | "on-line"       // ○ Any point on line
  | "center"        // ◎ Center of shape
  | "measurement"   // Existing measurement points
  | "grid";         // Grid intersection

export interface SnapPoint {
  type: SnapType;
  coords: [number, number];  // PDF coordinates
  sourceId?: string;         // ID of source geometry (for highlighting)
  distance: number;          // Distance from cursor in pixels
}

interface SnapState {
  // Snap sources enabled
  snapToVectors: boolean;
  snapToMeasurements: boolean;
  snapToGrid: boolean;
  setSnapToVectors: (enabled: boolean) => void;
  setSnapToMeasurements: (enabled: boolean) => void;
  setSnapToGrid: (enabled: boolean) => void;

  // Grid settings
  gridSpacing: number;  // Pixels
  setGridSpacing: (spacing: number) => void;

  // Snap tolerance (how close cursor must be to snap)
  snapTolerance: number;  // Pixels
  setSnapTolerance: (tolerance: number) => void;

  // Current snap state
  isSnapped: boolean;
  currentSnapPoint: SnapPoint | null;
  nearbySnapPoints: SnapPoint[];  // For TAB cycling

  // Actions
  setCurrentSnapPoint: (point: SnapPoint | null) => void;
  setNearbySnapPoints: (points: SnapPoint[]) => void;
  cycleSnapPoint: () => void;  // TAB to cycle through nearby points
  clearSnap: () => void;

  // Loaded snap geometry (from vector extraction)
  vectorSnapPoints: SnapPoint[];
  vectorLines: Array<{ start: [number, number]; end: [number, number] }>;
  setVectorGeometry: (
    snapPoints: SnapPoint[],
    lines: Array<{ start: [number, number]; end: [number, number] }>
  ) => void;
  clearVectorGeometry: () => void;
}

export const useSnapStore = create<SnapState>((set, get) => ({
  // Default settings
  snapToVectors: true,
  snapToMeasurements: true,
  snapToGrid: false,
  gridSpacing: 50,
  snapTolerance: 15,

  // Current state
  isSnapped: false,
  currentSnapPoint: null,
  nearbySnapPoints: [],

  // Vector geometry
  vectorSnapPoints: [],
  vectorLines: [],

  // Setters
  setSnapToVectors: (enabled) => set({ snapToVectors: enabled }),
  setSnapToMeasurements: (enabled) => set({ snapToMeasurements: enabled }),
  setSnapToGrid: (enabled) => set({ snapToGrid: enabled }),
  setGridSpacing: (spacing) => set({ gridSpacing: spacing }),
  setSnapTolerance: (tolerance) => set({ snapTolerance: tolerance }),

  setCurrentSnapPoint: (point) => set({
    currentSnapPoint: point,
    isSnapped: point !== null,
  }),

  setNearbySnapPoints: (points) => set({ nearbySnapPoints: points }),

  cycleSnapPoint: () => {
    const { nearbySnapPoints, currentSnapPoint } = get();
    if (nearbySnapPoints.length <= 1) return;

    const currentIndex = currentSnapPoint
      ? nearbySnapPoints.findIndex(
          (p) => p.coords[0] === currentSnapPoint.coords[0] &&
                 p.coords[1] === currentSnapPoint.coords[1]
        )
      : -1;

    const nextIndex = (currentIndex + 1) % nearbySnapPoints.length;
    set({
      currentSnapPoint: nearbySnapPoints[nextIndex],
      isSnapped: true,
    });
  },

  clearSnap: () => set({
    isSnapped: false,
    currentSnapPoint: null,
    nearbySnapPoints: [],
  }),

  setVectorGeometry: (snapPoints, lines) => set({
    vectorSnapPoints: snapPoints,
    vectorLines: lines,
  }),

  clearVectorGeometry: () => set({
    vectorSnapPoints: [],
    vectorLines: [],
  }),
}));

// Snap type icons for UI
export const SNAP_TYPE_ICONS: Record<SnapType, string> = {
  endpoint: "●",
  midpoint: "◆",
  intersection: "╳",
  perpendicular: "┴",
  "on-line": "○",
  center: "◎",
  measurement: "▣",
  grid: "┼",
};

// Snap type labels
export const SNAP_TYPE_LABELS: Record<SnapType, string> = {
  endpoint: "Endpoint",
  midpoint: "Midpoint",
  intersection: "Intersection",
  perpendicular: "Perpendicular",
  "on-line": "On Line",
  center: "Center",
  measurement: "Measurement",
  grid: "Grid",
};
```

**Step 2: Commit**

```bash
git add src/lib/stores/snap-store.ts
git commit -m "feat(store): add snap state Zustand store

- Track snap sources (vectors, measurements, grid)
- Track current snap point and nearby alternatives
- TAB cycling through nearby snap points
- Store loaded vector geometry for snapping
- Configurable snap tolerance and grid spacing"
```

---

### Task 4.2: Snap Calculation Utilities

**Files:**
- Create: `src/lib/snap-utils.ts`

**Step 1: Create snap calculation utilities**

```typescript
// src/lib/snap-utils.ts
import { SnapPoint, SnapType } from "@/lib/stores/snap-store";
import { Measurement } from "@/lib/stores/measurement-store";

interface Point {
  x: number;
  y: number;
}

interface Line {
  start: Point;
  end: Point;
}

/**
 * Calculate distance between two points
 */
export function distance(p1: Point, p2: Point): number {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

/**
 * Find the closest point on a line segment to a given point
 */
export function closestPointOnLine(point: Point, line: Line): Point {
  const { start, end } = line;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return start; // Line is a point
  }

  // Calculate projection parameter
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t)); // Clamp to segment

  return {
    x: start.x + t * dx,
    y: start.y + t * dy,
  };
}

/**
 * Find all snap points near a cursor position
 */
export function findNearbySnapPoints(
  cursorPos: Point,
  vectorSnapPoints: SnapPoint[],
  vectorLines: Line[],
  measurements: Measurement[],
  options: {
    snapToVectors: boolean;
    snapToMeasurements: boolean;
    snapToGrid: boolean;
    gridSpacing: number;
    snapTolerance: number;
  }
): SnapPoint[] {
  const results: SnapPoint[] = [];

  // 1. Check vector snap points (endpoints, midpoints, intersections)
  if (options.snapToVectors) {
    for (const sp of vectorSnapPoints) {
      const dist = distance(cursorPos, { x: sp.coords[0], y: sp.coords[1] });
      if (dist <= options.snapTolerance) {
        results.push({ ...sp, distance: dist });
      }
    }

    // Also check for "on-line" snapping
    for (let i = 0; i < vectorLines.length; i++) {
      const line = vectorLines[i];
      const closest = closestPointOnLine(cursorPos, {
        start: { x: line.start[0], y: line.start[1] },
        end: { x: line.end[0], y: line.end[1] },
      });
      const dist = distance(cursorPos, closest);

      if (dist <= options.snapTolerance / 2) { // Tighter tolerance for on-line
        results.push({
          type: "on-line",
          coords: [closest.x, closest.y],
          sourceId: `line-${i}`,
          distance: dist,
        });
      }
    }
  }

  // 2. Check measurement points
  if (options.snapToMeasurements) {
    for (const measurement of measurements) {
      const points = extractMeasurementPoints(measurement);
      for (const point of points) {
        const dist = distance(cursorPos, point);
        if (dist <= options.snapTolerance) {
          results.push({
            type: "measurement",
            coords: [point.x, point.y],
            sourceId: measurement.id,
            distance: dist,
          });
        }
      }
    }
  }

  // 3. Check grid points
  if (options.snapToGrid && options.gridSpacing > 0) {
    const gridX = Math.round(cursorPos.x / options.gridSpacing) * options.gridSpacing;
    const gridY = Math.round(cursorPos.y / options.gridSpacing) * options.gridSpacing;
    const dist = distance(cursorPos, { x: gridX, y: gridY });

    if (dist <= options.snapTolerance) {
      results.push({
        type: "grid",
        coords: [gridX, gridY],
        distance: dist,
      });
    }
  }

  // Sort by distance (closest first)
  results.sort((a, b) => a.distance - b.distance);

  // Prioritize by type (intersections and endpoints before midpoints)
  const priority: Record<SnapType, number> = {
    intersection: 0,
    endpoint: 1,
    midpoint: 2,
    measurement: 3,
    center: 4,
    perpendicular: 5,
    "on-line": 6,
    grid: 7,
  };

  results.sort((a, b) => {
    // If distances are very close, use priority
    if (Math.abs(a.distance - b.distance) < 3) {
      return priority[a.type] - priority[b.type];
    }
    return a.distance - b.distance;
  });

  return results;
}

/**
 * Extract all snap-able points from a measurement
 */
function extractMeasurementPoints(measurement: Measurement): Point[] {
  const points: Point[] = [];

  if (measurement.geometry.type === "Point") {
    const coords = measurement.geometry.coordinates as number[];
    points.push({ x: coords[0], y: coords[1] });
  } else if (measurement.geometry.type === "LineString") {
    const coords = measurement.geometry.coordinates as number[][];
    // Add all vertices
    for (const coord of coords) {
      points.push({ x: coord[0], y: coord[1] });
    }
    // Add midpoints
    for (let i = 0; i < coords.length - 1; i++) {
      points.push({
        x: (coords[i][0] + coords[i + 1][0]) / 2,
        y: (coords[i][1] + coords[i + 1][1]) / 2,
      });
    }
  } else if (measurement.geometry.type === "Polygon") {
    const coords = measurement.geometry.coordinates as number[][][];
    const ring = coords[0];
    // Add all vertices (except closing point which duplicates first)
    for (let i = 0; i < ring.length - 1; i++) {
      points.push({ x: ring[i][0], y: ring[i][1] });
    }
    // Add midpoints
    for (let i = 0; i < ring.length - 1; i++) {
      const next = (i + 1) % (ring.length - 1);
      points.push({
        x: (ring[i][0] + ring[next][0]) / 2,
        y: (ring[i][1] + ring[next][1]) / 2,
      });
    }
    // Add centroid
    let cx = 0, cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      cx += ring[i][0];
      cy += ring[i][1];
    }
    points.push({ x: cx / (ring.length - 1), y: cy / (ring.length - 1) });
  }

  return points;
}

/**
 * Apply axis constraint (SHIFT key behavior)
 */
export function constrainToAxis(
  startPoint: Point,
  currentPoint: Point
): Point {
  const dx = Math.abs(currentPoint.x - startPoint.x);
  const dy = Math.abs(currentPoint.y - startPoint.y);

  if (dx > dy) {
    // Constrain to horizontal
    return { x: currentPoint.x, y: startPoint.y };
  } else {
    // Constrain to vertical
    return { x: startPoint.x, y: currentPoint.y };
  }
}
```

**Step 2: Commit**

```bash
git add src/lib/snap-utils.ts
git commit -m "feat: add snap calculation utilities

- findNearbySnapPoints: find all snappable points near cursor
- closestPointOnLine: for on-line snapping
- extractMeasurementPoints: get snap points from existing measurements
- constrainToAxis: SHIFT key horizontal/vertical constraint
- Priority-based sorting (intersections > endpoints > midpoints)"
```

---

### Task 4.3: Snap Layer Component

**Files:**
- Create: `src/components/verification/snap-layer.tsx`

**Step 1: Create the snap layer component**

```typescript
// src/components/verification/snap-layer.tsx
"use client";

import { useEffect, useRef, useCallback } from "react";
import type OLMap from "ol/Map";
import VectorSource from "ol/source/Vector";
import VectorLayer from "ol/layer/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style";

import { useSnapStore, SnapPoint, SNAP_TYPE_ICONS } from "@/lib/stores/snap-store";
import { useToolStore } from "@/lib/stores/tool-store";
import { useMeasurementStore } from "@/lib/stores/measurement-store";
import { findNearbySnapPoints } from "@/lib/snap-utils";

interface SnapLayerProps {
  map: OLMap | null;
  documentId: string;
  pageNumber: number;
}

// Colors for different snap types
const SNAP_COLORS: Record<string, string> = {
  endpoint: "#22c55e",     // Green
  midpoint: "#3b82f6",     // Blue
  intersection: "#f59e0b", // Amber
  "on-line": "#8b5cf6",    // Purple
  measurement: "#ec4899",  // Pink
  grid: "#6b7280",         // Gray
  center: "#06b6d4",       // Cyan
  perpendicular: "#84cc16", // Lime
};

export function SnapLayer({ map, documentId, pageNumber }: SnapLayerProps) {
  const {
    snapToVectors,
    snapToMeasurements,
    snapToGrid,
    gridSpacing,
    snapTolerance,
    vectorSnapPoints,
    vectorLines,
    currentSnapPoint,
    setCurrentSnapPoint,
    setNearbySnapPoints,
    isSnapped,
  } = useSnapStore();

  const { activeTool, snapEnabled } = useToolStore();
  const { measurements } = useMeasurementStore();

  const snapLayerRef = useRef<VectorLayer | null>(null);
  const snapSourceRef = useRef<VectorSource | null>(null);
  const highlightLayerRef = useRef<VectorLayer | null>(null);
  const highlightSourceRef = useRef<VectorSource | null>(null);

  // Initialize layers
  useEffect(() => {
    if (!map) return;

    // Snap indicator layer (shows the snap point)
    const snapSource = new VectorSource();
    snapSourceRef.current = snapSource;

    const snapLayer = new VectorLayer({
      source: snapSource,
      style: (feature) => {
        const snapType = feature.get("snapType") as string;
        const color = SNAP_COLORS[snapType] || "#22c55e";

        return [
          // Outer glow
          new Style({
            image: new CircleStyle({
              radius: 14,
              fill: new Fill({ color: `${color}33` }),
              stroke: new Stroke({ color: `${color}66`, width: 2 }),
            }),
          }),
          // Inner circle
          new Style({
            image: new CircleStyle({
              radius: 8,
              fill: new Fill({ color }),
              stroke: new Stroke({ color: "#ffffff", width: 2 }),
            }),
          }),
          // Type icon
          new Style({
            text: new Text({
              text: SNAP_TYPE_ICONS[snapType as keyof typeof SNAP_TYPE_ICONS] || "●",
              font: "bold 10px sans-serif",
              fill: new Fill({ color: "#ffffff" }),
              offsetY: 1,
            }),
          }),
        ];
      },
      zIndex: 500,
    });
    snapLayerRef.current = snapLayer;
    map.addLayer(snapLayer);

    // Highlight layer (shows source geometry being snapped to)
    const highlightSource = new VectorSource();
    highlightSourceRef.current = highlightSource;

    const highlightLayer = new VectorLayer({
      source: highlightSource,
      style: new Style({
        stroke: new Stroke({
          color: "#22c55e",
          width: 3,
        }),
      }),
      zIndex: 499,
    });
    highlightLayerRef.current = highlightLayer;
    map.addLayer(highlightLayer);

    return () => {
      map.removeLayer(snapLayer);
      map.removeLayer(highlightLayer);
    };
  }, [map]);

  // Handle pointer move to find snap points
  useEffect(() => {
    if (!map) return;

    const handlePointerMove = (e: any) => {
      // Only snap when using drawing tools and snap is enabled
      const isDrawingTool = ["count", "linear", "area", "rectangle", "calibrate"].includes(activeTool);
      if (!isDrawingTool || !snapEnabled) {
        if (isSnapped) {
          setCurrentSnapPoint(null);
          setNearbySnapPoints([]);
          snapSourceRef.current?.clear();
          highlightSourceRef.current?.clear();
        }
        return;
      }

      // Get cursor position in map coordinates
      const coordinate = e.coordinate;
      const cursorPos = { x: coordinate[0], y: -coordinate[1] }; // Convert to PDF coords

      // Get measurements for current page
      const pageMeasurements = measurements.filter(
        (m) => m.documentId === documentId && m.pageNumber === pageNumber
      );

      // Find nearby snap points
      const nearby = findNearbySnapPoints(
        cursorPos,
        vectorSnapPoints,
        vectorLines.map(l => ({
          start: { x: l.start[0], y: l.start[1] },
          end: { x: l.end[0], y: l.end[1] },
        })),
        pageMeasurements,
        {
          snapToVectors,
          snapToMeasurements,
          snapToGrid,
          gridSpacing,
          snapTolerance,
        }
      );

      setNearbySnapPoints(nearby);

      if (nearby.length > 0) {
        const best = nearby[0];
        setCurrentSnapPoint(best);

        // Update snap indicator
        if (snapSourceRef.current) {
          snapSourceRef.current.clear();
          const feature = new Feature({
            geometry: new Point([best.coords[0], -best.coords[1]]),
          });
          feature.set("snapType", best.type);
          snapSourceRef.current.addFeature(feature);
        }

        // Highlight source geometry
        if (highlightSourceRef.current && best.sourceId) {
          highlightSourceRef.current.clear();

          // Find and highlight the source line
          if (best.sourceId.startsWith("line-")) {
            const lineIndex = parseInt(best.sourceId.split("-")[1]);
            if (vectorLines[lineIndex]) {
              const line = vectorLines[lineIndex];
              const lineFeature = new Feature({
                geometry: new LineString([
                  [line.start[0], -line.start[1]],
                  [line.end[0], -line.end[1]],
                ]),
              });
              highlightSourceRef.current.addFeature(lineFeature);
            }
          }
        }
      } else {
        setCurrentSnapPoint(null);
        snapSourceRef.current?.clear();
        highlightSourceRef.current?.clear();
      }
    };

    map.on("pointermove", handlePointerMove);

    return () => {
      map.un("pointermove", handlePointerMove);
    };
  }, [
    map,
    activeTool,
    snapEnabled,
    snapToVectors,
    snapToMeasurements,
    snapToGrid,
    gridSpacing,
    snapTolerance,
    vectorSnapPoints,
    vectorLines,
    measurements,
    documentId,
    pageNumber,
    isSnapped,
    setCurrentSnapPoint,
    setNearbySnapPoints,
  ]);

  // Update cursor style when snapped
  useEffect(() => {
    if (!map) return;

    const target = map.getTargetElement();
    if (!target) return;

    if (isSnapped && currentSnapPoint) {
      target.style.cursor = "crosshair";
    }
  }, [map, isSnapped, currentSnapPoint]);

  return null;
}
```

**Step 2: Commit**

```bash
git add src/components/verification/snap-layer.tsx
git commit -m "feat(ui): add snap visualization layer

- Show snap indicator when near snappable point
- Color-coded by snap type (endpoint, midpoint, intersection)
- Highlight source geometry being snapped to
- Real-time pointer tracking
- Respects snap settings from store"
```

---

### Task 4.4: Snap Indicator UI Component

**Files:**
- Create: `src/components/verification/snap-indicator.tsx`

**Step 1: Create the snap indicator component**

```typescript
// src/components/verification/snap-indicator.tsx
"use client";

import { useSnapStore, SNAP_TYPE_ICONS, SNAP_TYPE_LABELS } from "@/lib/stores/snap-store";
import { useToolStore } from "@/lib/stores/tool-store";

export function SnapIndicator() {
  const { isSnapped, currentSnapPoint, nearbySnapPoints, cycleSnapPoint } = useSnapStore();
  const { snapEnabled, activeTool } = useToolStore();

  // Only show when using drawing tools
  const isDrawingTool = ["count", "linear", "area", "rectangle", "calibrate"].includes(activeTool);
  if (!isDrawingTool) return null;

  if (!snapEnabled) {
    return (
      <div className="absolute bottom-4 left-4 bg-gray-800/80 text-gray-400 px-3 py-1.5 rounded-lg text-sm">
        Snap: OFF (hold ALT)
      </div>
    );
  }

  if (!isSnapped || !currentSnapPoint) {
    return (
      <div className="absolute bottom-4 left-4 bg-gray-800/80 text-gray-300 px-3 py-1.5 rounded-lg text-sm">
        Move near a snap point...
      </div>
    );
  }

  const icon = SNAP_TYPE_ICONS[currentSnapPoint.type];
  const label = SNAP_TYPE_LABELS[currentSnapPoint.type];

  return (
    <div className="absolute bottom-4 left-4 bg-green-900/90 text-green-100 px-3 py-2 rounded-lg shadow-lg">
      <div className="flex items-center gap-2">
        <span className="text-lg">{icon}</span>
        <span className="font-medium">{label}</span>
        {nearbySnapPoints.length > 1 && (
          <button
            onClick={cycleSnapPoint}
            className="ml-2 px-2 py-0.5 bg-green-700 hover:bg-green-600 rounded text-xs"
            title="Cycle snap points (TAB)"
          >
            TAB ({nearbySnapPoints.length})
          </button>
        )}
      </div>
      <div className="text-xs text-green-300 mt-1">
        ({currentSnapPoint.coords[0].toFixed(1)}, {currentSnapPoint.coords[1].toFixed(1)})
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/verification/snap-indicator.tsx
git commit -m "feat(ui): add snap indicator component

- Shows current snap type with icon and label
- Shows coordinates of snap point
- TAB button to cycle through nearby alternatives
- Indicates when snap is disabled"
```

---

### Task 4.5: Load Vector Geometry for Snapping

**Files:**
- Create: `src/hooks/use-vector-geometry.ts`

**Step 1: Create hook to load vector geometry**

```typescript
// src/hooks/use-vector-geometry.ts
import { useEffect } from "react";
import { useSnapStore } from "@/lib/stores/snap-store";

interface VectorGeometryResult {
  lines: Array<{ start: [number, number]; end: [number, number]; width: number }>;
  snapPoints: Array<{ type: string; coords: [number, number] }>;
  quality: string;
}

export function useVectorGeometry(documentId: string, pageNumber: number) {
  const { setVectorGeometry, clearVectorGeometry } = useSnapStore();

  useEffect(() => {
    let cancelled = false;

    async function loadVectors() {
      try {
        const response = await fetch(
          `/api/vectors/${documentId}/${pageNumber}`
        );

        if (!response.ok) {
          if (response.status === 404) {
            // No vectors extracted yet - that's ok
            clearVectorGeometry();
            return;
          }
          throw new Error("Failed to fetch vectors");
        }

        const data: VectorGeometryResult = await response.json();

        if (cancelled) return;

        // Transform to snap store format
        const snapPoints = data.snapPoints.map((sp) => ({
          type: sp.type as any,
          coords: sp.coords,
          distance: 0,
        }));

        const lines = data.lines.map((l) => ({
          start: l.start,
          end: l.end,
        }));

        setVectorGeometry(snapPoints, lines);
      } catch (error) {
        console.error("Error loading vector geometry:", error);
        clearVectorGeometry();
      }
    }

    loadVectors();

    return () => {
      cancelled = true;
    };
  }, [documentId, pageNumber, setVectorGeometry, clearVectorGeometry]);
}
```

**Step 2: Commit**

```bash
git add src/hooks/use-vector-geometry.ts
git commit -m "feat: add hook to load vector geometry for snapping

- Fetches vectors from /api/vectors/[documentId]/[pageNumber]
- Transforms to snap store format
- Handles 404 gracefully (no vectors yet)
- Cleans up on unmount or page change"
```

---

### Task 4.6: Integrate Snap into Drawing

**Files:**
- Modify: `src/components/verification/drawing-layer.tsx`

**Step 1: Add snap integration to drawing**

Add this to the Draw interaction setup in `drawing-layer.tsx`:

```typescript
// At the top, add import:
import { useSnapStore } from "@/lib/stores/snap-store";

// In the component, add:
const { isSnapped, currentSnapPoint, snapEnabled } = useSnapStore();

// Modify the Draw interaction to use snapped coordinates:
// Add a geometryFunction that snaps the final point

// After creating the Draw interaction:
if (activeTool !== "rectangle") {
  // For non-rectangle tools, we need custom handling
  // The actual snapping happens by modifying the coordinate during draw

  draw.on("drawstart", (e) => {
    setIsDrawing(true);

    // If we're snapped, move the start point to snap location
    if (isSnapped && currentSnapPoint && snapEnabled) {
      const geometry = e.feature.getGeometry();
      if (geometry) {
        const snapCoord = [currentSnapPoint.coords[0], -currentSnapPoint.coords[1]];

        if (geometry.getType() === "Point") {
          (geometry as Point).setCoordinates(snapCoord);
        } else if (geometry.getType() === "LineString") {
          const coords = (geometry as LineString).getCoordinates();
          coords[0] = snapCoord;
          (geometry as LineString).setCoordinates(coords);
        } else if (geometry.getType() === "Polygon") {
          const coords = (geometry as Polygon).getCoordinates();
          coords[0][0] = snapCoord;
          (geometry as Polygon).setCoordinates(coords);
        }
      }
    }
  });
}

// Override the coordinate before each vertex is added:
map.on("click", (e) => {
  if (!isDrawingTool() || activeTool === "select") return;

  if (isSnapped && currentSnapPoint && snapEnabled) {
    // Replace the click coordinate with the snap coordinate
    e.coordinate = [currentSnapPoint.coords[0], -currentSnapPoint.coords[1]];
  }
});
```

**Step 2: Commit**

```bash
git add src/components/verification/drawing-layer.tsx
git commit -m "feat(drawing): integrate snapping into draw interactions

- Use snapped coordinates when clicking during draw
- Override click event coordinate to snap location
- Works with all drawing tools (count, linear, area)"
```

---

This completes **Module 4: Snap System**.

**Checkpoint:** At this point you have:
- ✅ Snap store for managing snap state
- ✅ Snap calculation utilities
- ✅ Snap layer for visual feedback
- ✅ Snap indicator showing current snap type
- ✅ Vector geometry loading hook
- ✅ Integration with drawing interactions

---

## Module 5: Keyboard Shortcuts

**Purpose:** Implement keyboard-first interaction design. Every action should be accessible via keyboard. Power users should never need the mouse for tool selection, mode switching, or measurement completion.

**Deliverables:**
- `useKeyboardShortcuts` hook with all bindings
- Tool switching (V, C, L, A, R, S)
- Drawing controls (Escape, Enter, Backspace)
- Navigation (Space+drag for pan, scroll for zoom)
- Snap toggle (Ctrl/Cmd)
- Undo/Redo (Ctrl+Z, Ctrl+Shift+Z)
- Visual shortcut legend component

### Task 5.1: Keyboard Shortcut Hook

**Files:**
- Create: `src/hooks/use-keyboard-shortcuts.ts`

**Step 1: Create the keyboard shortcuts hook**

```typescript
// src/hooks/use-keyboard-shortcuts.ts
import { useEffect, useCallback, useRef } from "react";
import { useToolStore } from "@/stores/tool-store";
import { useMeasurementStore } from "@/stores/measurement-store";
import { useSnapStore } from "@/stores/snap-store";
import type { Map } from "ol";

interface KeyboardShortcutsOptions {
  map: Map | null;
  enabled?: boolean;
}

export function useKeyboardShortcuts({ map, enabled = true }: KeyboardShortcutsOptions) {
  const { activeTool, setActiveTool, isDrawing, cancelDrawing } = useToolStore();
  const { undo, redo, deleteSelectedMeasurements, selectedIds } = useMeasurementStore();
  const { snapEnabled, toggleSnap } = useSnapStore();

  // Track modifier keys
  const modifiersRef = useRef({ ctrl: false, shift: false, alt: false, meta: false });

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;

    // Update modifier tracking
    modifiersRef.current = {
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey,
    };

    // Ignore if focused on input/textarea
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
      return;
    }

    const key = e.key.toLowerCase();
    const isMod = e.metaKey || e.ctrlKey;

    // === TOOL SELECTION (only when not drawing) ===
    if (!isDrawing && !isMod) {
      switch (key) {
        case "v":
        case "escape":
          setActiveTool("select");
          e.preventDefault();
          return;
        case "c":
          setActiveTool("count");
          e.preventDefault();
          return;
        case "l":
          setActiveTool("linear");
          e.preventDefault();
          return;
        case "a":
          setActiveTool("area");
          e.preventDefault();
          return;
        case "r":
          setActiveTool("rectangle");
          e.preventDefault();
          return;
        case "s":
          setActiveTool("calibrate");
          e.preventDefault();
          return;
      }
    }

    // === DRAWING CONTROLS ===
    if (isDrawing) {
      switch (key) {
        case "escape":
          // Cancel current drawing
          cancelDrawing();
          e.preventDefault();
          return;
        case "enter":
          // Complete current drawing (handled by draw interaction)
          // Dispatch custom event for drawing layer to pick up
          window.dispatchEvent(new CustomEvent("takeoff:complete-drawing"));
          e.preventDefault();
          return;
        case "backspace":
        case "delete":
          // Remove last point (handled by draw interaction)
          window.dispatchEvent(new CustomEvent("takeoff:undo-last-point"));
          e.preventDefault();
          return;
      }
    }

    // === SNAP TOGGLE ===
    // Hold Ctrl/Cmd to temporarily disable snap
    if (key === "control" || key === "meta") {
      toggleSnap();
      return;
    }

    // === UNDO/REDO ===
    if (isMod && key === "z") {
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
      e.preventDefault();
      return;
    }

    // === DELETE SELECTED ===
    if ((key === "backspace" || key === "delete") && !isDrawing && selectedIds.length > 0) {
      deleteSelectedMeasurements();
      e.preventDefault();
      return;
    }

    // === NAVIGATION ===
    if (map) {
      const view = map.getView();
      const center = view.getCenter();
      const resolution = view.getResolution() || 1;
      const panDistance = 100 * resolution;

      switch (key) {
        case "arrowleft":
          if (center) view.setCenter([center[0] - panDistance, center[1]]);
          e.preventDefault();
          return;
        case "arrowright":
          if (center) view.setCenter([center[0] + panDistance, center[1]]);
          e.preventDefault();
          return;
        case "arrowup":
          if (center) view.setCenter([center[0], center[1] + panDistance]);
          e.preventDefault();
          return;
        case "arrowdown":
          if (center) view.setCenter([center[0], center[1] - panDistance]);
          e.preventDefault();
          return;
        case "+":
        case "=":
          view.setZoom((view.getZoom() || 1) + 0.5);
          e.preventDefault();
          return;
        case "-":
        case "_":
          view.setZoom((view.getZoom() || 1) - 0.5);
          e.preventDefault();
          return;
        case "0":
          if (isMod) {
            // Fit to extent
            window.dispatchEvent(new CustomEvent("takeoff:fit-to-page"));
            e.preventDefault();
          }
          return;
      }
    }
  }, [enabled, isDrawing, activeTool, map, selectedIds, setActiveTool, cancelDrawing, toggleSnap, undo, redo, deleteSelectedMeasurements]);

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;

    // Update modifier tracking
    modifiersRef.current = {
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey,
    };

    // Re-enable snap when Ctrl/Cmd released
    const key = e.key.toLowerCase();
    if ((key === "control" || key === "meta") && !snapEnabled) {
      toggleSnap();
    }
  }, [enabled, snapEnabled, toggleSnap]);

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [enabled, handleKeyDown, handleKeyUp]);

  return {
    modifiers: modifiersRef.current,
  };
}
```

**Step 2: Export from hooks index**

```typescript
// src/hooks/index.ts (add export)
export { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
```

**Step 3: Add cancelDrawing to tool store**

Update `src/stores/tool-store.ts`:

```typescript
// Add to ToolState interface:
cancelDrawing: () => void;

// Add to store implementation:
cancelDrawing: () => {
  set({ isDrawing: false });
  // Dispatch event for drawing layer to cancel
  window.dispatchEvent(new CustomEvent("takeoff:cancel-drawing"));
},
```

**Step 4: Commit**

```bash
git add src/hooks/use-keyboard-shortcuts.ts src/stores/tool-store.ts
git commit -m "feat(keyboard): implement keyboard shortcuts hook

- Tool selection: V (select), C (count), L (linear), A (area), R (rect), S (scale)
- Drawing: Escape (cancel), Enter (complete), Backspace (undo point)
- Snap: Hold Ctrl/Cmd to temporarily disable
- History: Ctrl+Z (undo), Ctrl+Shift+Z (redo)
- Navigation: Arrow keys (pan), +/- (zoom), Ctrl+0 (fit)
- Delete: Backspace/Delete when measurements selected"
```

---

### Task 5.2: Drawing Layer Event Handlers

**Files:**
- Modify: `src/components/verification/drawing-layer.tsx`

**Step 1: Add event handlers for keyboard shortcuts**

Add these handlers inside the DrawingLayer component:

```typescript
// Inside DrawingLayer component, add event listeners for keyboard commands

useEffect(() => {
  if (!drawInteraction) return;

  const handleCompleteDrawing = () => {
    // Finish the current drawing
    drawInteraction.finishDrawing();
  };

  const handleUndoLastPoint = () => {
    // Remove the last point from the drawing
    drawInteraction.removeLastPoint();
  };

  const handleCancelDrawing = () => {
    // Abort the current drawing
    drawInteraction.abortDrawing();
    setActiveTool("select");
  };

  window.addEventListener("takeoff:complete-drawing", handleCompleteDrawing);
  window.addEventListener("takeoff:undo-last-point", handleUndoLastPoint);
  window.addEventListener("takeoff:cancel-drawing", handleCancelDrawing);

  return () => {
    window.removeEventListener("takeoff:complete-drawing", handleCompleteDrawing);
    window.removeEventListener("takeoff:undo-last-point", handleUndoLastPoint);
    window.removeEventListener("takeoff:cancel-drawing", handleCancelDrawing);
  };
}, [drawInteraction, setActiveTool]);
```

**Step 2: Add fit-to-page handler in the viewer**

Add to `openlayers-tile-viewer.tsx`:

```typescript
// Inside the viewer component
useEffect(() => {
  if (!mapRef.current) return;

  const handleFitToPage = () => {
    const map = mapRef.current;
    if (!map) return;

    const extent = [0, -pageHeight, pageWidth, 0];
    map.getView().fit(extent, {
      padding: [50, 50, 50, 50],
      duration: 250,
    });
  };

  window.addEventListener("takeoff:fit-to-page", handleFitToPage);
  return () => window.removeEventListener("takeoff:fit-to-page", handleFitToPage);
}, [pageWidth, pageHeight]);
```

**Step 3: Commit**

```bash
git add src/components/verification/drawing-layer.tsx src/components/verification/openlayers-tile-viewer.tsx
git commit -m "feat(keyboard): wire up drawing layer to keyboard events

- Enter finishes current drawing
- Backspace removes last point
- Escape aborts drawing and returns to select
- Ctrl+0 fits view to page extent"
```

---

### Task 5.3: Shortcut Legend Component

**Files:**
- Create: `src/components/verification/shortcut-legend.tsx`

**Step 1: Create the shortcut legend component**

```tsx
// src/components/verification/shortcut-legend.tsx
"use client";

import { useState } from "react";
import { Keyboard, X, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface ShortcutGroup {
  title: string;
  shortcuts: { key: string; description: string }[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Tools",
    shortcuts: [
      { key: "V", description: "Select tool" },
      { key: "C", description: "Count tool" },
      { key: "L", description: "Linear measure" },
      { key: "A", description: "Area measure" },
      { key: "R", description: "Rectangle" },
      { key: "S", description: "Set scale" },
    ],
  },
  {
    title: "Drawing",
    shortcuts: [
      { key: "Enter", description: "Complete drawing" },
      { key: "Esc", description: "Cancel / Select tool" },
      { key: "Backspace", description: "Undo last point" },
    ],
  },
  {
    title: "Editing",
    shortcuts: [
      { key: "⌘Z", description: "Undo" },
      { key: "⌘⇧Z", description: "Redo" },
      { key: "Delete", description: "Delete selected" },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [
      { key: "↑↓←→", description: "Pan view" },
      { key: "+/-", description: "Zoom in/out" },
      { key: "⌘0", description: "Fit to page" },
      { key: "Space+drag", description: "Pan (hold)" },
    ],
  },
  {
    title: "Snapping",
    shortcuts: [
      { key: "Hold ⌘", description: "Disable snap" },
    ],
  },
];

interface ShortcutLegendProps {
  className?: string;
  defaultExpanded?: boolean;
}

export function ShortcutLegend({ className, defaultExpanded = false }: ShortcutLegendProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [isVisible, setIsVisible] = useState(true);

  if (!isVisible) {
    return (
      <button
        onClick={() => setIsVisible(true)}
        className={cn(
          "absolute bottom-4 right-4 p-2 bg-white/90 backdrop-blur rounded-lg shadow-lg",
          "hover:bg-gray-100 transition-colors",
          className
        )}
        title="Show keyboard shortcuts"
      >
        <Keyboard className="w-5 h-5 text-gray-600" />
      </button>
    );
  }

  return (
    <div
      className={cn(
        "absolute bottom-4 right-4 bg-white/95 backdrop-blur rounded-lg shadow-lg",
        "border border-gray-200 overflow-hidden transition-all duration-200",
        isExpanded ? "w-72" : "w-auto",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900"
        >
          <Keyboard className="w-4 h-4" />
          <span>Shortcuts</span>
          {isExpanded ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronUp className="w-4 h-4" />
          )}
        </button>
        <button
          onClick={() => setIsVisible(false)}
          className="p-1 hover:bg-gray-100 rounded"
          title="Hide"
        >
          <X className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      {/* Content */}
      {isExpanded && (
        <div className="p-3 max-h-80 overflow-y-auto">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="mb-3 last:mb-0">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                {group.title}
              </h4>
              <div className="space-y-1">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.key}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-gray-600">{shortcut.description}</span>
                    <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono text-gray-700 min-w-[40px] text-center">
                      {shortcut.key}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Add to the viewer**

```tsx
// In openlayers-tile-viewer.tsx, import and add:
import { ShortcutLegend } from "./shortcut-legend";

// In the return JSX, add inside the container div:
<ShortcutLegend />
```

**Step 3: Commit**

```bash
git add src/components/verification/shortcut-legend.tsx src/components/verification/openlayers-tile-viewer.tsx
git commit -m "feat(keyboard): add visual shortcut legend component

- Collapsible legend showing all keyboard shortcuts
- Grouped by category: Tools, Drawing, Editing, Navigation, Snapping
- Can be hidden/shown, remembers collapsed state
- Positioned bottom-right of viewer"
```

---

### Task 5.4: Space+Drag Pan Mode

**Files:**
- Modify: `src/hooks/use-keyboard-shortcuts.ts`
- Modify: `src/components/verification/openlayers-tile-viewer.tsx`

**Step 1: Track spacebar state in hook**

Update `use-keyboard-shortcuts.ts`:

```typescript
// Add to the hook
const [isSpaceHeld, setIsSpaceHeld] = useState(false);

// In handleKeyDown:
if (key === " " || key === "space") {
  setIsSpaceHeld(true);
  e.preventDefault();
  return;
}

// In handleKeyUp:
if (key === " " || key === "space") {
  setIsSpaceHeld(false);
  return;
}

// Return from hook:
return {
  modifiers: modifiersRef.current,
  isSpaceHeld,
};
```

**Step 2: Apply pan-only mode when space held**

In `openlayers-tile-viewer.tsx`:

```typescript
const { isSpaceHeld } = useKeyboardShortcuts({ map: mapRef.current, enabled: true });

// Effect to toggle cursor and disable draw when space held
useEffect(() => {
  const container = containerRef.current;
  if (!container) return;

  if (isSpaceHeld) {
    container.style.cursor = "grab";
    // Temporarily disable draw interaction
    window.dispatchEvent(new CustomEvent("takeoff:pause-drawing"));
  } else {
    container.style.cursor = "";
    window.dispatchEvent(new CustomEvent("takeoff:resume-drawing"));
  }
}, [isSpaceHeld]);
```

**Step 3: Handle pause/resume in drawing layer**

```typescript
// In DrawingLayer, add:
useEffect(() => {
  if (!drawInteraction) return;

  const handlePause = () => {
    drawInteraction.setActive(false);
  };

  const handleResume = () => {
    if (isDrawingTool()) {
      drawInteraction.setActive(true);
    }
  };

  window.addEventListener("takeoff:pause-drawing", handlePause);
  window.addEventListener("takeoff:resume-drawing", handleResume);

  return () => {
    window.removeEventListener("takeoff:pause-drawing", handlePause);
    window.removeEventListener("takeoff:resume-drawing", handleResume);
  };
}, [drawInteraction, activeTool]);
```

**Step 4: Commit**

```bash
git add src/hooks/use-keyboard-shortcuts.ts src/components/verification/openlayers-tile-viewer.tsx src/components/verification/drawing-layer.tsx
git commit -m "feat(keyboard): implement space+drag pan mode

- Hold Space to enter pan-only mode
- Cursor changes to grab while space held
- Drawing temporarily disabled during pan
- Matches Figma/design tool conventions"
```

---

### Task 5.5: Wire Up Keyboard Hook in Main Viewer

**Files:**
- Modify: `src/components/verification/openlayers-tile-viewer.tsx`

**Step 1: Initialize keyboard shortcuts**

```tsx
// In OpenLayersTileViewer component:
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

// Inside component:
const [mapInstance, setMapInstance] = useState<Map | null>(null);

// After map initialization:
useEffect(() => {
  if (mapRef.current) {
    setMapInstance(mapRef.current);
  }
}, [/* deps that indicate map is ready */]);

// Use the hook:
const { isSpaceHeld } = useKeyboardShortcuts({
  map: mapInstance,
  enabled: true,
});
```

**Step 2: Ensure container is focusable**

```tsx
// On the container div:
<div
  ref={containerRef}
  tabIndex={0}
  className="relative w-full h-full focus:outline-none"
  onFocus={() => {/* optional: track focus state */}}
>
```

**Step 3: Commit**

```bash
git add src/components/verification/openlayers-tile-viewer.tsx
git commit -m "feat(keyboard): enable keyboard shortcuts in viewer

- Initialize keyboard hook with map instance
- Make container focusable for keyboard events
- Full keyboard-first interaction now active"
```

---

This completes **Module 5: Keyboard Shortcuts**.

**Checkpoint:** At this point you have:
- ✅ Keyboard shortcut hook with all bindings
- ✅ Tool switching via keyboard (V, C, L, A, R, S)
- ✅ Drawing controls (Escape, Enter, Backspace)
- ✅ Navigation (arrows, +/-, Ctrl+0)
- ✅ Snap toggle (hold Ctrl/Cmd)
- ✅ Undo/Redo (Ctrl+Z, Ctrl+Shift+Z)
- ✅ Space+drag pan mode
- ✅ Visual shortcut legend component

---

## Execution Plan

### Phase 1: Foundation (Modules 1 + 2 in parallel)

**Goal:** Get vector extraction working and scale calibration UI built. These are independent and can proceed simultaneously.

**Module 1 Track (Vector Extraction):**
1. Task 1.1: Python project setup
2. Task 1.2: Core extraction logic
3. Task 1.3: Snap point generation
4. Task 1.4: FastAPI server
5. Task 1.5: Database schema + API routes
6. Task 1.6: Integration with tile pipeline

**Module 2 Track (Scale System):**
1. Task 2.1: Scale store
2. Task 2.2: Calibration modal
3. Task 2.3: Scale indicator
4. Task 2.4: Persistence (API + DB)

**Phase 1 Checkpoint:**
- [ ] `POST /api/vectors/extract` returns vector geometry for a PDF page
- [ ] Scale calibration modal opens, accepts two clicks + distance
- [ ] Scale persists to database and loads on page open
- [ ] Snap points visible in debug mode

### Phase 2: Drawing (Module 3)

**Goal:** Implement all measurement tools with persistence.

**Tasks (sequential):**
1. Task 3.1: Tool store
2. Task 3.2: Measurement store
3. Task 3.3: Toolbar UI
4. Task 3.4: Drawing layer (OpenLayers interactions)
5. Task 3.5: Measurement persistence (DB + API)
6. Task 3.6: Wire up with scale for real dimensions

**Phase 2 Checkpoint:**
- [ ] Toolbar shows with all tools
- [ ] Can draw count, linear, area, rectangle measurements
- [ ] Measurements display calculated dimensions (using scale)
- [ ] Measurements save to database
- [ ] Measurements reload on page refresh

### Phase 3: Snapping (Module 4)

**Goal:** Connect drawing to vector geometry for precision snapping.

**Tasks (sequential, depends on Module 1 + 3):**
1. Task 4.1: Snap store
2. Task 4.2: Snap calculation utilities
3. Task 4.3: Snap layer (visual feedback)
4. Task 4.4: Snap indicator UI
5. Task 4.5: Load vectors on page change
6. Task 4.6: Integrate with drawing interactions

**Phase 3 Checkpoint:**
- [ ] Cursor snaps to PDF geometry endpoints
- [ ] Cursor snaps to midpoints
- [ ] Cursor snaps to intersections
- [ ] Visual indicator shows snap type
- [ ] Snap can be toggled with Ctrl/Cmd

### Phase 4: Polish (Module 5)

**Goal:** Full keyboard-first experience.

**Tasks:**
1. Task 5.1: Keyboard shortcut hook
2. Task 5.2: Drawing layer event handlers
3. Task 5.3: Shortcut legend component
4. Task 5.4: Space+drag pan mode
5. Task 5.5: Wire up in main viewer

**Phase 4 Checkpoint:**
- [ ] All tools accessible via single key (V, C, L, A, R, S)
- [ ] Drawing controllable without mouse (Enter, Escape, Backspace)
- [ ] Undo/Redo works (Ctrl+Z)
- [ ] Navigation works (arrows, +/-)
- [ ] Shortcut legend visible and helpful

---

## Integration Test Scenarios

After all modules complete, verify these end-to-end scenarios:

### Scenario 1: Complete Takeoff Workflow
1. Open a PDF with architectural floor plan
2. Press `S` → calibrate scale using a known dimension (e.g., door width = 3')
3. Press `L` → draw linear measurement along a wall
4. Verify measurement shows real dimension (feet/inches)
5. Press `A` → draw area around a room
6. Verify area shows square footage
7. Verify snapping works at corners
8. Press `Ctrl+Z` → undo area measurement
9. Refresh page → verify measurements reload

### Scenario 2: Snap Precision Test
1. Open a PDF with CAD vectors
2. Verify vectors extracted (check database)
3. Draw a linear measurement
4. Hover near a vector endpoint → verify snap indicator shows "Endpoint"
5. Hover at midpoint of a line → verify "Midpoint"
6. Hover at line intersection → verify "Intersection"
7. Hold Ctrl → verify snap disables, cursor free-form

### Scenario 3: Keyboard-Only Workflow
1. Focus the viewer (Tab)
2. Press `C` → tool switches to count
3. Click to place a count point
4. Press `L` → tool switches to linear
5. Click start, click end → measurement appears
6. Press `Escape` → tool switches to select
7. Arrow keys → pan view
8. `+` → zoom in
9. `Ctrl+0` → fit to page

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| PyMuPDF extraction slow | Run extraction async, cache results, show loading state |
| Snapping performance with many vectors | Spatial index (R-tree), limit snap candidates by distance |
| Coordinate system confusion | Always use PDF coords (Y-down) internally, convert only for display |
| Browser keyboard conflicts | Prevent default on all handled keys, document exceptions |
| Mobile/touch support | Out of scope for v1, add touch handlers in future |

---

## Definition of Done

The takeoff measurement system is complete when:

1. **Vector Extraction**
   - [ ] Vectors extract from any PDF page
   - [ ] Snap points generated (endpoints, midpoints, intersections)
   - [ ] Quality assessment accurate
   - [ ] Vectors persist to database

2. **Scale System**
   - [ ] Calibration UI works (two clicks + distance input)
   - [ ] Scale persists per document-page
   - [ ] Scale used for all dimension calculations
   - [ ] Scale indicator visible

3. **Drawing Tools**
   - [ ] Count tool places markers
   - [ ] Linear tool draws lines with dimensions
   - [ ] Area tool draws polygons with area
   - [ ] Rectangle tool draws rectangles with dimensions
   - [ ] All measurements persist to database
   - [ ] Measurements load on page open

4. **Snap System**
   - [ ] Snaps to PDF vector endpoints
   - [ ] Snaps to midpoints
   - [ ] Snaps to intersections
   - [ ] Snaps to grid (optional)
   - [ ] Visual feedback clear
   - [ ] Toggle with Ctrl/Cmd

5. **Keyboard Shortcuts**
   - [ ] All tools have single-key shortcuts
   - [ ] Drawing controllable via keyboard
   - [ ] Undo/Redo works
   - [ ] Navigation works
   - [ ] Legend visible

---

## Appendix: Quick Reference

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/vectors/extract` | POST | Trigger vector extraction for a document page |
| `/api/vectors/[documentId]/[page]` | GET | Get extracted vectors for a page |
| `/api/documents/[id]/scale` | GET/POST | Get or set scale for document page |
| `/api/measurements` | GET/POST | List or create measurements |
| `/api/measurements/[id]` | PATCH/DELETE | Update or delete measurement |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| V | Select tool |
| C | Count tool |
| L | Linear measure |
| A | Area measure |
| R | Rectangle |
| S | Set scale (calibrate) |
| Escape | Cancel / Select tool |
| Enter | Complete drawing |
| Backspace | Undo last point / Delete selected |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| ↑↓←→ | Pan view |
| +/- | Zoom |
| Ctrl+0 | Fit to page |
| Hold Ctrl | Disable snap |
| Space+drag | Pan mode |

### Snap Types

| Type | Priority | Description |
|------|----------|-------------|
| endpoint | 1 (highest) | Start/end of lines |
| intersection | 2 | Where lines cross |
| midpoint | 3 | Center of line segments |
| perpendicular | 4 | 90° to a line |
| on-line | 5 | Anywhere on a line |
| grid | 6 (lowest) | Grid intersection |

### Coordinate Systems

- **PDF Coordinates:** Origin top-left, Y increases downward, units in points (1/72 inch)
- **OpenLayers Coordinates:** Origin top-left, Y increases upward (inverted), same scale as PDF
- **Conversion:** `olY = -pdfY`, `pdfY = -olY`

---

## Summary

This plan delivers a production-ready takeoff measurement system with:

- **5 modules** with clear boundaries and dependencies
- **27 tasks** broken into atomic, testable steps
- **Complete code** for all components (copy-paste ready)
- **Integration tests** to verify end-to-end workflows
- **Risk mitigation** for known challenges

**Estimated scope:**
- Module 1: 6 tasks (foundation, can parallelize)
- Module 2: 4 tasks (independent)
- Module 3: 6 tasks (core functionality)
- Module 4: 6 tasks (precision)
- Module 5: 5 tasks (polish)

**Next step:** Use `superpowers:subagent-driven-development` or launch a parallel session with `superpowers:executing-plans` to begin implementation.

---

*End of Plan*
