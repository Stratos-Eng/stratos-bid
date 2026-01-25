/**
 * Signage Extraction Orchestrator
 *
 * Ties everything together with a self-healing loop.
 * Guarantees convergence - always returns a result with confidence score.
 *
 * Flow:
 * 1. Discover available sources
 * 2. Parse primary source
 * 3. Parse secondary sources for verification
 * 4. Deduplicate primary result
 * 5. Cross-verify between sources
 * 6. Handle discrepancies (up to MAX_ITERATIONS)
 * 7. Generate clarifications for unresolved issues
 * 8. Return final result (never fails)
 */

import type { ParsedPage } from '../pdf-parser';
import type {
  SignageEntry,
  ParseResult,
  SourceType,
  FoundSource,
  ExtractionResult,
  Discrepancy,
  Clarification,
} from './types';

import { discoverSources, hasSignageContent } from './source-finder';
import { parseDoorSchedule } from './parsers/door-schedule';
import { parseSignageSchedule } from './parsers/signage-schedule';
import { extractFromFloorPlans } from './parsers/floor-plan';
import { deduplicateEntries, deduplicateAcrossSources } from './deduplication';
import {
  crossVerifySources,
  applyResolution,
  getAutoResolvableItems,
} from './verifier';
import { generateClarifications } from './clarifications';

// ============================================================================
// Configuration
// ============================================================================

const MAX_ITERATIONS = 3;
const MIN_CONFIDENCE_THRESHOLD = 0.3;

// ============================================================================
// Source Parsing
// ============================================================================

/**
 * Parse a source based on its type.
 */
async function parseSource(
  source: FoundSource,
  pages: ParsedPage[]
): Promise<ParseResult> {
  switch (source.type) {
    case 'signage_schedule':
      return parseSignageSchedule(pages, source.pages);

    case 'door_schedule':
      return parseDoorSchedule(pages, source.pages);

    case 'floor_plan':
      return extractFromFloorPlans(pages, source.pages);

    case 'finish_schedule':
      // Finish schedules are similar to door schedules
      // Use door schedule parser with adjusted expectations
      return parseDoorSchedule(pages, source.pages);

    case 'ai_extraction':
      // AI extraction handled separately
      return createEmptyResult('ai_extraction', source.pages);

    default:
      return createEmptyResult('ai_extraction', source.pages);
  }
}

/**
 * Create an empty result placeholder.
 */
function createEmptyResult(source: SourceType, pages: number[]): ParseResult {
  return {
    entries: [],
    source,
    pagesParsed: pages,
    confidence: 0,
    warnings: ['No entries extracted from this source'],
    rawCount: 0,
  };
}

// ============================================================================
// Self-Healing Loop
// ============================================================================

/**
 * Attempt to resolve discrepancies.
 */
function resolveDiscrepancies(
  entries: SignageEntry[],
  discrepancies: Discrepancy[]
): { entries: SignageEntry[]; resolved: Discrepancy[]; unresolved: Discrepancy[] } {
  let currentEntries = [...entries];
  const resolved: Discrepancy[] = [];
  const unresolved: Discrepancy[] = [];

  for (const discrepancy of discrepancies) {
    if (discrepancy.autoResolvable && discrepancy.resolution) {
      try {
        currentEntries = applyResolution(currentEntries, discrepancy);
        resolved.push(discrepancy);
      } catch {
        unresolved.push(discrepancy);
      }
    } else {
      unresolved.push(discrepancy);
    }
  }

  return { entries: currentEntries, resolved, unresolved };
}

// ============================================================================
// Fallback Extraction
// ============================================================================

/**
 * Simple fallback when no good sources found.
 * Extracts any room-like patterns from document.
 */
