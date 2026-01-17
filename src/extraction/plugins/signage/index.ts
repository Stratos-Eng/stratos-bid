/**
 * Signage Extraction Plugin (Division 10)
 *
 * Specialized two-pass extraction for signage:
 * Pass 1: Legend detection + room counting (deterministic, fast)
 * Pass 2: AI extraction with context (on relevant pages)
 */

import type {
  ExtractionPlugin,
  ExtractionContext,
  ExtractionResult,
  PreProcessResult,
  ExtractedItem,
} from '../types';
import type { ParsedPage } from '../../pdf-parser';
import { TRADE_DEFINITIONS } from '@/lib/trade-definitions';
import { analyzePageText } from '../../claude-analyzer';
import { registerPlugin } from '../registry';

// Re-export utilities from existing signage module
import {
  detectSignageLegend,
  saveSignageLegend,
  type LegendDetectionResult,
  type SymbolDefinition,
} from '../../signage/legend-detector';
import {
  countRooms,
  type RoomCountResult,
} from '../../signage/room-counter';

export { LegendDetectionResult, SymbolDefinition, RoomCountResult };

const trade = TRADE_DEFINITIONS.division_10;

/**
 * Build context string from legend and room counts for AI prompt
 */
function buildContextForAI(
  legend: LegendDetectionResult,
  roomCounts: RoomCountResult
): string {
  const parts: string[] = [];

  // Legend context
  if (legend.found && legend.symbols.length > 0) {
    parts.push('SIGN LEGEND FROM THIS DOCUMENT:');
    for (const sym of legend.symbols) {
      let line = `- ${sym.symbol}: ${sym.description}`;
      if (sym.detailReference) {
        line += ` (see detail ${sym.detailReference})`;
      }
      parts.push(line);
    }
    parts.push(`Legend found on page(s): ${legend.legendPages.join(', ')}`);
    if (legend.sheetNumbers.length > 0) {
      parts.push(`Sheet number(s): ${legend.sheetNumbers.join(', ')}`);
    }
    parts.push('');
  }

  // Room count context
  if (roomCounts.totalRooms > 0) {
    parts.push('ROOM COUNTS FROM FLOOR PLANS:');
    for (const count of roomCounts.counts) {
      parts.push(`- ${count.type}: ${count.count} rooms (${count.roomNumbers.join(', ')})`);
    }
    parts.push('');

    // Signage estimates
    if (roomCounts.signageEstimates.length > 0) {
      parts.push('ESTIMATED QUANTITIES BASED ON ROOM COUNTS:');
      for (const est of roomCounts.signageEstimates) {
        parts.push(`- ${est.signType}: ~${est.estimatedQty} (${est.basedOn})`);
      }
      parts.push('');
    }
  }

  if (parts.length === 0) {
    return '';
  }

  return `
=== CONTEXT FROM DOCUMENT ANALYSIS ===
${parts.join('\n')}
Use this context to validate and enhance your extraction. Cross-reference symbol codes with the legend definitions above.
======================================

`;
}

/**
 * Filter pages likely containing signage content
 */
function filterRelevantPages(pages: ParsedPage[]): ParsedPage[] {
  return pages.filter((page) => {
    const textLower = page.text.toLowerCase();

    // Check for signage keywords
    const hasKeyword = trade.keywords.some((kw) =>
      textLower.includes(kw.toLowerCase())
    );

    // Check for symbol patterns (TS-01, RR, etc.)
    const hasSymbol = /[A-Z]{2}-\d{2}|(?:^|\s)[A-Z]{2}(?:\s|$)/m.test(page.text);

    return hasKeyword || hasSymbol;
  });
}

/**
 * Signage Plugin Implementation
 */
