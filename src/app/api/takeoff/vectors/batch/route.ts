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

// Extract vectors for a single sheet
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
