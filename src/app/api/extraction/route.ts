import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { inngest } from '@/inngest/client';
import { db } from '@/db';
import { documents, extractionJobs } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';
import { TradeCode } from '@/lib/trade-definitions';

// POST /api/extraction - Start extraction for a document
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { documentId, bidId, trades } = body;

    // Validate trades if provided
    const validTrades: TradeCode[] = trades?.filter(
      (t: string) => t === 'division_08' || t === 'division_10'
    ) || ['division_08', 'division_10'];

    if (documentId) {
      // Extract single document
      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);

      if (!doc) {
        return NextResponse.json({ error: 'Document not found' }, { status: 404 });
      }

      if (!doc.storagePath) {
        return NextResponse.json(
          { error: 'Document has not been downloaded yet' },
          { status: 400 }
        );
      }

      // Send extraction event
      await inngest.send({
        name: 'extraction/document',
        data: {
          documentId,
          userId: session.user.id,
          trades: validTrades,
        },
      });

      return NextResponse.json({
        success: true,
        message: 'Extraction queued',
        documentId,
      });

    } else if (bidId) {
      // Extract all documents for a bid
      await inngest.send({
        name: 'extraction/bid',
        data: {
          bidId,
          userId: session.user.id,
          trades: validTrades,
        },
      });

      return NextResponse.json({
        success: true,
        message: 'Bid extraction queued',
        bidId,
      });

    } else {
      return NextResponse.json(
        { error: 'Either documentId or bidId is required' },
        { status: 400 }
      );
    }
  } catch (error) {
    console.error('Extraction API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET /api/extraction?documentId=xxx or ?jobId=xxx - Get extraction status
export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const documentId = searchParams.get('documentId');
    const jobId = searchParams.get('jobId');

    if (jobId) {
      // Get specific job status
      const [job] = await db
        .select()
        .from(extractionJobs)
        .where(eq(extractionJobs.id, jobId))
        .limit(1);

      if (!job) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 });
      }

      return NextResponse.json({
        job: {
          id: job.id,
          documentId: job.documentId,
          status: job.status,
          totalPages: job.totalPages,
          processedPages: job.processedPages,
          itemsExtracted: job.itemsExtracted,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          errorMessage: job.errorMessage,
          processingTimeMs: job.processingTimeMs,
        },
      });
    }

    if (documentId) {
      // Get latest job for document
      const [job] = await db
        .select()
        .from(extractionJobs)
        .where(eq(extractionJobs.documentId, documentId))
        .orderBy(desc(extractionJobs.createdAt))
        .limit(1);

      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);

      return NextResponse.json({
        document: doc ? {
          id: doc.id,
          extractionStatus: doc.extractionStatus,
          lineItemCount: doc.lineItemCount,
        } : null,
        latestJob: job ? {
          id: job.id,
          status: job.status,
          totalPages: job.totalPages,
          processedPages: job.processedPages,
          itemsExtracted: job.itemsExtracted,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
        } : null,
      });
    }

    return NextResponse.json(
      { error: 'Either documentId or jobId query parameter is required' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Extraction status API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