const signagePlugin: ExtractionPlugin = {
  id: 'signage-division-10',
  name: 'Signage Extraction (Division 10)',
  tradeCode: 'division_10',
  priority: 100, // High priority - run specialized signage before generic

  /**
   * Check if document contains signage content
   */
  isRelevant(pages: ParsedPage[]): boolean {
    const allText = pages.map((p) => p.text).join(' ').toLowerCase();

    // Quick keyword check
    const hasKeywords = trade.keywords.some((kw) =>
      allText.includes(kw.toLowerCase())
    );

    // Check for symbol patterns
    const hasSymbols = /[A-Z]{2}-\d{2}/.test(allText);

    // Check for legend indicators
    const hasLegend = /sign\s*(age)?\s*legend|sign\s*(age)?\s*schedule/i.test(allText);

    return hasKeywords || hasSymbols || hasLegend;
  },

  /**
   * Pre-processing: Legend detection + room counting
   */
  async preProcess(context: ExtractionContext): Promise<PreProcessResult> {
    const startTime = Date.now();
    const { pages, documentId } = context;

    console.log(`[Signage] Pre-processing ${pages.length} pages...`);

    // Pass 1a: Detect legend
    const legend = detectSignageLegend(pages);
    console.log(`[Signage] Legend found: ${legend.found}, symbols: ${legend.symbols.length}`);

    // Save legend to document (for future reference)
    if (documentId) {
      await saveSignageLegend(documentId, legend);
    }

    // Pass 1b: Count rooms
    const roomCounts = countRooms(pages);
    console.log(`[Signage] Rooms found: ${roomCounts.totalRooms}`);

    // Filter to relevant pages
    const relevantPages = filterRelevantPages(pages);
    console.log(`[Signage] Relevant pages: ${relevantPages.length} of ${pages.length}`);

    // Build context for AI phase
    const aiContext = buildContextForAI(legend, roomCounts);

    const timeMs = Date.now() - startTime;
    console.log(`[Signage] Pre-processing complete in ${timeMs}ms`);

    return {
      relevantPages: relevantPages.map((p) => p.pageNumber),
      context: aiContext,
      metadata: {
        legend,
        roomCounts,
      },
      timeMs,
    };
  },

  /**
   * Main extraction: AI-powered analysis with context
   */
  async extract(
    context: ExtractionContext,
    preProcessResult?: PreProcessResult
  ): Promise<ExtractionResult> {
    const startTime = Date.now();
    const { pages, options } = context;
    const { maxPagesForAI = 25, skipAI = false, concurrency = 3 } = options;

    if (skipAI) {
      return {
        items: [],
        pagesProcessed: 0,
        timeMs: Date.now() - startTime,
      };
    }

    // Get legend for cross-referencing
    const legend = preProcessResult?.metadata?.legend as LegendDetectionResult | undefined;

    // Use pre-processed relevant pages or filter ourselves
    let relevantPages: ParsedPage[];
    if (preProcessResult?.relevantPages.length) {
      relevantPages = pages.filter((p) =>
        preProcessResult.relevantPages.includes(p.pageNumber)
      );
    } else {
      relevantPages = filterRelevantPages(pages);
    }

    // Limit for cost control
    const pagesToProcess = relevantPages.slice(0, maxPagesForAI);

    console.log(`[Signage] AI extraction on ${pagesToProcess.length} pages...`);

    const items: ExtractedItem[] = [];
    const rawResponses: string[] = [];

    // Process in batches
    for (let i = 0; i < pagesToProcess.length; i += concurrency) {
      const batch = pagesToProcess.slice(i, i + concurrency);

      const batchResults = await Promise.all(
        batch.map(async (page) => {
          // Enhance text with context from pre-processing
          const enhancedText = preProcessResult?.context
            ? `${preProcessResult.context}${page.text}`
            : page.text;

          return analyzePageText(enhancedText, page.pageNumber, 'division_10');
        })
      );

      for (const result of batchResults) {
        rawResponses.push(result.rawResponse);

        // Enhance items with legend cross-references
        for (const item of result.items) {
          // Try to match symbol codes to legend
          let enhancedNotes = item.notes;
          if (legend?.symbols.length) {
            const symbolMatch = item.description.match(/([A-Z]{2,3}-?\d{2})/);
            if (symbolMatch) {
              const legendEntry = legend.symbols.find(
                (s) => s.symbol === symbolMatch[1]
              );
              if (legendEntry?.detailReference) {
                enhancedNotes = enhancedNotes
                  ? `${enhancedNotes}. Per detail ${legendEntry.detailReference}`
                  : `Per detail ${legendEntry.detailReference}`;
              }
            }
          }

          items.push({
            category: item.category,
            description: item.description,
            estimatedQty: item.estimatedQty,
            unit: item.unit || 'EA',
            notes: enhancedNotes,
            specifications: item.specifications,
            confidence: item.confidence,
            pageNumber: result.pageNumber,
            pageReference: item.pageReference,
          });
        }
      }

      // Brief pause between batches
      if (i + concurrency < pagesToProcess.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    const timeMs = Date.now() - startTime;
    console.log(`[Signage] AI extraction complete: ${items.length} items in ${timeMs}ms`);

    return {
      items,
      pagesProcessed: pagesToProcess.length,
      timeMs,
      rawResponses,
    };
  },
};

// Register the plugin
registerPlugin(signagePlugin);

export default signagePlugin;