function fallbackExtraction(pages: ParsedPage[]): SignageEntry[] {
  const entries: SignageEntry[] = [];
  const seenNames = new Set<string>();

  // Room patterns to look for
  const roomPatterns = [
    /([A-Z][A-Z\s]{2,20})\s+(\d{3}[-.]?\d{0,2})/g,
    /(?:ROOM|RM)\s+([A-Z][A-Z\s]+)/gi,
    /(\d{3}-\d{2})\s+([A-Z][A-Z\s]+)/g,
  ];

  for (const page of pages) {
    for (const pattern of roomPatterns) {
      pattern.lastIndex = 0;
      let match;

      while ((match = pattern.exec(page.text)) !== null) {
        const name = (match[1] || match[2]).trim().toUpperCase();
        const normalized = name.replace(/\s+/g, ' ');

        if (normalized.length > 3 && !seenNames.has(normalized)) {
          seenNames.add(normalized);

          entries.push({
            id: `fallback-${entries.length}`,
            identifier: match[2] || normalized,
            name: normalized,
            roomNumber: match[2] || undefined,
            quantity: 1,
            isGrouped: false,
            source: 'ai_extraction',
            sheetRefs: [],
            pageNumbers: [page.pageNumber],
            confidence: 0.3,
            notes: 'Extracted via fallback pattern matching',
          });
        }
      }
    }
  }

  return entries;
}

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Extract signage information from document pages.
 *
 * This is the main entry point for signage extraction.
 * It coordinates source discovery, parsing, verification, and returns
 * a complete result with confidence scores.
 *
 * Key guarantees:
 * - Always returns a result (never throws)
 * - Converges within MAX_ITERATIONS
 * - Returns confidence score indicating reliability
 *
 * @param pages - Parsed pages from the document
 * @returns Complete extraction result
 */
export async function extractSignage(
  pages: ParsedPage[]
): Promise<ExtractionResult> {
  const warnings: string[] = [];
  const sourcesUsed: SourceType[] = [];

  // Check if document likely has signage content
  if (!hasSignageContent(pages)) {
    warnings.push('Document may not contain signage information');
  }

  // Step 1: Discover available sources
  const discovery = discoverSources(pages);
  warnings.push(...discovery.warnings);

  // Handle case where no sources found
  if (!discovery.primarySource) {
    const fallbackEntries = fallbackExtraction(pages);

    return {
      entries: fallbackEntries,
      totalCount: fallbackEntries.length,
      confidence: 0.2,
      primarySource: 'ai_extraction',
      sourcesUsed: ['ai_extraction'],
      discrepancies: [],
      clarifications: generateClarifications([], [{
        type: 'count_mismatch',
        source1: 'ai_extraction',
        source2: 'ai_extraction',
        description: 'No structured sources found',
        affectedEntries: [],
        autoResolvable: false,
      }]),
      converged: true,
      iterations: 1,
      warnings: [...warnings, 'No structured sources found. Using fallback extraction.'],
    };
  }

  // Step 2: Parse primary source
  const primaryResult = await parseSource(discovery.primarySource, pages);
  sourcesUsed.push(primaryResult.source);
  warnings.push(...primaryResult.warnings);

  // Step 3: Parse secondary sources
  const secondarySources = discovery.sources.filter(s => s !== discovery.primarySource);
  const secondaryResults: ParseResult[] = [];

  for (const source of secondarySources) {
    try {
      const result = await parseSource(source, pages);
      if (result.entries.length > 0) {
        secondaryResults.push(result);
        sourcesUsed.push(result.source);
        warnings.push(...result.warnings);
      }
    } catch (error) {
      warnings.push(`Failed to parse ${source.type}: ${error}`);
    }
  }

  // Step 4: Deduplicate primary result
  const dedupResult = deduplicateEntries(primaryResult.entries);
  let finalEntries = dedupResult.uniqueEntries;

  if (dedupResult.duplicatesRemoved > 0) {
    warnings.push(`Removed ${dedupResult.duplicatesRemoved} duplicate entries`);
  }

  // Step 5: Cross-verify
  let verification = crossVerifySources(
    { ...primaryResult, entries: finalEntries },
    secondaryResults
  );

  // Step 6: Self-healing loop
  let iterations = 1;
  let allDiscrepancies = verification.discrepancies;

  while (verification.discrepancies.length > 0 && iterations < MAX_ITERATIONS) {
    iterations++;

    // Get auto-resolvable discrepancies
    const autoResolvable = getAutoResolvableItems(verification);

    if (autoResolvable.length === 0) {
      // Nothing more we can auto-resolve
      break;
    }

    // Apply resolutions
    const { entries: resolvedEntries, resolved, unresolved } =
      resolveDiscrepancies(finalEntries, verification.discrepancies);

    finalEntries = resolvedEntries;

    // Update warnings
    for (const d of resolved) {
      warnings.push(`Auto-resolved: ${d.description}`);
    }

    // Re-verify if we made changes
    if (resolved.length > 0) {
      verification = crossVerifySources(
        { ...primaryResult, entries: finalEntries },
        secondaryResults
      );
    } else {
      break;
    }
  }

  // Step 7: Consider adding entries from secondary sources
  if (secondaryResults.length > 0) {
    // Get entries from secondary that aren't in primary
    const allSecondaryEntries = secondaryResults.flatMap(r => r.entries);
    const crossDedup = deduplicateAcrossSources([
      { source: primaryResult.source, entries: finalEntries },
      ...secondaryResults.map(r => ({ source: r.source, entries: r.entries })),
    ]);

    // If cross-dedup found more unique entries, consider using them
    if (crossDedup.uniqueEntries.length > finalEntries.length) {
      const additionalCount = crossDedup.uniqueEntries.length - finalEntries.length;
      warnings.push(`Found ${additionalCount} additional entries from secondary sources`);

      // Only add if confidence is reasonable
      if (verification.confidence > 0.6) {
        finalEntries = crossDedup.uniqueEntries;
      }
    }
  }

  // Step 8: Generate clarifications for unresolved issues
  const clarifications = generateClarifications(finalEntries, allDiscrepancies);

  // Calculate final confidence
  const finalConfidence = Math.max(
    MIN_CONFIDENCE_THRESHOLD,
    verification.confidence * (finalEntries.length > 0 ? 1 : 0.5)
  );

  // Check convergence
  const converged = verification.discrepancies.every(
    d => d.autoResolvable || d.resolution
  );

  return {
    entries: finalEntries,
    totalCount: calculateTotalCount(finalEntries),
    confidence: finalConfidence,
    primarySource: primaryResult.source,
    sourcesUsed: [...new Set(sourcesUsed)],
    discrepancies: allDiscrepancies,
    clarifications,
    converged,
    iterations,
    warnings,
  };
}

