/**
 * Extraction Plugin System - Type Definitions
 *
 * Defines the contract for trade-specific extraction plugins.
 * Each plugin can implement specialized pre-processing and extraction logic.
 */

import type { ParsedPage } from '../pdf-parser';
import type { TradeCode } from '@/lib/trade-definitions';

/**
 * Result from pre-processing phase (deterministic analysis)
 */
export interface PreProcessResult {
  /** Relevant page numbers identified */
  relevantPages: number[];
  /** Any context to pass to AI extraction */
  context: string;
  /** Plugin-specific data (legend info, room counts, etc.) */
  metadata: Record<string, unknown>;
  /** Time taken for pre-processing */
  timeMs: number;
}

/**
 * Single extracted line item
 */
export interface ExtractedItem {
  category: string;
  description: string;
  estimatedQty: string | null;
  unit: string | null;
  notes: string | null;
  specifications: Record<string, string>;
  confidence: number;
  pageNumber: number;
  pageReference?: string;
  /** Normalized X coordinate on page (0-1) */
  pageX?: number;
  /** Normalized Y coordinate on page (0-1) */
  pageY?: number;
}

/**
 * Result from extraction phase
 */
export interface ExtractionResult {
  items: ExtractedItem[];
  pagesProcessed: number;
  timeMs: number;
  rawResponses?: string[];
}

/**
 * Combined result from full plugin run
 */
export interface PluginResult {
  pluginId: string;
  tradeCode: TradeCode;
  preProcess: PreProcessResult | null;
  extraction: ExtractionResult;
  totalTimeMs: number;
}

/**
 * Options passed to extraction plugins
 */
export interface ExtractionOptions {
  /** Use vision analysis for scanned documents */
  useVision?: boolean;
  /** Maximum pages to send to AI (cost control) */
  maxPagesForAI?: number;
  /** Skip AI extraction entirely (pre-process only) */
  skipAI?: boolean;
  /** Concurrency for parallel AI requests */
  concurrency?: number;
}

/**
 * Context provided to plugins during extraction
 */
export interface ExtractionContext {
  documentId: string;
  userId: string;
  bidId: string | null;
  storagePath: string;
  pages: ParsedPage[];
  options: ExtractionOptions;
}

/**
 * Extraction Plugin Interface
 *
 * Each trade implements this interface to provide specialized extraction.
 */
export interface ExtractionPlugin {
  /** Unique plugin identifier */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Trade code this plugin handles */
  readonly tradeCode: TradeCode;

  /** Priority (higher = runs first if multiple plugins match) */
  readonly priority: number;

  /**
   * Determine if this plugin should process the document
   * Called with parsed pages to check for relevance
   */
  isRelevant(pages: ParsedPage[]): boolean;

  /**
   * Pre-processing phase (optional, deterministic)
   * Examples: legend detection, room counting, symbol extraction
   * Runs before AI to build context and filter pages
   */
  preProcess?(context: ExtractionContext): Promise<PreProcessResult>;

  /**
   * Main extraction phase (AI-powered)
   * Extracts line items from relevant pages
   */
  extract(
    context: ExtractionContext,
    preProcessResult?: PreProcessResult
  ): Promise<ExtractionResult>;
}

/**
 * Plugin metadata for registration
 */
export interface PluginMetadata {
  id: string;
  name: string;
  tradeCode: TradeCode;
  priority: number;
  hasPreProcess: boolean;
}
