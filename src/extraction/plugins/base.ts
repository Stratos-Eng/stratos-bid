/**
 * Base Extraction Plugin
 *
 * Provides common functionality for extraction plugins.
 * Trade-specific plugins can extend this or implement the interface directly.
 */

import type {
  ExtractionPlugin,
  ExtractionContext,
  ExtractionResult,
  PreProcessResult,
  ExtractedItem,
} from './types';
import type { ParsedPage } from '../pdf-parser';
import type { TradeCode } from '@/lib/trade-definitions';
import { TRADE_DEFINITIONS } from '@/lib/trade-definitions';
import { analyzePageText } from '../claude-analyzer';

export interface BasePluginConfig {
  id: string;
  name: string;
  tradeCode: TradeCode;
  priority?: number;
  /** Custom relevance checker (default uses trade keywords) */
  relevanceChecker?: (pages: ParsedPage[]) => boolean;
  /** System prompt for Claude */
  systemPrompt: string;
  /** Extraction prompt template */
  extractionPrompt: string;
}

/**
 * Base implementation with common extraction logic
 */
export abstract class BaseExtractionPlugin implements ExtractionPlugin {
  readonly id: string;
  readonly name: string;
  readonly tradeCode: TradeCode;
  readonly priority: number;

  protected readonly systemPrompt: string;
  protected readonly extractionPrompt: string;
  protected readonly trade: (typeof TRADE_DEFINITIONS)[TradeCode];

  constructor(config: BasePluginConfig) {
    this.id = config.id;
    this.name = config.name;
    this.tradeCode = config.tradeCode;
    this.priority = config.priority ?? 50;
    this.systemPrompt = config.systemPrompt;
    this.extractionPrompt = config.extractionPrompt;
    this.trade = TRADE_DEFINITIONS[config.tradeCode];
  }

  /**
   * Default relevance check using trade keywords
   */
  isRelevant(pages: ParsedPage[]): boolean {
    const allText = pages.map((p) => p.text).join(' ').toLowerCase();
    return this.trade.keywords.some((kw) => allText.includes(kw.toLowerCase()));
  }

  /**
   * Filter pages to those relevant for this trade
   */
  protected filterRelevantPages(pages: ParsedPage[]): ParsedPage[] {
    return pages.filter((page) => {
      const textLower = page.text.toLowerCase();
      return this.trade.keywords.some((kw) => textLower.includes(kw.toLowerCase()));
    });
  }

  /**
   * Default extraction implementation using Claude
   */
  async extract(
    context: ExtractionContext,
    preProcessResult?: PreProcessResult
  ): Promise<ExtractionResult> {
    const startTime = Date.now();
    const { pages, options } = context;
    const { maxPagesForAI = 20, skipAI = false, concurrency = 3 } = options;

    if (skipAI) {
      return {
        items: [],
        pagesProcessed: 0,
        timeMs: Date.now() - startTime,
      };
    }

    // Use pre-processed relevant pages if available
    let relevantPages: ParsedPage[];
    if (preProcessResult?.relevantPages.length) {
      relevantPages = pages.filter((p) =>
        preProcessResult.relevantPages.includes(p.pageNumber)
      );
    } else {
      relevantPages = this.filterRelevantPages(pages);
    }

    // Limit pages for cost control
    const pagesToProcess = relevantPages.slice(0, maxPagesForAI);
    const items: ExtractedItem[] = [];
    const rawResponses: string[] = [];

    // Process in batches
    for (let i = 0; i < pagesToProcess.length; i += concurrency) {
      const batch = pagesToProcess.slice(i, i + concurrency);

      const batchResults = await Promise.all(
        batch.map(async (page) => {
          // Build enhanced text with context
          const enhancedText = preProcessResult?.context
            ? `${preProcessResult.context}\n\n${page.text}`
            : page.text;

          const result = await analyzePageText(
            enhancedText,
            page.pageNumber,
            this.tradeCode
          );

          return result;
        })
      );

      for (const result of batchResults) {
        rawResponses.push(result.rawResponse);
        for (const item of result.items) {
          items.push({
            category: item.category,
            description: item.description,
            estimatedQty: item.estimatedQty,
            unit: item.unit,
            notes: item.notes,
            specifications: item.specifications,
            confidence: item.confidence,
            pageNumber: result.pageNumber,
            pageReference: item.pageReference,
          });
        }
      }

      // Brief pause between batches
      if (i + concurrency < pagesToProcess.length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    return {
      items,
      pagesProcessed: pagesToProcess.length,
      timeMs: Date.now() - startTime,
      rawResponses,
    };
  }
}
