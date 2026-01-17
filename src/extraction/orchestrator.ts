/**
 * Extraction Orchestrator
 *
 * Coordinates document extraction using the plugin system.
 * Handles plugin selection, execution, and result persistence.
 */

import { db } from '@/db';
import { documents, lineItems, extractionJobs, type NewLineItem } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { extractPdfPageByPage, getPdfMetadata } from './pdf-parser';
import { pluginRegistry, type ExtractionContext, type ExtractionOptions, type PluginResult, type PreProcessResult } from './plugins';
import type { TradeCode } from '@/lib/trade-definitions';

// Ensure plugins are loaded
import './plugins';

export interface OrchestratorOptions extends ExtractionOptions {
  /** Trade codes to extract (runs relevant plugins for each) */
  trades: TradeCode[];
}

export interface OrchestratorResult {
  jobId: string;
  documentId: string;
  totalItemsExtracted: number;
  pluginResults: PluginResult[];
  totalTimeMs: number;
}

/**
 * Main extraction function - processes a document using the plugin system
 */
export async function extractDocument(
  documentId: string,
  userId: string,
  options: OrchestratorOptions
): Promise<OrchestratorResult> {
  const startTime = Date.now();

  // Get document
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
    // Update status
    await db
      .update(extractionJobs)
      .set({ status: 'processing', startedAt: new Date() })
      .where(eq(extractionJobs.id, job.id));

    await db
      .update(documents)
      .set({ extractionStatus: 'extracting' })
      .where(eq(documents.id, documentId));

    // Get PDF metadata and pages
    const metadata = await getPdfMetadata(doc.storagePath);
    const pages = await extractPdfPageByPage(doc.storagePath);

    await db
      .update(extractionJobs)
      .set({ totalPages: metadata.pageCount })
      .where(eq(extractionJobs.id, job.id));

    // Build extraction context
    const context: ExtractionContext = {
      documentId,
      userId,
      bidId: doc.bidId,
      storagePath: doc.storagePath,
      pages,
      options,
    };

    // Find and run relevant plugins for each trade
    const pluginResults: PluginResult[] = [];
    let totalItemsExtracted = 0;
    let processedPages = 0;

    for (const tradeCode of options.trades) {
      const plugins = pluginRegistry.getByTrade(tradeCode);

      if (plugins.length === 0) {
        console.log(`[Orchestrator] No plugins registered for trade: ${tradeCode}`);
        continue;
      }

      // Run plugins for this trade (sorted by priority)
      for (const plugin of plugins) {
        // Check if plugin is relevant for this document
        if (!plugin.isRelevant(pages)) {
          console.log(`[Orchestrator] Plugin ${plugin.id} not relevant for document`);
          continue;
        }

        console.log(`[Orchestrator] Running plugin: ${plugin.name}`);

        const pluginStartTime = Date.now();

        // Run pre-processing if available
        let preProcessResult = null;
        if (plugin.preProcess) {
          preProcessResult = await plugin.preProcess(context);
        }

        // Run extraction
        const extractionResult = await plugin.extract(context, preProcessResult ?? undefined);

        const pluginResult: PluginResult = {
          pluginId: plugin.id,
          tradeCode,
          preProcess: preProcessResult,
          extraction: extractionResult,
          totalTimeMs: Date.now() - pluginStartTime,
        };

        pluginResults.push(pluginResult);

        // Save extracted items to database
        if (extractionResult.items.length > 0) {
          const lineItemsToInsert: NewLineItem[] = extractionResult.items.map((item) => ({
            documentId,
            bidId: doc.bidId,
            userId,
            tradeCode,
            category: item.category,
            pdfFilePath: doc.storagePath,
            pageNumber: item.pageNumber,
            pageReference: item.pageReference || null,
            description: item.description,
            estimatedQty: item.estimatedQty,
            unit: item.unit,
            notes: item.notes,
            specifications: item.specifications,
            extractionConfidence: item.confidence,
            extractedAt: new Date(),
            extractionModel: 'claude-sonnet-4-20250514',
            rawExtractionJson: extractionResult.rawResponses
              ? { rawResponses: extractionResult.rawResponses }
              : null,
            reviewStatus: 'pending',
            pageX: item.pageX ?? null,
            pageY: item.pageY ?? null,
          }));

          await db.insert(lineItems).values(lineItemsToInsert);
          totalItemsExtracted += extractionResult.items.length;
        }

        processedPages += extractionResult.pagesProcessed;

        // Update progress
        await db
          .update(extractionJobs)
          .set({
            processedPages,
            itemsExtracted: totalItemsExtracted,
          })
          .where(eq(extractionJobs.id, job.id));
      }
    }

    const totalTimeMs = Date.now() - startTime;

    // Mark job complete
    await db
      .update(extractionJobs)
      .set({
        status: 'completed',
        completedAt: new Date(),
        processedPages,
        itemsExtracted: totalItemsExtracted,
        processingTimeMs: totalTimeMs,
      })
      .where(eq(extractionJobs.id, job.id));

    await db
      .update(documents)
      .set({
        extractionStatus: 'completed',
        lineItemCount: totalItemsExtracted,
      })
      .where(eq(documents.id, documentId));

    console.log(`[Orchestrator] Extraction complete: ${totalItemsExtracted} items in ${totalTimeMs}ms`);

    return {
      jobId: job.id,
      documentId,
      totalItemsExtracted,
      pluginResults,
      totalTimeMs,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await db
      .update(extractionJobs)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage,
      })
      .where(eq(extractionJobs.id, job.id));

    await db
      .update(documents)
      .set({ extractionStatus: 'failed' })
      .where(eq(documents.id, documentId));

    throw error;
  }
}

