/**
 * Signage-specific extraction utilities
 *
 * This module provides the specialized signage extraction through the plugin system.
 * The two-pass extraction process:
 * 1. Legend Detection - find sign legend pages, extract symbol definitions
 * 2. Room Counting - count room types for quantity estimation
 * 3. AI Extraction - analyze relevant pages with legend context
 */

import { db } from '@/db';
import { documents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { extractPdfPageByPage } from '../pdf-parser';
import { pluginRegistry } from '../plugins/registry';
import type { ExtractionContext } from '../plugins/types';

// Re-export plugin (registers on import)
import '../plugins/signage';

// Re-export legend detector utilities
export {
  detectSignageLegend,
  isLegendPage,
  extractSymbolDefinitions,
  extractSheetNumber,
  hasSignageLegendIndicators,
  saveSignageLegend,
  getSignageLegend,
  getSymbolDefinition,
  hasSignageLegend,
  type SymbolDefinition,
  type LegendDetectionResult,
} from './legend-detector';

// Re-export room counter utilities
export {
  countRooms,
  countRoomsOnPage,
  getRoomCountByCategory,
  estimateTactileSigns,
  type RoomCount,
  type RoomCountResult,
  type SignageEstimate,
} from './room-counter';

// Re-export export utilities
export {
  getDocumentExportData,
  getBidExportData,
  formatAsTSV,
  formatAsCSV,
  exportDocumentSignage,
  exportBidSignage,
  type ExportRow,
  type ExportOptions,
} from './export';

/**
 * Signage extraction options
 */
export interface SignageExtractionOptions {
  useVision?: boolean;
  maxPagesForAI?: number;
  skipAI?: boolean;
}

/**
 * Result from signage extraction
 */
export interface SignageExtractionResult {
  jobId: string;
  documentId: string;
  legend: import('./legend-detector').LegendDetectionResult;
  roomCounts: import('./room-counter').RoomCountResult;
  relevantPages: number[];
  itemsExtracted: number;
  pagesProcessedByAI: number;
  pass1TimeMs: number;
  pass2TimeMs: number;
  totalTimeMs: number;
}

/**
 * Main signage extraction function
 * Uses the signage plugin for specialized two-pass extraction
 */
export async function extractSignage(
  documentId: string,
  userId: string,
  options: SignageExtractionOptions = {}
): Promise<SignageExtractionResult> {
  const startTime = Date.now();
  const { useVision = false, maxPagesForAI = 25, skipAI = false } = options;

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

  // Get signage plugin
  const plugin = pluginRegistry.get('signage-division-10');
  if (!plugin) {
    throw new Error('Signage plugin not registered');
  }

  // Get pages
  const pages = await extractPdfPageByPage(doc.storagePath);

  // Build context
  const context: ExtractionContext = {
    documentId,
    userId,
    bidId: doc.bidId,
    storagePath: doc.storagePath,
    pages,
    options: {
      useVision,
      maxPagesForAI,
      skipAI,
    },
  };

  // Run pre-processing
  const preProcessResult = plugin.preProcess
    ? await plugin.preProcess(context)
    : null;

  const pass1EndTime = Date.now();

  // Run extraction
  const extractionResult = await plugin.extract(context, preProcessResult ?? undefined);

  const pass2EndTime = Date.now();

  // Extract metadata from pre-process result
  const legend = (preProcessResult?.metadata?.legend as import('./legend-detector').LegendDetectionResult) || {
    found: false,
    legendPages: [],
    sheetNumbers: [],
    symbols: [],
    confidence: 0,
    rawMatches: [],
  };

  const roomCounts = (preProcessResult?.metadata?.roomCounts as import('./room-counter').RoomCountResult) || {
    totalRooms: 0,
    counts: [],
    signageEstimates: [],
  };

  return {
    jobId: '', // Job is created by orchestrator if using full extraction
    documentId,
    legend,
    roomCounts,
    relevantPages: preProcessResult?.relevantPages || [],
    itemsExtracted: extractionResult.items.length,
    pagesProcessedByAI: extractionResult.pagesProcessed,
    pass1TimeMs: preProcessResult?.timeMs || 0,
    pass2TimeMs: extractionResult.timeMs,
    totalTimeMs: Date.now() - startTime,
  };
}

/**
 * Run only Pass 1 (quick analysis without AI costs)
 */
export async function analyzeSignageQuick(
  documentId: string,
  userId: string
): Promise<{
  legend: import('./legend-detector').LegendDetectionResult;
  roomCounts: import('./room-counter').RoomCountResult;
  relevantPageCount: number;
}> {
  const result = await extractSignage(documentId, userId, { skipAI: true });

  return {
    legend: result.legend,
    roomCounts: result.roomCounts,
    relevantPageCount: result.relevantPages.length,
  };
}
