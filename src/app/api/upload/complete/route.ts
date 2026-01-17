import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { uploadSessions, takeoffSheets, takeoffProjects, documents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { createWriteStream, createReadStream } from 'fs';
import { readdir, rm, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { PDFParse } from 'pdf-parse';
import { inngest } from '@/inngest';

// POST /api/upload/complete - Assemble chunks and process the PDF
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { uploadId } = await request.json();

    if (!uploadId) {
      return NextResponse.json({ error: 'Missing uploadId' }, { status: 400 });
    }

    // Get upload session
    const [uploadSession] = await db
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.id, uploadId),
          eq(uploadSessions.userId, session.user.id)
        )
      )
      .limit(1);

    if (!uploadSession) {
      return NextResponse.json({ error: 'Upload session not found' }, { status: 404 });
    }

    // Verify all chunks received
    // Note: Due to chunk size changes, count actual files instead of relying on DB count
    const actualChunkFiles = await readdir(uploadSession.tempDir);
    const actualChunkCount = actualChunkFiles.filter((f) => f.startsWith('chunk-')).length;

    console.log('[complete] Upload session:', {
      uploadId,
      receivedChunks: uploadSession.receivedChunks,
      totalChunks: uploadSession.totalChunks,
      actualChunkCount,
      chunkSize: uploadSession.chunkSize,
      fileSize: uploadSession.fileSize,
    });

    if (actualChunkCount === 0) {
      return NextResponse.json(
        {
          error: 'Upload incomplete - no chunks found',
          received: actualChunkCount,
          expected: uploadSession.totalChunks,
        },
        { status: 400 }
      );
    }

    // Check if already completed
    if (uploadSession.status === 'completed') {
      return NextResponse.json({ error: 'Upload already completed' }, { status: 400 });
    }

    try {
      // Update status to assembling
      await db
        .update(uploadSessions)
        .set({ status: 'assembling', updatedAt: new Date() })
        .where(eq(uploadSessions.id, uploadId));

      // Get sorted chunk files
      const chunkFiles = await readdir(uploadSession.tempDir);
      const sortedChunks = chunkFiles.filter((f) => f.startsWith('chunk-')).sort();

      if (sortedChunks.length === 0) {
        throw new Error('No chunks found in temp directory');
      }

      // Ensure project or bid exists
      if (!uploadSession.projectId && !uploadSession.bidId) {
        throw new Error('No project or bid associated with upload');
      }

      // Create final directory - use bidId for projects flow, projectId for takeoff flow
      const storageId = uploadSession.projectId || uploadSession.bidId;
      const finalDir = join(process.cwd(), 'uploads', uploadSession.projectId ? 'takeoff' : 'projects', storageId!);
      await mkdir(finalDir, { recursive: true });

      // Generate unique filename
      const sanitizedFilename = uploadSession.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
      const filename = `${Date.now()}-${sanitizedFilename}`;
      const finalPath = join(finalDir, filename);

      // Assemble chunks into final file using streaming
      const writeStream = createWriteStream(finalPath);

      for (const chunkFile of sortedChunks) {
        const chunkPath = join(uploadSession.tempDir, chunkFile);
        const readStream = createReadStream(chunkPath);
        await pipeline(readStream, writeStream, { end: false });
      }

      writeStream.end();

      // Wait for write to complete
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      // Parse PDF to get page count and dimensions
      const buffer = await readFile(finalPath);
      const pdfData = new Uint8Array(buffer);
      const parser = new PDFParse({ data: pdfData });

      const info = await parser.getInfo({ parsePageInfo: true, first: 1, last: 1 });
      const pageCount = info.total || 0;

      // Get first page dimensions
      let defaultWidth = 3300; // 11" at 300dpi
      let defaultHeight = 2550; // 8.5" at 300dpi

      if (info.pages && info.pages.length > 0) {
        const firstPage = info.pages[0];
        // Convert from PDF points (72 DPI) to 300 DPI for better quality
        const scaleFactor = 300 / 72;
        defaultWidth = Math.round(firstPage.width * scaleFactor);
        defaultHeight = Math.round(firstPage.height * scaleFactor);
      }

      await parser.destroy();

      let documentId: string | null = null;
      const sheets: any[] = [];

      // If bidId is present, this is a projects flow upload - create documents record
      if (uploadSession.bidId) {
        const [doc] = await db
          .insert(documents)
          .values({
            bidId: uploadSession.bidId,
            filename: uploadSession.filename,
            docType: 'plans',
            storagePath: finalPath,
            pageCount,
            downloadedAt: new Date(),
            extractionStatus: 'queued',
          })
          .returning();

        documentId = doc.id;

        // Trigger extraction and thumbnail generation via Inngest
        try {
          // Queue extraction
          await inngest.send({
            name: 'extraction/signage',
            data: {
              documentId: doc.id,
              bidId: uploadSession.bidId,
              userId: session.user.id,
            },
          });

          // Queue thumbnail generation (runs in parallel)
          await inngest.send({
            name: 'document/generate-thumbnails',
            data: {
              documentId: doc.id,
            },
          });

          // Queue text extraction for search
          await inngest.send({
            name: 'document/extract-text',
            data: {
              documentId: doc.id,
            },
          });

          console.log(`[complete] Queued extraction, thumbnails, and text extraction for document ${doc.id}`);
        } catch (inngestError) {
          console.error('[complete] Failed to queue Inngest jobs:', inngestError);
          // Don't fail the upload, just log the error
        }
      }

      // If projectId is present, this is a takeoff flow upload - create sheets
      if (uploadSession.projectId) {
        // Generate sheet name prefix from filename and folder info
        const baseFileName = uploadSession.filename.replace('.pdf', '').replace(/[_-]/g, ' ');
        let sheetPrefix = baseFileName;

        if (uploadSession.relativePath) {
          const parts = uploadSession.relativePath.split('/');
          if (parts.length > 2) {
            const parentFolder = parts[parts.length - 2];
            sheetPrefix = `${parentFolder} / ${baseFileName}`;
          }
        } else if (uploadSession.folderName && uploadSession.folderName !== 'Drawings') {
          sheetPrefix = `${uploadSession.folderName} / ${baseFileName}`;
        }

        // Create a sheet for each page
        for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
          const pageSuffix = pageCount === 1 ? '' : ` - Page ${pageNum}`;

          const [sheet] = await db
            .insert(takeoffSheets)
            .values({
              projectId: uploadSession.projectId,
              pageNumber: pageNum,
              name: `${sheetPrefix}${pageSuffix}`,
              widthPx: defaultWidth,
              heightPx: defaultHeight,
              tilesReady: false,
              tileUrlTemplate: `/api/takeoff/render?projectId=${uploadSession.projectId}&file=${encodeURIComponent(filename)}&page=${pageNum}`,
            })
            .returning();

          sheets.push(sheet);
        }
      }

      // Update session as completed
      await db
        .update(uploadSessions)
        .set({
          status: 'completed',
          finalPath,
          updatedAt: new Date(),
        })
        .where(eq(uploadSessions.id, uploadId));

      // Cleanup temp directory
      await rm(uploadSession.tempDir, { recursive: true, force: true });

      return NextResponse.json({
        success: true,
        filename,
        pageCount,
        documentId, // For projects flow
        sheets: sheets.map((s) => s.id), // For takeoff flow
      });
    } catch (error) {
      console.error('Assembly error:', error);

      // Update session as failed
      await db
        .update(uploadSessions)
        .set({
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
          updatedAt: new Date(),
        })
        .where(eq(uploadSessions.id, uploadId));

      // Provide specific error messages
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
  } catch (error) {
    console.error('Complete upload error:', error);
    return NextResponse.json(
      { error: 'Failed to complete upload' },
      { status: 500 }
    );
  }
}
