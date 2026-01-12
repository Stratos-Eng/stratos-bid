import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
// Use legacy build for Node.js environment
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

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

    // Get page count
    let pageCount = doc.document.pageCount;

    // If we don't have page count cached, get it from the PDF
    if (!pageCount && doc.document.storagePath) {
      const filePath = doc.document.storagePath;
      let resolvedPath = filePath;
      if (!path.isAbsolute(filePath)) {
        resolvedPath = path.join(process.cwd(), 'uploads', filePath);
      }

      if (fs.existsSync(resolvedPath)) {
        try {
          const data = new Uint8Array(fs.readFileSync(resolvedPath));
          const loadingTask = pdfjsLib.getDocument({ data });
          const pdfDocument = await loadingTask.promise;
          pageCount = pdfDocument.numPages;

          // Update cache in database
          await db
            .update(documents)
            .set({ pageCount })
            .where(eq(documents.id, id));
        } catch (e) {
          console.error('Failed to get PDF page count:', e);
          pageCount = 1; // Default to 1
        }
      }
    }

    return NextResponse.json({
      id: doc.document.id,
      filename: doc.document.filename,
      pageCount: pageCount || 1,
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
