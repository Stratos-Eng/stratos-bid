import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffSheets, sheetVectors, takeoffProjects, documents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { getDocumentProxy } from 'unpdf';
import * as pdfjs from 'unpdf/pdfjs';
import { extractVectorsSchema, getVectorsSchema, formatZodError } from '@/lib/validations/takeoff';
import { downloadFile, isBlobUrl } from '@/lib/storage';

// OPS constants for PDF operator list (moveTo, lineTo, etc.)
const OPS = pdfjs.OPS;

// Python serverless function URL (set in environment)
const PYTHON_VECTOR_API_URL = process.env.PYTHON_VECTOR_API_URL;

// Types for extracted geometry
interface SnapPoint {
  type: 'endpoint' | 'midpoint' | 'intersection';
  coords: [number, number];
}

interface LineSegment {
  start: [number, number];
  end: [number, number];
}

// Helper to calculate distance between points
function distance(p1: [number, number], p2: [number, number]): number {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// Helper to calculate midpoint
function midpoint(p1: [number, number], p2: [number, number]): [number, number] {
  return [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
}

// Helper to find line intersection
function lineIntersection(
  l1: LineSegment,
  l2: LineSegment
): [number, number] | null {
  const x1 = l1.start[0], y1 = l1.start[1], x2 = l1.end[0], y2 = l1.end[1];
  const x3 = l2.start[0], y3 = l2.start[1], x4 = l2.end[0], y4 = l2.end[1];

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 0.0001) return null; // Parallel or coincident

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

  // Check if intersection is within both line segments
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
  }

  return null;
}

// Deduplicate points that are too close together
function dedupePoints(points: SnapPoint[], tolerance: number = 2): SnapPoint[] {
  const result: SnapPoint[] = [];

  for (const point of points) {
    const isDupe = result.some(
      (existing) => distance(existing.coords, point.coords) < tolerance
    );
    if (!isDupe) {
      result.push(point);
    }
  }

  return result;
}

// Extract vectors from PDF page using operator list
async function extractVectorsFromPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  scale: number
): Promise<{ lines: LineSegment[]; snapPoints: SnapPoint[]; rawCount: number; cleanedCount: number }> {
  const operatorList = await page.getOperatorList();
  const viewport = page.getViewport({ scale });

  const rawLines: LineSegment[] = [];
  let currentX = 0;
  let currentY = 0;
  let pathStartX = 0;
  let pathStartY = 0;

  // Transform function to convert PDF coordinates to display coordinates
  const transform = (x: number, y: number): [number, number] => {
    // Apply viewport transform (PDF Y is bottom-up, we want top-down)
    const tx = x * scale;
    const ty = viewport.height - y * scale;
    return [tx, -ty]; // Negative Y for OpenLayers coordinate system
  };

  // Process operator list
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const fn = operatorList.fnArray[i];
    const args = operatorList.argsArray[i];

    switch (fn) {
      case OPS.moveTo:
        if (args && args.length >= 2) {
          [currentX, currentY] = [args[0], args[1]];
          [pathStartX, pathStartY] = [args[0], args[1]];
        }
        break;

      case OPS.lineTo:
        if (args && args.length >= 2) {
          const start = transform(currentX, currentY);
          const end = transform(args[0], args[1]);

          // Filter out tiny lines (likely noise)
          if (distance(start, end) >= 5) {
            rawLines.push({ start, end });
          }

          [currentX, currentY] = [args[0], args[1]];
        }
        break;

      case OPS.closePath:
        {
          const start = transform(currentX, currentY);
          const end = transform(pathStartX, pathStartY);

          if (distance(start, end) >= 5) {
            rawLines.push({ start, end });
          }

          [currentX, currentY] = [pathStartX, pathStartY];
        }
        break;

      case OPS.rectangle:
        if (args && args.length >= 4) {
          const [x, y, w, h] = args;
          // Create 4 lines for rectangle
          const corners: [number, number][] = [
            transform(x, y),
            transform(x + w, y),
            transform(x + w, y + h),
            transform(x, y + h),
          ];

          for (let j = 0; j < 4; j++) {
            const start = corners[j];
            const end = corners[(j + 1) % 4];
            if (distance(start, end) >= 5) {
              rawLines.push({ start, end });
            }
          }
        }
        break;
    }
  }

  // Clean lines - filter out hatching patterns (many parallel short lines)
  // and merge collinear segments
  const cleanedLines = cleanLines(rawLines);

  // Generate snap points
  const snapPoints: SnapPoint[] = [];

  // Endpoints
  for (const line of cleanedLines) {
    snapPoints.push({ type: 'endpoint', coords: line.start });
    snapPoints.push({ type: 'endpoint', coords: line.end });

    // Midpoints
    snapPoints.push({ type: 'midpoint', coords: midpoint(line.start, line.end) });
  }

  // Intersections (only check first N lines to avoid O(n²) explosion)
  const maxIntersectionCheck = Math.min(cleanedLines.length, 500);
  for (let i = 0; i < maxIntersectionCheck; i++) {
    for (let j = i + 1; j < maxIntersectionCheck; j++) {
      const intersection = lineIntersection(cleanedLines[i], cleanedLines[j]);
      if (intersection) {
        snapPoints.push({ type: 'intersection', coords: intersection });
      }
    }
  }

  // Dedupe nearby points
  const dedupedPoints = dedupePoints(snapPoints, 2);

  return {
    lines: cleanedLines,
    snapPoints: dedupedPoints,
    rawCount: rawLines.length,
    cleanedCount: cleanedLines.length,
  };
}

