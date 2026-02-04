import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/db';
import { documents, bids } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { deleteFile, downloadFile } from '@/lib/storage';
import { getPdfMetadataFromBuffer } from '@/extraction/pdf-parser';
import { inngest } from '@/inngest/client';

interface BlobCompleteRequest {
  blobUrl: string;
  pathname: string;
  filename: string;
  bidId: string;
  folderName?: string;
  relativePath?: string;
}

// POST /api/upload/blob-complete - Process uploaded blob
export async function POST(request: NextRequest) {
  let uploadedBlobUrl: string | null = null;

  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: BlobCompleteRequest = await request.json();
    const { blobUrl, filename, bidId } = body;
    uploadedBlobUrl = blobUrl;

    if (!blobUrl || !filename) {
      return NextResponse.json(
        { error: 'Missing required fields: blobUrl, filename' },
        { status: 400 }
      );
    }

    if (!bidId) {
      return NextResponse.json(
        { error: 'bidId is required' },
        { status: 400 }
      );
    }

    // Validate ownership
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

    // Download PDF for metadata extraction only
    console.log('[blob-complete] Downloading PDF for metadata:', blobUrl);

    const pdfBuffer = await downloadFile(blobUrl);

    let pageCount = 0;

    try {
      const metadata = await getPdfMetadataFromBuffer(pdfBuffer);
      pageCount = metadata.pageCount;
    } catch (metadataError) {
      console.error('[blob-complete] Failed to get metadata via unpdf, trying pdf-lib:', metadataError);

      const pdfDoc = await PDFDocument.load(pdfBuffer);
      pageCount = pdfDoc.getPageCount();
    }

    console.log('[blob-complete] PDF metadata:', { pageCount });

    // Create document record
    const [doc] = await db
      .insert(documents)
      .values({
        bidId,
        filename,
        docType: 'plans',
        storagePath: blobUrl,
        pageCount,
        downloadedAt: new Date(),
        extractionStatus: 'not_started',
        textExtractionStatus: 'not_started',
      })
      .returning();

    // Fire background job for text extraction (non-blocking)
    try {
      await inngest.send({
        name: 'extraction/text-extract',
        data: {
          documentId: doc.id,
          blobUrl,
        },
      });
      console.log(`[blob-complete] Text extraction queued for document ${doc.id} (${pageCount} pages)`);
    } catch (inngestError) {
      console.warn('[blob-complete] Failed to queue text extraction (Inngest unavailable):', inngestError instanceof Error ? inngestError.message : inngestError);
      // Don't fail the upload — text extraction is secondary
    }

    return NextResponse.json({
      success: true,
      filename,
      pageCount,
      documentId: doc.id,
    });
  } catch (error) {
    console.error('[blob-complete] Error:', error);

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
