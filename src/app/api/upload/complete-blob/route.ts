import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffSheets, takeoffProjects, documents, bids } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { inngest } from '@/inngest/client';
import { downloadFile, deleteFile } from '@/lib/storage';
import { pythonApi } from '@/lib/python-api';

// Force Node.js runtime for PDF parsing
export const runtime = 'nodejs';
export const maxDuration = 60;

// Timeout for pdf-lib operations (55 seconds - leaves 5s for other ops within 60s function limit)
const PDF_PARSE_TIMEOUT_MS = 55000;

// Helper to add timeout to async operations
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

interface BlobCompleteRequest {
  blobUrl: string;
  pathname: string;
  filename: string;
  projectId?: string; // For takeoff flow
  bidId?: string; // For projects flow
  folderName?: string;
  relativePath?: string;
}

// POST /api/upload/blob-complete - Process uploaded blob
export async function POST(request: NextRequest) {
  // Track blobUrl at function scope for cleanup on failure
  let uploadedBlobUrl: string | null = null;

  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: BlobCompleteRequest = await request.json();
    const { blobUrl, pathname, filename, projectId, bidId, folderName, relativePath } = body;
    uploadedBlobUrl = blobUrl;

    if (!blobUrl || !filename) {
      return NextResponse.json(
        { error: 'Missing required fields: blobUrl, filename' },
        { status: 400 }
      );
    }

    if (!projectId && !bidId) {
      return NextResponse.json(
        { error: 'Either projectId or bidId is required' },
        { status: 400 }
      );
    }

    // Validate ownership
    if (projectId) {
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
    }

    if (bidId) {
      const [bid] = await db
        .select()
        .from(bids)
        .where(
          and(
            eq(bids.id, bidId),
            eq(bids.userId, session.user.id)
          )
        )
        .limit(1);

      if (!bid) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
    }

    // Get PDF metadata (page count, dimensions)
    // Use Python API if available (memory efficient), otherwise fallback to pdf-lib
    let pageCount: number;
    let defaultWidth = 3300; // 11" at 300dpi
    let defaultHeight = 2550; // 8.5" at 300dpi

    if (pythonApi.isConfigured()) {
      // Memory efficient: Python fetches PDF and extracts metadata
      console.log('[blob-complete] Getting PDF metadata via Python API:', blobUrl);
      const metadata = await pythonApi.metadata({ pdfUrl: blobUrl });

      if (!metadata.success) {
        throw new Error(`Failed to parse PDF: ${metadata.error}`);
      }

      pageCount = metadata.pageCount;

      // Convert from PDF points (72 DPI) to 300 DPI for better quality
      if (metadata.width > 0 && metadata.height > 0) {
        const scaleFactor = 300 / 72;
        defaultWidth = Math.round(metadata.width * scaleFactor);
        defaultHeight = Math.round(metadata.height * scaleFactor);
      }
    } else {
      // Fallback: Download PDF and parse with pdf-lib (uses more memory)
      // Wrap in timeout to prevent hanging on large/complex PDFs
      console.log('[blob-complete] Python API not configured, falling back to pdf-lib');

      const parsePdf = async () => {
        const buffer = await downloadFile(blobUrl);
        const pdfDoc = await PDFDocument.load(buffer);
        return pdfDoc;
      };

      const pdfDoc = await withTimeout(
        parsePdf(),
        PDF_PARSE_TIMEOUT_MS,
        'PDF parsing'
      );

      pageCount = pdfDoc.getPageCount();

      if (pageCount > 0) {
        const firstPage = pdfDoc.getPage(0);
        const { width, height } = firstPage.getSize();
        const scaleFactor = 300 / 72;
        defaultWidth = Math.round(width * scaleFactor);
        defaultHeight = Math.round(height * scaleFactor);
      }
    }

    console.log('[blob-complete] PDF metadata:', { pageCount, defaultWidth, defaultHeight });

    let documentId: string | null = null;
    const sheets: any[] = [];

    // If bidId is present, this is a projects flow upload - create documents record
    if (bidId) {
      const [doc] = await db
        .insert(documents)
        .values({
          bidId,
          filename,
          docType: 'plans',
          storagePath: blobUrl,
          pageCount,
          downloadedAt: new Date(),
          extractionStatus: 'queued',
        })
        .returning();

      documentId = doc.id;

      // Trigger extraction and thumbnail generation via Inngest
      try {
        await inngest.send({
          name: 'extraction/signage',
          data: {
            documentId: doc.id,
            bidId,
            userId: session.user.id,
          },
        });

        await inngest.send({
          name: 'document/generate-thumbnails',
          data: {
            documentId: doc.id,
          },
        });

        await inngest.send({
          name: 'document/extract-text',
          data: {
            documentId: doc.id,
          },
        });

        console.log(`[blob-complete] Queued Inngest jobs for document ${doc.id}`);
      } catch (inngestError) {
        console.error('[blob-complete] Failed to queue Inngest jobs:', inngestError);
      }
    }

    // If projectId is present, this is a takeoff flow upload - create sheets
    if (projectId) {
      // Generate sheet name prefix from filename and folder info
      const baseFileName = filename.replace('.pdf', '').replace(/[_-]/g, ' ');
      let sheetPrefix = baseFileName;

      if (relativePath) {
        const parts = relativePath.split('/');
        if (parts.length > 2) {
          const parentFolder = parts[parts.length - 2];
          sheetPrefix = `${parentFolder} / ${baseFileName}`;
        }
      } else if (folderName && folderName !== 'Drawings') {
        sheetPrefix = `${folderName} / ${baseFileName}`;
      }

      // Extract just the filename part from pathname for the URL
      const urlFilename = pathname.split('/').pop() || filename;

      // Create a sheet for each page
      for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
        const pageSuffix = pageCount === 1 ? '' : ` - Page ${pageNum}`;

        const [sheet] = await db
          .insert(takeoffSheets)
          .values({
            projectId,
            pageNumber: pageNum,
            name: `${sheetPrefix}${pageSuffix}`,
            widthPx: defaultWidth,
            heightPx: defaultHeight,
            tilesReady: false,
            tileUrlTemplate: `/api/takeoff/render?projectId=${projectId}&file=${encodeURIComponent(urlFilename)}&page=${pageNum}`,
          })
          .returning();

        sheets.push(sheet);
      }
    }

    return NextResponse.json({
      success: true,
      filename,
      pageCount,
      documentId,
      sheets: sheets.map((s) => s.id),
    });
  } catch (error) {
    console.error('[blob-complete] Error:', error);

    // Clean up the uploaded blob on failure to avoid orphaned files
    if (uploadedBlobUrl) {
      try {
        console.log('[blob-complete] Cleaning up blob after failure:', uploadedBlobUrl);
        await deleteFile(uploadedBlobUrl);
      } catch (cleanupError) {
        console.error('[blob-complete] Failed to clean up blob:', cleanupError);
      }
    }

    let message = 'Failed to process PDF';
    if (error instanceof Error) {
      if (error.message.includes('Invalid PDF')) {
        message = 'Invalid PDF file - the file may be corrupted or encrypted';
      } else if (error.message.includes('password')) {
        message = 'PDF is password-protected';
      } else {
        message = `Failed to process PDF: ${error.message}`;
      }
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
