import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { getDocumentProxy } from 'unpdf';
import { downloadFile, isBlobUrl } from '@/lib/storage';
import { getAllThumbnailUrls } from '@/lib/thumbnail-generator';

interface PageInfo {
  width: number;
  height: number;
  rotation: number;
  label?: string;  // Original page label from PDF (e.g., "A1.1", "S-101")
  thumbnailUrl?: string;  // Direct Blob URL for thumbnail
}

// GET /api/documents/[id]/info - Get document metadata
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // Get document and verify ownership through bid
    const [doc] = await db
      .select({
        document: documents,
        bid: bids,
      })
      .from(documents)
      .innerJoin(bids, eq(documents.bidId, bids.id))
      .where(eq(documents.id, id))
      .limit(1);

    if (!doc || doc.bid.userId !== session.user.id) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Get page count and dimensions from PDF
    let pageCount = doc.document.pageCount || 1;
    const pages: PageInfo[] = [];
    const storagePath = doc.document.storagePath;

    if (storagePath) {
      try {
        let data: Uint8Array;

        if (isBlobUrl(storagePath)) {
          // Download from Vercel Blob
          const buffer = await downloadFile(storagePath);
          data = new Uint8Array(buffer);
        } else {
          // Read from local file system
          let resolvedPath = storagePath;
          if (!path.isAbsolute(resolvedPath)) {
            resolvedPath = path.join(process.cwd(), resolvedPath);
          }
          if (!fs.existsSync(resolvedPath)) {
            throw new Error(`File not found: ${resolvedPath}`);
          }
          data = new Uint8Array(fs.readFileSync(resolvedPath));
        }

        // Use unpdf which works in serverless environments
        const pdfDocument = await getDocumentProxy(data);
        pageCount = pdfDocument.numPages;

        // Try to get page labels (e.g., "A1.1", "S-101")
        let pageLabels: string[] | null = null;
        try {
          pageLabels = await pdfDocument.getPageLabels();
        } catch {
          // Page labels not available
        }

        // Get dimensions for each page
        for (let i = 1; i <= pageCount; i++) {
          const page = await pdfDocument.getPage(i);
          const viewport = page.getViewport({ scale: 1.0 });
          pages.push({
            width: viewport.width,
            height: viewport.height,
            rotation: viewport.rotation || 0,
            label: pageLabels?.[i - 1] || undefined,
          });
        }

        // Update page count in database if needed
        if (doc.document.pageCount !== pageCount) {
          await db
            .update(documents)
            .set({ pageCount })
            .where(eq(documents.id, id));
        }
      } catch (e) {
        console.error('Failed to get PDF info:', e);
        // Use defaults for page dimensions
        for (let i = 0; i < pageCount; i++) {
          pages.push({ width: 612, height: 792, rotation: 0 });
        }
      }
    } else {
      // No storage path - use defaults
      for (let i = 0; i < pageCount; i++) {
        pages.push({ width: 612, height: 792, rotation: 0 });
      }
    }

    // Get thumbnail URLs from Blob storage (direct CDN URLs)
    // If thumbnails aren't ready, this returns nulls and client should use the batch endpoint
    // to poll for when they're ready, or fall back to API endpoint
    const thumbnailUrls = await getAllThumbnailUrls(id, pageCount);
    const thumbnailsReady = thumbnailUrls.every(url => url !== null);

    return NextResponse.json({
      id: doc.document.id,
      filename: doc.document.filename,
      pageCount,
      pages, // Array of page dimensions
      thumbnailUrls, // Direct Blob CDN URLs (or null if not generated)
      thumbnailsReady,
      bidId: doc.bid.id,
      bidTitle: doc.bid.title,
      docType: doc.document.docType,
      downloadedAt: doc.document.downloadedAt,
    });
  } catch (error) {
    console.error('Document info error:', error);
    return NextResponse.json(
      { error: 'Failed to get document info' },
      { status: 500 }
    );
  }
}