// Clean lines - remove hatching, merge collinear segments
function cleanLines(lines: LineSegment[]): LineSegment[] {
  const result: LineSegment[] = [];

  // Simple filtering for now - remove very short lines and obvious duplicates
  for (const line of lines) {
    const len = distance(line.start, line.end);

    // Skip very short lines (likely noise or hatching)
    if (len < 10) continue;

    // Skip duplicates
    const isDupe = result.some((existing) => {
      const d1 = distance(existing.start, line.start) + distance(existing.end, line.end);
      const d2 = distance(existing.start, line.end) + distance(existing.end, line.start);
      return d1 < 4 || d2 < 4;
    });

    if (!isDupe) {
      result.push(line);
    }
  }

  return result;
}

// Assess quality of extracted vectors
function assessQuality(rawCount: number, cleanedCount: number): string {
  if (cleanedCount === 0) return 'none';
  const survivalRate = cleanedCount / rawCount;
  if (survivalRate > 0.7 && cleanedCount > 50) return 'good';
  if (survivalRate > 0.3 && cleanedCount > 20) return 'medium';
  return 'poor';
}

// Try extracting vectors using Python (PyMuPDF) serverless function
async function extractVectorsWithPython(
  pdfData: Uint8Array,
  pageNum: number,
  scale: number = 1.5
): Promise<{
  success: boolean;
  lines?: LineSegment[];
  snapPoints?: SnapPoint[];
  rawCount?: number;
  cleanedCount?: number;
  quality?: string;
  error?: string;
}> {
  if (!PYTHON_VECTOR_API_URL) {
    return { success: false, error: 'Python API URL not configured' };
  }

  try {
    // Convert to base64
    const base64 = Buffer.from(pdfData).toString('base64');

    const response = await fetch(PYTHON_VECTOR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdfData: base64,
        pageNum,
        scale,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return { success: false, error: errorData.error || 'Python API request failed' };
    }

    const data = await response.json();

    if (!data.success) {
      return { success: false, error: data.error || 'Unknown error' };
    }

    return {
      success: true,
      lines: data.lines,
      snapPoints: data.snapPoints,
      rawCount: data.rawPathCount,
      cleanedCount: data.cleanedPathCount,
      quality: data.quality,
    };
  } catch (error) {
    console.error('Python vector extraction failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// POST /api/takeoff/vectors - Extract vectors from a sheet
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();

    // Validate request body with Zod
    const validation = extractVectorsSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { sheetId } = validation.data;

    // Get sheet and verify ownership
    const [sheet] = await db
      .select({
        sheet: takeoffSheets,
        project: takeoffProjects,
        document: documents,
      })
      .from(takeoffSheets)
      .innerJoin(takeoffProjects, eq(takeoffSheets.projectId, takeoffProjects.id))
      .leftJoin(documents, eq(takeoffSheets.documentId, documents.id))
      .where(eq(takeoffSheets.id, sheetId))
      .limit(1);

    if (!sheet || sheet.project.userId !== session.user.id) {
      return NextResponse.json({ error: 'Sheet not found' }, { status: 404 });
    }

    // Find the PDF file and load data
    let pdfData: Uint8Array;
    const storagePath = sheet.document?.storagePath;

    if (storagePath) {
      // Document has storage path - could be local or Blob URL
      if (isBlobUrl(storagePath)) {
        // Download from Vercel Blob
        const buffer = await downloadFile(storagePath);
        pdfData = new Uint8Array(buffer);
      } else {
        // Local file
        let filePath = storagePath;
        if (!path.isAbsolute(filePath)) {
          filePath = path.join(process.cwd(), 'uploads', filePath);
        }
        if (!fs.existsSync(filePath)) {
          return NextResponse.json({ error: 'PDF file not found' }, { status: 404 });
        }
        pdfData = new Uint8Array(fs.readFileSync(filePath));
      }
    } else {
      // Check takeoff uploads directory (local only)
      const uploadsDir = path.join(process.cwd(), 'uploads', 'takeoff', sheet.project.id);
      if (!fs.existsSync(uploadsDir)) {
        return NextResponse.json({ error: 'PDF file not found' }, { status: 404 });
      }
      const files = fs.readdirSync(uploadsDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
      if (files.length === 0) {
        return NextResponse.json({ error: 'PDF file not found' }, { status: 404 });
      }
      const filePath = path.join(uploadsDir, files[0]);
      pdfData = new Uint8Array(fs.readFileSync(filePath));
    }
    const pageNum = sheet.sheet.pageNumber || 1;
    const renderScale = 1.5; // Match render API scale

    let lines: LineSegment[];
    let snapPoints: SnapPoint[];
    let rawCount: number;
    let cleanedCount: number;
    let quality: string;
    let extractionMethod = 'pdfjs';

    // Try Python (PyMuPDF) extraction first if configured
    const pythonResult = await extractVectorsWithPython(pdfData, pageNum, renderScale);

    if (pythonResult.success && pythonResult.lines && pythonResult.snapPoints) {
      // Use Python extraction results
      lines = pythonResult.lines;
      snapPoints = pythonResult.snapPoints;
      rawCount = pythonResult.rawCount || 0;
      cleanedCount = pythonResult.cleanedCount || 0;
      quality = pythonResult.quality || assessQuality(rawCount, cleanedCount);
      extractionMethod = 'pymupdf';
      console.log(`Vector extraction using PyMuPDF: ${snapPoints.length} snap points, ${lines.length} lines`);
    } else {
      // Fallback to unpdf extraction (serverless compatible)
      console.log(`Python extraction failed (${pythonResult.error}), falling back to unpdf`);

      const pdfDocument = await getDocumentProxy(pdfData);

      if (pageNum > pdfDocument.numPages) {
        return NextResponse.json({ error: 'Invalid page number' }, { status: 400 });
      }

      const page = await pdfDocument.getPage(pageNum);
      const pdfJsResult = await extractVectorsFromPage(page, renderScale);

      lines = pdfJsResult.lines;
      snapPoints = pdfJsResult.snapPoints;
      rawCount = pdfJsResult.rawCount;
      cleanedCount = pdfJsResult.cleanedCount;
      quality = assessQuality(rawCount, cleanedCount);
    }

    // Store vectors in database
    await db
      .insert(sheetVectors)
      .values({
        sheetId,
        snapPoints: snapPoints as unknown as null,
        lines: lines as unknown as null,
        extractedAt: new Date(),
        rawPathCount: rawCount,
        cleanedPathCount: cleanedCount,
      })
      .onConflictDoUpdate({
        target: sheetVectors.sheetId,
        set: {
          snapPoints: snapPoints as unknown as null,
          lines: lines as unknown as null,
          extractedAt: new Date(),
          rawPathCount: rawCount,
          cleanedPathCount: cleanedCount,
        },
      });

    // Update sheet status
    await db
      .update(takeoffSheets)
      .set({
        vectorsReady: true,
        vectorQuality: quality,
      })
      .where(eq(takeoffSheets.id, sheetId));

    return NextResponse.json({
      success: true,
      quality,
      extractionMethod,
      snapPointCount: snapPoints.length,
      lineCount: lines.length,
      rawPathCount: rawCount,
      cleanedPathCount: cleanedCount,
    });
  } catch (error) {
    console.error('Vector extraction error:', error);
    return NextResponse.json({ error: 'Failed to extract vectors' }, { status: 500 });
  }
}

// GET /api/takeoff/vectors?sheetId=xxx - Get vectors for a sheet
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const params = { sheetId: searchParams.get('sheetId') || undefined };

    // Validate query params with Zod
    const validation = getVectorsSchema.safeParse(params);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { sheetId } = validation.data;

    // Verify ownership and get vectors
    const [result] = await db
      .select({
        vectors: sheetVectors,
        sheet: takeoffSheets,
        project: takeoffProjects,
      })
      .from(sheetVectors)
      .innerJoin(takeoffSheets, eq(sheetVectors.sheetId, takeoffSheets.id))
      .innerJoin(takeoffProjects, eq(takeoffSheets.projectId, takeoffProjects.id))
      .where(eq(sheetVectors.sheetId, sheetId))
      .limit(1);

    if (!result) {
      // No vectors extracted yet - check if sheet exists
      const [sheet] = await db
        .select({
          sheet: takeoffSheets,
          project: takeoffProjects,
        })
        .from(takeoffSheets)
        .innerJoin(takeoffProjects, eq(takeoffSheets.projectId, takeoffProjects.id))
        .where(eq(takeoffSheets.id, sheetId))
        .limit(1);

      if (!sheet || sheet.project.userId !== session.user.id) {
        return NextResponse.json({ error: 'Sheet not found' }, { status: 404 });
      }

      return NextResponse.json({
        vectorsReady: false,
        snapPoints: [],
        lines: [],
      });
    }

    if (result.project.userId !== session.user.id) {
      return NextResponse.json({ error: 'Sheet not found' }, { status: 404 });
    }

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
  } catch (error) {
    console.error('Get vectors error:', error);
    return NextResponse.json({ error: 'Failed to get vectors' }, { status: 500 });
  }
}