/**
 * Run only pre-processing (quick analysis without AI costs)
 */
export async function analyzeDocumentQuick(
  documentId: string,
  trades: TradeCode[]
): Promise<{
  relevantTrades: TradeCode[];
  pluginAnalysis: Array<{
    pluginId: string;
    tradeCode: TradeCode;
    isRelevant: boolean;
    preProcessResult?: PreProcessResult;
  }>;
}> {
  // Get document
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc?.storagePath) {
    throw new Error(`Document ${documentId} not found or has no storage path`);
  }

  // Get pages
  const pages = await extractPdfPageByPage(doc.storagePath);

  const context: ExtractionContext = {
    documentId,
    userId: '',
    bidId: doc.bidId,
    storagePath: doc.storagePath,
    pages,
    options: { skipAI: true },
  };

  const relevantTrades: TradeCode[] = [];
  const pluginAnalysis: Array<{
    pluginId: string;
    tradeCode: TradeCode;
    isRelevant: boolean;
    preProcessResult?: PreProcessResult;
  }> = [];

  for (const tradeCode of trades) {
    const plugins = pluginRegistry.getByTrade(tradeCode);

    for (const plugin of plugins) {
      const isRelevant = plugin.isRelevant(pages);

      let preProcessResult = undefined;
      if (isRelevant && plugin.preProcess) {
        preProcessResult = await plugin.preProcess(context);
      }

      pluginAnalysis.push({
        pluginId: plugin.id,
        tradeCode,
        isRelevant,
        preProcessResult,
      });

      if (isRelevant && !relevantTrades.includes(tradeCode)) {
        relevantTrades.push(tradeCode);
      }
    }
  }

  return { relevantTrades, pluginAnalysis };
}

/**
 * Re-extract a document (clears existing items first)
 */
export async function reExtractDocument(
  documentId: string,
  userId: string,
  options: OrchestratorOptions
): Promise<OrchestratorResult> {
  // Delete existing line items
  await db.delete(lineItems).where(eq(lineItems.documentId, documentId));

  // Reset document status
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

/**
 * Get extraction job progress
 */
export async function getExtractionProgress(jobId: string) {
  const [job] = await db
    .select()
    .from(extractionJobs)
    .where(eq(extractionJobs.id, jobId))
    .limit(1);

  if (!job) return null;

  return {
    jobId: job.id,
    documentId: job.documentId,
    status: job.status,
    totalPages: job.totalPages || 0,
    processedPages: job.processedPages || 0,
    itemsExtracted: job.itemsExtracted || 0,
  };
}
