import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffProjects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { renderPageSchema, formatZodError } from '@/lib/validations/takeoff';
import { pythonApi } from '@/lib/python-api';

// Try rendering using Python (PyMuPDF) via centralized API client
async function renderWithPython(
  pdfData: Uint8Array,
  pageNum: number,
  scale: number = 1.5
): Promise<{
  success: boolean;
  imageBuffer?: Buffer;
  width?: number;
  height?: number;
  error?: string;
}> {
  if (!pythonApi.isConfigured()) {
    return { success: false, error: 'Python API URL not configured' };
  }

  try {
    // Convert to base64
    const base64 = Buffer.from(pdfData).toString('base64');

    const result = await pythonApi.render({
      pdfData: base64,
      pageNum,
      scale,
      returnBase64: true,
    });

    if (!result.success || !result.image) {
      return { success: false, error: result.error || 'Unknown error' };
    }

    // Decode base64 image
    const imageBuffer = Buffer.from(result.image, 'base64');

    return {
      success: true,
      imageBuffer,
      width: result.width,
      height: result.height,
    };
  } catch (error) {
    console.error('Python render failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// Fallback to local canvas rendering (works in development, not on Vercel)
async function renderWithCanvas(
  filePath: string,
  pageNum: number,
  scale: number = 1.5
): Promise<{
  success: boolean;
  imageBuffer?: Buffer;
  width?: number;
  height?: number;
  error?: string;
}> {
  try {
    // Try to import canvas - this will fail on Vercel
    let createCanvas: typeof import('canvas').createCanvas;
    try {
      const canvas = await import('canvas');
      createCanvas = canvas.createCanvas;
    } catch {
      return { success: false, error: 'Canvas not available in this environment' };
    }

    // Dynamic import for pdfjs (use unpdf for serverless compatibility)
    const { getDocumentProxy } = await import('unpdf');

    // Load the PDF document
    const data = new Uint8Array(fs.readFileSync(filePath));
    const pdfDocument = await getDocumentProxy(data);

    // Check page number
    if (pageNum < 1 || pageNum > pdfDocument.numPages) {
      return { success: false, error: `Invalid page number. Document has ${pdfDocument.numPages} pages.` };
    }

    // Get the page
    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    // Create canvas using node-canvas
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');

    // Render the page to the canvas
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderContext: any = {
      canvasContext: context,
      viewport,
    };

    await page.render(renderContext).promise;

    // Convert canvas to PNG buffer
    const pngBuffer = canvas.toBuffer('image/png');

    return {
      success: true,
      imageBuffer: pngBuffer,
      width: viewport.width,
      height: viewport.height,
    };
  } catch (error) {
    console.error('Canvas render failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// GET /api/takeoff/render - Render a PDF page as an image
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const params = {
      projectId: searchParams.get('projectId') || undefined,
      page: parseInt(searchParams.get('page') || '1', 10),
      scale: parseFloat(searchParams.get('scale') || '1.5'),
    };
    const filename = searchParams.get('file');

    // Validate query params with Zod
    const validation = renderPageSchema.safeParse(params);
    if (!validation.success) {
      return NextResponse.json(
        { error: formatZodError(validation.error) },
        { status: 400 }
      );
    }

    const { projectId, page: pageNum, scale } = validation.data;

    if (!filename) {
      return NextResponse.json(
        { error: 'file parameter is required' },
        { status: 400 }
      );
    }

    // Verify project ownership
    const [project] = await db
      .select()
      .from(takeoffProjects)
      .where(
        and(
          eq(takeoffProjects.id, projectId),
          eq(takeoffProjects.userId, session.user.id)
        )
      )
      .limit(1);

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Construct file path and verify it exists
    // NOTE: This route uses local file storage which is deprecated.
    // Takeoff projects should be migrated to use Vercel Blob storage.
    const uploadsDir = path.join(process.cwd(), 'uploads', 'takeoff', projectId);
    const filePath = path.join(uploadsDir, filename);

    // Security check - ensure path is within uploads directory
    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith(path.normalize(uploadsDir))) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
    }

    if (!fs.existsSync(filePath)) {
      // In production, local files don't exist - this is expected
      if (process.env.NODE_ENV === 'production') {
        console.warn(`[DEPRECATED] Takeoff render attempted for local file: ${filename}. Local storage is not available in production.`);
      }
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Warn about local file usage in production
    if (process.env.NODE_ENV === 'production') {
      console.warn(`[DEPRECATED] Using local file storage for takeoff render. Migrate to Blob storage.`);
    }

    // Load PDF data
    const pdfData = new Uint8Array(fs.readFileSync(filePath));

    // Try Python rendering first (works on Vercel)
    const pythonResult = await renderWithPython(pdfData, pageNum, scale);

    if (pythonResult.success && pythonResult.imageBuffer) {
      return new NextResponse(new Uint8Array(pythonResult.imageBuffer), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400', // Cache for 1 day
          'X-Render-Method': 'pymupdf',
        },
      });
    }

    // Fallback to local canvas rendering (development only)
    console.log(`Python render failed (${pythonResult.error}), trying local canvas...`);
    const canvasResult = await renderWithCanvas(filePath, pageNum, scale);

    if (canvasResult.success && canvasResult.imageBuffer) {
      return new NextResponse(new Uint8Array(canvasResult.imageBuffer), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
          'X-Render-Method': 'canvas',
        },
      });
    }

    // Both methods failed
    return NextResponse.json(
      {
        error: 'Failed to render PDF page',
        pythonError: pythonResult.error,
        canvasError: canvasResult.error,
      },
      { status: 500 }
    );
  } catch (error) {
    console.error('PDF render error:', error);
    return NextResponse.json(
      { error: 'Failed to render PDF page' },
      { status: 500 }
    );
  }
}
