import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { takeoffProjects, takeoffSheets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
// Use pdf-parse for Node.js server-side PDF processing (avoids worker issues)
import { PDFParse } from 'pdf-parse';

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

    // Create uploads directory
    const uploadsDir = path.join(process.cwd(), 'uploads', 'takeoff', projectId);
    if (!existsSync(uploadsDir)) {
      await mkdir(uploadsDir, { recursive: true });
    }

    // Save the file
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const filePath = path.join(uploadsDir, filename);
    await writeFile(filePath, buffer);

    // Parse PDF to get page count and dimensions using pdf-parse
    const data = new Uint8Array(buffer);
    const parser = new PDFParse({ data });

    // getInfo() loads the document and returns metadata including page dimensions
    const info = await parser.getInfo({ parsePageInfo: true, first: 1, last: 1 });

    const pageCount = info.total || 0;

    // Get first page dimensions from page info
    let defaultWidth = 3300; // 11" at 300dpi
    let defaultHeight = 2550; // 8.5" at 300dpi

    if (info.pages && info.pages.length > 0) {
      const firstPage = info.pages[0];
      // Convert from PDF points (72 DPI) to 300 DPI for better quality
      const scaleFactor = 300 / 72;
      defaultWidth = Math.round(firstPage.width * scaleFactor);
      defaultHeight = Math.round(firstPage.height * scaleFactor);
    }

    // Clean up parser resources
    await parser.destroy();

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
          pageNumber: pageNum,
          name: `${sheetPrefix}${pageSuffix}`,
          widthPx: defaultWidth,
          heightPx: defaultHeight,
          tilesReady: false,
          // Store the PDF path so we can render pages on demand
          tileUrlTemplate: `/api/takeoff/render?projectId=${projectId}&file=${encodeURIComponent(filename)}&page=${pageNum}`,
        })
        .returning();

      sheets.push(sheet);
    }

    return NextResponse.json({
      success: true,
      filename,
      pageCount,
      sheets: sheets.map((s) => s.id),
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
