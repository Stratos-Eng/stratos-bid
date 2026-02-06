import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getDocumentProxy } from 'unpdf';
import { downloadFile, isBlobUrl } from '@/lib/storage';
import path from 'path';
import fs from 'fs';

interface PageInfo {
  width: number;
  height: number;
  rotation: number;
  label?: string;
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

    const light = request.nextUrl.searchParams.get('light') === '1';

    // Get page count and dimensions from PDF
    // NOTE: For very large folders, we must avoid downloading/parsing PDFs unless explicitly requested.
    let pageCount = doc.document.pageCount || 1;
    const pages: PageInfo[] = [];
    const storagePath = doc.document.storagePath;

    if (light) {
      // Lightweight response: do not download/parse PDF
      return NextResponse.json({
        id: doc.document.id,
        filename: doc.document.filename,
        pageCount,
        pages: [],
        pdfUrl: `/api/documents/${id}/view`,
        bidId: doc.bid.id,
        bidTitle: doc.bid.title,
        docType: doc.document.docType,
        downloadedAt: doc.document.downloadedAt,
      });
    }

    if (storagePath) {
      try {
        // Download and parse with unpdf
        let data: Uint8Array;

        if (isBlobUrl(storagePath)) {
          const buffer = await downloadFile(storagePath);
          data = new Uint8Array(buffer);
        } else {
          let resolvedPath = storagePath;
          if (!path.isAbsolute(resolvedPath)) {
            resolvedPath = path.join(process.cwd(), resolvedPath);
          }
          if (!fs.existsSync(resolvedPath)) {
            throw new Error(`File not found: ${resolvedPath}`);
          }
          data = new Uint8Array(fs.readFileSync(resolvedPath));
        }

        const pdfDocument = await getDocumentProxy(data);
        pageCount = pdfDocument.numPages;

        let pageLabels: string[] | null = null;
        try {
          pageLabels = await pdfDocument.getPageLabels();
        } catch {
          // ignore
        }

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

        if (doc.document.pageCount !== pageCount) {
          await db.update(documents).set({ pageCount }).where(eq(documents.id, id));
        }
      } catch (e) {
        console.error('Failed to get PDF info:', e);
        for (let i = 0; i < pageCount; i++) {
          pages.push({ width: 612, height: 792, rotation: 0 });
        }
      }
    } else {
      for (let i = 0; i < pageCount; i++) {
        pages.push({ width: 612, height: 792, rotation: 0 });
      }
    }

    return NextResponse.json({
      id: doc.document.id,
      filename: doc.document.filename,
      pageCount,
      pages,
      pdfUrl: `/api/documents/${id}/view`, // Proxy through authenticated API route
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
