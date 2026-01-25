/**
 * Source Finder for Signage Extraction
 *
 * The entry point that answers "where is the truth in this document?"
 * Detects available sources in priority order:
 * 1. Signage Schedule (dedicated signage tables - best)
 * 2. Door Schedule (room names associated with doors)
 * 3. Finish Schedule (room finish schedules)
 * 4. Floor Plans (room tags - fallback)
 */

import type { ParsedPage } from '../pdf-parser';
import type {
  SourceType,
  SourceFormat,
  FoundSource,
  SourceDiscoveryResult
} from './types';

// ============================================================================
// Source Detection Patterns
// ============================================================================

/**
 * Patterns that indicate specific source types.
 * Multiple matches increase confidence.
 */
const SOURCE_SIGNATURES: Record<Exclude<SourceType, 'ai_extraction'>, RegExp[]> = {
  signage_schedule: [
    /sign\s*(?:age)?\s*schedule/i,
    /sign\s*legend/i,
    /signage\s*types?/i,
    /sign\s*(?:type|code)\s+description/i,
    /tactile\s*sign/i,
    /ada\s*sign/i,
    /room\s*(?:id|identification)\s*sign/i,
  ],
  door_schedule: [
    /door\s*schedule/i,
    /door\s*no\.?\s*(?:room|mark)/i,
    /hardware\s*(?:set|group)/i,
    /door\s*type/i,
    /frame\s*type/i,
    /door\s*width.*height/i,
  ],
  finish_schedule: [
    /(?:room\s*)?finish\s*schedule/i,
    /floor\s*finish/i,
    /wall\s*finish/i,
    /ceiling\s*finish/i,
    /base\s*finish/i,
    /room\s*finish/i,
  ],
  floor_plan: [
    /floor\s*plan/i,
    /enlarged\s*(?:floor\s*)?plan/i,
    /partial\s*(?:floor\s*)?plan/i,
    /plan\s*(?:north|south|east|west)/i,
    /level\s*\d+\s*plan/i,
    /sheet\s*[a-z]?\d+\.\d+/i,
  ],
};

/**
 * Sheet reference patterns that indicate sheet types.
 */
const SHEET_TYPE_PATTERNS: Record<string, RegExp[]> = {
  door_schedule: [
    /^A[0-9]\.(?:4|5)/i,   // A4.x, A5.x often door schedules
    /^AD/i,                 // AD sheets
  ],
  finish_schedule: [
    /^A[0-9]\.(?:6|7)/i,   // A6.x, A7.x often finishes
    /^AF/i,                 // AF sheets
  ],
  floor_plan: [
    /^A[0-9]\.(?:1|2)/i,   // A1.x, A2.x often floor plans
    /^A0\./i,              // A0.x key plans
  ],
  signage_schedule: [
    /^AG/i,                 // AG accessibility/graphics
    /^A[0-9]\.8/i,         // A8.x specialty schedules
  ],
};

// ============================================================================
// Format Detection
// ============================================================================

/**
 * Detect the format of content on given pages.
 */
function detectFormat(pages: ParsedPage[], pageNumbers: number[]): SourceFormat {
  const relevantPages = pages.filter(p => pageNumbers.includes(p.pageNumber));
  const allText = relevantPages.map(p => p.text).join('\n');

  // Check for tabular indicators
  const tabularIndicators = [
    /\t.*\t.*\t/m,                    // Tab-separated columns
    /\|.*\|.*\|/m,                    // Pipe-separated
    /\s{3,}\S+\s{3,}\S+\s{3,}/m,     // Space-aligned columns
  ];

  for (const pattern of tabularIndicators) {
    if (pattern.test(allText)) {
      return 'tabular';
    }
  }

  // Check for list indicators
  const listIndicators = [
    /^\s*[-•●]\s+/m,                  // Bullet points
    /^\s*\d+\.\s+/m,                  // Numbered list
    /^\s*[a-z]\)\s+/mi,               // Letter list
  ];

  for (const pattern of listIndicators) {
    if (pattern.test(allText)) {
      return 'list';
    }
  }

  // Check for tagged content (room tags on floor plans)
  const taggedIndicators = [
    /\d{3}-\d{2}/,                    // Room numbers like 214-03
    /[A-Z]{2,}\s+\d+/,               // Room type + number
  ];

  for (const pattern of taggedIndicators) {
    const matches = allText.match(new RegExp(pattern, 'g'));
    if (matches && matches.length > 5) {
      return 'tagged';
    }
  }

  return 'unknown';
}

