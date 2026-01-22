import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffProjects, takeoffSheets, documents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { put } from '@vercel/blob';
import { inngest } from '@/inngest/client';

// POST /api/takeoff/upload - Upload PDF and create sheets
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const projectId = formData.get('projectId') as string | null;
    const folderName = formData.get('folderName') as string | null;
    const relativePath = formData.get('relativePath') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
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

    // Read file bytes
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Upload to Vercel Blob
    const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const blobPath = `takeoff/${projectId}/${filename}`;

    const blob = await put(blobPath, buffer, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: false,
    });

    // Parse PDF to get page count and dimensions using pdf-lib
    const pdfDoc = await PDFDocument.load(buffer);
    const pageCount = pdfDoc.getPageCount();

    // Get first page dimensions
    let defaultWidth = 3300; // 11" at 300dpi
    let defaultHeight = 2550; // 8.5" at 300dpi

    if (pageCount > 0) {
      const firstPage = pdfDoc.getPage(0);
      const { width, height } = firstPage.getSize();
      // Convert from PDF points (72 DPI) to pixels at 150 DPI for viewing
      const scaleFactor = 150 / 72;
      defaultWidth = Math.round(width * scaleFactor);
      defaultHeight = Math.round(height * scaleFactor);
    }

    // Create a document record for the PDF
    const [doc] = await db
      .insert(documents)
      .values({
        filename: file.name,
        storagePath: blob.url,
        pageCount,
      })
      .returning();

    // Generate sheet name prefix from file path
    const baseFileName = file.name.replace('.pdf', '').replace(/[_-]/g, ' ');
    let sheetPrefix = baseFileName;

    // If we have a folder structure, use it for organization
    if (relativePath) {
      const parts = relativePath.split('/');
      if (parts.length > 2) {
        // Format: "FolderName / FileName"
        const parentFolder = parts[parts.length - 2];
        sheetPrefix = `${parentFolder} / ${baseFileName}`;
      }
    } else if (folderName && folderName !== 'Drawings') {
      sheetPrefix = `${folderName} / ${baseFileName}`;
    }

    // Create a sheet for each page
    const sheets = [];
    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      // Cleaner naming: omit "Page 1" if single-page document
      const pageSuffix = pageCount === 1 ? '' : ` - Page ${pageNum}`;

      const [sheet] = await db
        .insert(takeoffSheets)
        .values({
          projectId,
          documentId: doc.id, // Link to document for PDF access
          pageNumber: pageNum,
          name: `${sheetPrefix}${pageSuffix}`,
          widthPx: defaultWidth,
          heightPx: defaultHeight,
          tilesReady: false,
          maxZoomGenerated: -1,
          // Use API tile endpoint - will generate tiles on-demand if not ready
          // Format includes {z}/{x}/{y} so viewer knows to use XYZ tiles
          tileUrlTemplate: null, // Set by Inngest job after tiles generated
        })
        .returning();

      sheets.push(sheet);

      // Trigger tile generation in background
      await inngest.send({
        name: 'sheet/generate-tiles',
        data: {
          sheetId: sheet.id,
          documentId: doc.id,
          pageNumber: pageNum,
        },
      });
    }

    return NextResponse.json({
      success: true,
      filename,
      pageCount,
      documentId: doc.id,
      sheets: sheets.map((s) => ({
        id: s.id,
        name: s.name,
        pageNumber: s.pageNumber,
        widthPx: s.widthPx,
        heightPx: s.heightPx,
      })),
    });
  } catch (error) {
    console.error('Upload error:', error);

    // Provide specific error messages based on the error type
    let message = 'Failed to process PDF';
    if (error instanceof Error) {
      if (error.message.includes('Invalid PDF')) {
        message = 'Invalid PDF file - the file may be corrupted or encrypted';
      } else if (error.message.includes('password')) {
        message = 'PDF is password-protected';
      } else if (error.message.includes('ENOSPC')) {
        message = 'Server storage is full';
      } else if (error.message.includes('EACCES')) {
        message = 'Server permission error';
      } else {
        // Include the actual error for debugging
        message = `Failed to process PDF: ${error.message}`;
      }
    }

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
