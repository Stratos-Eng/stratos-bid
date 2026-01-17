/**
 * Document Extraction System
 *
 * Main entry point for document extraction.
 * Uses a plugin-based architecture for trade-specific extraction.
 *
 * Supported trades:
 * - division_10 (Signage) - Two-pass extraction with legend detection
 * - division_08 (Glazing) - Generic keyword-based extraction
 *
 * To add a new trade:
 * 1. Create a plugin in src/extraction/plugins/{trade}/index.ts
 * 2. Implement the ExtractionPlugin interface
 * 3. Register via registerPlugin() in the plugin file
 * 4. Import the plugin in src/extraction/plugins/index.ts
 */

// Re-export orchestrator functions (primary API)
export {
  extractDocument,
  reExtractDocument,
  getExtractionProgress,
  analyzeDocumentQuick,
  type OrchestratorOptions,
  type OrchestratorResult,
} from './orchestrator';

// Re-export plugin system for extensibility
export {
  pluginRegistry,
  registerPlugin,
  BaseExtractionPlugin,
  type ExtractionPlugin,
  type ExtractionContext,
  type ExtractionOptions,
  type ExtractionResult,
  type PreProcessResult,
  type ExtractedItem,
  type PluginResult,
  type PluginMetadata,
} from './plugins';

// Re-export PDF utilities
export {
  extractPdfPageByPage,
  getPdfMetadata,
  extractPdfText,
  validatePdfFile,
  type ParsedPage,
  type PdfMetadata,
} from './pdf-parser';

// Re-export Claude analyzer for custom plugins
export {
  analyzePageText,
  analyzePageVision,
  analyzePageHybrid,
  type ExtractedLineItem,
  type ExtractionResult as AnalyzerResult,
} from './claude-analyzer';

// Legacy type exports for backward compatibility
import type { TradeCode } from '@/lib/trade-definitions';

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
 * Extract from multiple documents (batch processing)
 */
export async function extractDocuments(
  documentIds: string[],
  userId: string,
  options: { trades: TradeCode[]; useVision?: boolean; concurrency?: number }
): Promise<{ results: Array<{ documentId: string; jobId: string; itemsExtracted: number }> }> {
  const { extractDocument } = await import('./orchestrator');
  const results = [];

  for (const documentId of documentIds) {
    try {
      const result = await extractDocument(documentId, userId, options);
      results.push({
        documentId,
        jobId: result.jobId,
        itemsExtracted: result.totalItemsExtracted,
      });
    } catch (error) {
      console.error(`Failed to extract document ${documentId}:`, error);
      results.push({ documentId, jobId: '', itemsExtracted: 0 });
    }
  }

  return { results };
}