// ============================================================================
// Page Detection
// ============================================================================

/**
 * Find pages that match any of the given patterns.
 */
function findPagesMatching(
  pages: ParsedPage[],
  patterns: RegExp[]
): { pages: number[]; matchCount: number } {
  const matchingPages: number[] = [];
  let totalMatches = 0;

  for (const page of pages) {
    let pageMatches = 0;
    for (const pattern of patterns) {
      if (pattern.test(page.text)) {
        pageMatches++;
      }
    }

    if (pageMatches > 0) {
      matchingPages.push(page.pageNumber);
      totalMatches += pageMatches;
    }
  }

  return { pages: matchingPages, matchCount: totalMatches };
}

/**
 * Find floor plan pages based on sheet naming and content.
 */
function findFloorPlanPages(pages: ParsedPage[]): number[] {
  const floorPlanPages: number[] = [];

  for (const page of pages) {
    // Check sheet reference in metadata or text
    const sheetMatch = page.text.match(/(?:sheet|dwg)[:\s]*([A-Z]?\d+\.\d+[A-Z]?)/i);

    if (sheetMatch) {
      const sheetRef = sheetMatch[1];
      // Floor plans typically on A0.x, A1.x, A2.x sheets
      if (/^A[0-2]\./i.test(sheetRef)) {
        floorPlanPages.push(page.pageNumber);
        continue;
      }
    }

    // Check content patterns
    const hasFloorPlanContent = SOURCE_SIGNATURES.floor_plan.some(p => p.test(page.text));
    const hasRoomTags = /\d{3}-\d{2}/.test(page.text) || /[A-Z]{2,}\s+\d{3}/.test(page.text);

    if (hasFloorPlanContent && hasRoomTags) {
      floorPlanPages.push(page.pageNumber);
    }
  }

  return [...new Set(floorPlanPages)]; // Dedupe
}

/**
 * Extract sheet reference from a page if available.
 */
function extractSheetRef(page: ParsedPage): string | null {
  const patterns = [
    /(?:sheet|dwg)[:\s]*([A-Z]?\d+\.\d+[A-Z]?)/i,
    /^([A-Z]\d+\.\d+[A-Z]?)\s/m,
  ];

  for (const pattern of patterns) {
    const match = page.text.match(pattern);
    if (match) {
      return match[1].toUpperCase();
    }
  }

  return null;
}

// ============================================================================
// Confidence Calculation
// ============================================================================

/**
 * Calculate confidence based on match quality and page count.
 */
function calculateConfidence(
  sourceType: SourceType,
  matchCount: number,
  pageCount: number
): number {
  // Base confidence by source type (priority order)
  const baseConfidence: Record<SourceType, number> = {
    signage_schedule: 0.95,
    door_schedule: 0.85,
    finish_schedule: 0.70,
    floor_plan: 0.50,
    ai_extraction: 0.30,
  };

  let confidence = baseConfidence[sourceType];

  // Boost for multiple pattern matches
  if (matchCount > 3) {
    confidence = Math.min(confidence + 0.05, 1.0);
  }

  // Slight penalty for single-page sources (might be incomplete)
  if (pageCount === 1 && sourceType !== 'signage_schedule') {
    confidence -= 0.05;
  }

  // Boost for multi-page sources (likely more complete)
  if (pageCount > 2) {
    confidence = Math.min(confidence + 0.03, 1.0);
  }

  return Math.round(confidence * 100) / 100;
}

// ============================================================================
// Warning Generation
// ============================================================================

/**
 * Generate warnings based on discovered sources.
 */
function generateWarnings(sources: FoundSource[]): string[] {
  const warnings: string[] = [];

  // No high-confidence source
  if (sources.length === 0 || sources[0].confidence < 0.6) {
    warnings.push('No high-confidence source found. Results may require manual verification.');
  }

  // Only floor plans available
  if (sources.length === 1 && sources[0].type === 'floor_plan') {
    warnings.push('Only floor plans detected. Room count may include duplicates across sheets.');
  }

  // Multiple schedule types found (good for cross-verification)
  const scheduleTypes = sources.filter(s =>
    s.type === 'door_schedule' ||
    s.type === 'signage_schedule' ||
    s.type === 'finish_schedule'
  );

  if (scheduleTypes.length > 1) {
    // This is actually good - note it
    warnings.push(`Multiple schedule sources found (${scheduleTypes.map(s => s.type).join(', ')}). Cross-verification possible.`);
  }

  // Check for unknown formats
  const unknownFormat = sources.find(s => s.format === 'unknown');
  if (unknownFormat) {
    warnings.push(`Source ${unknownFormat.type} has unknown format. May require AI extraction.`);
  }

  return warnings;
}

