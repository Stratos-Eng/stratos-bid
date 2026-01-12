import { db } from '@/db';
import { documents, lineItems, extractionJobs, type NewLineItem } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { extractPdfPageByPage, getPdfMetadata } from './pdf-parser';
import { analyzePageText, analyzePageHybrid, type ExtractionResult } from './claude-analyzer';
import { TradeCode, TRADE_DEFINITIONS } from '@/lib/trade-definitions';
import * as fs from 'fs';
import * as path from 'path';

export interface ExtractionOptions {
  trades: TradeCode[];
  useVision?: boolean;
  concurrency?: number;
}

export interface ExtractionProgress {
  jobId: string;
  documentId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  totalPages: number;
  processedPages: number;
  itemsExtracted: number;
  currentPage?: number;
}

/**
 * Main extraction orchestrator - processes a document and extracts line items
 */
export async function extractDocument(
  documentId: string,
  userId: string,
  options: ExtractionOptions
): Promise<{ jobId: string; itemsExtracted: number }> {
  // Get document details
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc) {
    throw new Error(`Document ${documentId} not found`);
  }

  if (!doc.storagePath) {
    throw new Error(`Document ${documentId} has no storage path`);
  }

  // Create extraction job
  const [job] = await db
    .insert(extractionJobs)
    .values({
      documentId,
      userId,
      status: 'pending',
      tradeFilter: options.trades,
    })
    .returning();

  try {
    // Update status to processing
    await db
      .update(extractionJobs)
      .set({ status: 'processing', startedAt: new Date() })
      .where(eq(extractionJobs.id, job.id));

    // Update document status
    await db
      .update(documents)
      .set({ extractionStatus: 'extracting' })
      .where(eq(documents.id, documentId));

    const startTime = Date.now();

    // Get PDF metadata
    const pdfPath = doc.storagePath;
    const metadata = await getPdfMetadata(pdfPath);

    // Update job with total pages
    await db
      .update(extractionJobs)
      .set({ totalPages: metadata.pageCount })
      .where(eq(extractionJobs.id, job.id));

    // Extract text from all pages
    const pages = await extractPdfPageByPage(pdfPath);

    let totalItemsExtracted = 0;
    let processedPageCount = 0;

    // Process pages for each trade
    for (const tradeCode of options.trades) {
      const trade = TRADE_DEFINITIONS[tradeCode];

      // First, find potentially relevant pages using keywords
      const relevantPages = pages.filter(page => {
        const textLower = page.text.toLowerCase();
        return trade.keywords.some(keyword =>
          textLower.includes(keyword.toLowerCase())
        );
      });

      console.log(`Found ${relevantPages.length} potentially relevant pages for ${trade.name}`);

      // Process relevant pages
      for (const page of relevantPages) {
        try {
          let result: ExtractionResult;

          if (options.useVision) {
            // For hybrid mode, we'd need to render PDF page to image
            // For now, fall back to text-only
            result = await analyzePageText(page.text, page.pageNumber, tradeCode);
          } else {
            result = await analyzePageText(page.text, page.pageNumber, tradeCode);
          }

          // Save extracted items
          if (result.items.length > 0) {
            const lineItemsToInsert: NewLineItem[] = result.items.map(item => ({
              documentId,
              bidId: doc.bidId,
              userId,
              tradeCode,
              category: item.category,
              pdfFilePath: pdfPath,
              pageNumber: result.pageNumber,
              pageReference: item.pageReference || null,
              description: item.description,
              estimatedQty: item.estimatedQty,
              unit: item.unit,
              notes: item.notes,
              specifications: item.specifications,
              extractionConfidence: item.confidence,
              extractedAt: new Date(),
              extractionModel: 'claude-sonnet-4-20250514',
              rawExtractionJson: { rawResponse: result.rawResponse },
              reviewStatus: 'pending',
            }));

            await db.insert(lineItems).values(lineItemsToInsert);
            totalItemsExtracted += result.items.length;
          }

          processedPageCount++;

          // Update progress
          await db
            .update(extractionJobs)
            .set({
              processedPages: processedPageCount,
              itemsExtracted: totalItemsExtracted,
            })
            .where(eq(extractionJobs.id, job.id));

        } catch (error) {
          console.error(`Error processing page ${page.pageNumber}:`, error);
          // Continue with next page
        }
      }
    }

    const processingTime = Date.now() - startTime;

    // Mark job as completed
    await db
      .update(extractionJobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        processedPages: processedPageCount,
        itemsExtracted: totalItemsExtracted,
        processingTimeMs: processingTime,
      })
      .where(eq(extractionJobs.id, job.id));

    // Update document status
    await db
      .update(documents)
      .set({
        extractionStatus: 'completed',
        lineItemCount: totalItemsExtracted,
      })
      .where(eq(documents.id, documentId));

    return {
      jobId: job.id,
      itemsExtracted: totalItemsExtracted,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Mark job as failed
    await db
      .update(extractionJobs)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage,
      })
      .where(eq(extractionJobs.id, job.id));

    // Update document status
    await db
      .update(documents)
      .set({ extractionStatus: 'failed' })
      .where(eq(documents.id, documentId));

    throw error;
  }
}

/**
 * Get extraction job progress
 */
export async function getExtractionProgress(jobId: string): Promise<ExtractionProgress | null> {
  const [job] = await db
    .select()
    .from(extractionJobs)
    .where(eq(extractionJobs.id, jobId))
    .limit(1);

  if (!job) return null;

  return {
    jobId: job.id,
    documentId: job.documentId,
    status: job.status as ExtractionProgress['status'],
    totalPages: job.totalPages || 0,
    processedPages: job.processedPages || 0,
    itemsExtracted: job.itemsExtracted || 0,
  };
}

/**
 * Extract from multiple documents (for batch processing)
 */
export async function extractDocuments(
  documentIds: string[],
  userId: string,
  options: ExtractionOptions
): Promise<{ results: Array<{ documentId: string; jobId: string; itemsExtracted: number }> }> {
  const results = [];

  for (const documentId of documentIds) {
    try {
      const result = await extractDocument(documentId, userId, options);
      results.push({ documentId, ...result });
    } catch (error) {
      console.error(`Failed to extract document ${documentId}:`, error);
      results.push({ documentId, jobId: '', itemsExtracted: 0 });
    }
  }

  return { results };
}

/**
 * Re-extract a document (clears existing items first)
 */
export async function reExtractDocument(
  documentId: string,
  userId: string,
  options: ExtractionOptions
): Promise<{ jobId: string; itemsExtracted: number }> {
  // Delete existing line items for this document
  await db
    .delete(lineItems)
    .where(eq(lineItems.documentId, documentId));

  // Reset document extraction status
  await db
    .update(documents)
    .set({
      extractionStatus: 'not_started',
      lineItemCount: 0,
    })
    .where(eq(documents.id, documentId));

  // Run extraction
  return extractDocument(documentId, userId, options);
}