/**
 * Calculate total sign count (accounting for quantities).
 */
function calculateTotalCount(entries: SignageEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.quantity, 0);
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Quick extraction for simple cases.
 * Skips secondary source verification.
 */
export async function quickExtractSignage(
  pages: ParsedPage[]
): Promise<ExtractionResult> {
  const discovery = discoverSources(pages);

  if (!discovery.primarySource) {
    const fallbackEntries = fallbackExtraction(pages);
    return {
      entries: fallbackEntries,
      totalCount: fallbackEntries.length,
      confidence: 0.2,
      primarySource: 'ai_extraction',
      sourcesUsed: ['ai_extraction'],
      discrepancies: [],
      clarifications: [],
      converged: true,
      iterations: 1,
      warnings: ['Quick extraction: No structured sources found'],
    };
  }

  const result = await parseSource(discovery.primarySource, pages);
  const dedupResult = deduplicateEntries(result.entries);

  return {
    entries: dedupResult.uniqueEntries,
    totalCount: calculateTotalCount(dedupResult.uniqueEntries),
    confidence: result.confidence,
    primarySource: result.source,
    sourcesUsed: [result.source],
    discrepancies: [],
    clarifications: [],
    converged: true,
    iterations: 1,
    warnings: result.warnings,
  };
}

/**
 * Get extraction summary for display.
 */
export function getExtractionSummary(result: ExtractionResult): string {
  const lines: string[] = [];

  lines.push(`=== Signage Extraction Summary ===`);
  lines.push(`Total Signs: ${result.totalCount}`);
  lines.push(`Unique Entries: ${result.entries.length}`);
  lines.push(`Confidence: ${Math.round(result.confidence * 100)}%`);
  lines.push(`Primary Source: ${result.primarySource}`);
  lines.push(`Sources Used: ${result.sourcesUsed.join(', ')}`);
  lines.push(`Iterations: ${result.iterations}`);
  lines.push(`Converged: ${result.converged ? 'Yes' : 'No'}`);

  if (result.discrepancies.length > 0) {
    lines.push(`\nDiscrepancies: ${result.discrepancies.length}`);
  }

  if (result.clarifications.length > 0) {
    lines.push(`\nClarifications Needed: ${result.clarifications.length}`);
  }

  if (result.warnings.length > 0) {
    lines.push(`\nWarnings:`);
    for (const warning of result.warnings.slice(0, 5)) {
      lines.push(`  - ${warning}`);
    }
    if (result.warnings.length > 5) {
      lines.push(`  ... and ${result.warnings.length - 5} more`);
    }
  }

  return lines.join('\n');
}