// ============================================================================
// Main Discovery Function
// ============================================================================

/**
 * Discover all available signage sources in the document.
 *
 * Returns sources in priority order with confidence scores.
 * The primary source is the highest-confidence one.
 *
 * @param pages - Parsed pages from the document
 * @returns Discovery result with sources and warnings
 */
export function discoverSources(pages: ParsedPage[]): SourceDiscoveryResult {
  const sources: FoundSource[] = [];

  // 1. Look for signage schedule (best case)
  const signageResult = findPagesMatching(pages, SOURCE_SIGNATURES.signage_schedule);
  if (signageResult.pages.length > 0) {
    sources.push({
      type: 'signage_schedule',
      pages: signageResult.pages,
      confidence: calculateConfidence('signage_schedule', signageResult.matchCount, signageResult.pages.length),
      format: detectFormat(pages, signageResult.pages),
      metadata: { matchCount: signageResult.matchCount },
    });
  }

  // 2. Look for door schedule (common)
  const doorResult = findPagesMatching(pages, SOURCE_SIGNATURES.door_schedule);
  if (doorResult.pages.length > 0) {
    sources.push({
      type: 'door_schedule',
      pages: doorResult.pages,
      confidence: calculateConfidence('door_schedule', doorResult.matchCount, doorResult.pages.length),
      format: detectFormat(pages, doorResult.pages),
      metadata: { matchCount: doorResult.matchCount },
    });
  }

  // 3. Look for finish schedule
  const finishResult = findPagesMatching(pages, SOURCE_SIGNATURES.finish_schedule);
  if (finishResult.pages.length > 0) {
    sources.push({
      type: 'finish_schedule',
      pages: finishResult.pages,
      confidence: calculateConfidence('finish_schedule', finishResult.matchCount, finishResult.pages.length),
      format: detectFormat(pages, finishResult.pages),
      metadata: { matchCount: finishResult.matchCount },
    });
  }

  // 4. Floor plans are always available as fallback
  const floorPlanPages = findFloorPlanPages(pages);
  if (floorPlanPages.length > 0) {
    sources.push({
      type: 'floor_plan',
      pages: floorPlanPages,
      confidence: calculateConfidence('floor_plan', floorPlanPages.length, floorPlanPages.length),
      format: 'tagged',
      metadata: { pageCount: floorPlanPages.length },
    });
  }

  // Sort by confidence (highest first)
  sources.sort((a, b) => b.confidence - a.confidence);

  // Generate warnings
  const warnings = generateWarnings(sources);

  return {
    sources,
    primarySource: sources.length > 0 ? sources[0] : null,
    warnings,
  };
}

/**
 * Quick check if a document likely has signage information.
 * Useful for filtering documents before full extraction.
 */
export function hasSignageContent(pages: ParsedPage[]): boolean {
  const signageIndicators = [
    /sign(?:age)?/i,
    /tactile/i,
    /ada\s*complian/i,
    /room\s*(?:id|identification)/i,
    /exit\s*sign/i,
    /restroom\s*sign/i,
  ];

  const allText = pages.map(p => p.text).join(' ').toLowerCase();

  return signageIndicators.some(pattern => pattern.test(allText));
}

/**
 * Get pages containing a specific source type.
 * Useful for targeted extraction.
 */
export function getPagesForSourceType(
  pages: ParsedPage[],
  sourceType: Exclude<SourceType, 'ai_extraction'>
): number[] {
  if (sourceType === 'floor_plan') {
    return findFloorPlanPages(pages);
  }

  const patterns = SOURCE_SIGNATURES[sourceType];
  if (!patterns) {
    return [];
  }

  return findPagesMatching(pages, patterns).pages;
}

/**
 * Analyze a specific page for source type detection.
 * Returns all source types that match the page.
 */
export function analyzePageSources(page: ParsedPage): {
  types: SourceType[];
  sheetRef: string | null;
  format: SourceFormat;
} {
  const types: SourceType[] = [];

  for (const [sourceType, patterns] of Object.entries(SOURCE_SIGNATURES)) {
    if (patterns.some(p => p.test(page.text))) {
      types.push(sourceType as SourceType);
    }
  }

  return {
    types,
    sheetRef: extractSheetRef(page),
    format: detectFormat([page], [page.pageNumber]),
  };
}
