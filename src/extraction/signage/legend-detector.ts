/**
 * Legend Detection for Signage Extraction
 *
 * Finds sign legend/schedule pages and extracts symbol definitions.
 * This is Pass 1 of the two-pass extraction process.
 */

import { db } from '@/db';
import { documents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ParsedPage } from '../pdf-parser';

export interface SymbolDefinition {
  symbol: string;           // e.g., "TS-01", "RR", "FA"
  description: string;      // e.g., "Tactile Exit Sign 'EXIT ROUTE'"
  detailReference?: string; // e.g., "5/GEN-5", "L/AG.3"
}

export interface LegendDetectionResult {
  found: boolean;
  legendPages: number[];           // Page numbers containing legend
  sheetNumbers: string[];          // Sheet numbers (e.g., "GEN-5", "AG.3")
  symbols: SymbolDefinition[];     // Extracted symbol definitions
  confidence: number;              // 0-1 confidence in detection
  rawMatches: string[];            // Raw text matches for debugging
}

// Patterns that indicate a legend page
const LEGEND_PAGE_PATTERNS = [
  /sign\s*(age)?\s*legend/i,
  /sign\s*(age)?\s*schedule/i,
  /symbol\s*legend/i,
  /signage\s*symbols/i,
  /sign\s*types?:/i,
];

// Patterns for symbol definitions (symbol : description)
const SYMBOL_DEFINITION_PATTERNS = [
  // "TS-01 : TACTILE EXIT SIGN" or "TS-01 = TACTILE EXIT SIGN"
  // Non-greedy, stops at newline or next symbol
  /([A-Z]{1,3}-\d{1,2})\s*[=:]\s*([A-Z][A-Z\s\-"']{3,50}?)(?=\n|$|[A-Z]{1,3}-\d)/g,
  // "RR RESTROOM SIGN" (two-letter code followed by description)
  /\b([A-Z]{2})\s+((?:RESTROOM|EXIT|FIRE|ROOM|DOOR|ACCESSIBLE|TACTILE|SPRINKLER)[A-Z\s\-"']{3,40}?(?:SIGN|SIGNAGE)?)(?=\n|$)/gi,
];

// Pattern for detail references like "5 / GEN-5" or "detail L/AG.3"
const DETAIL_REFERENCE_PATTERN = /(\d+)\s*\/\s*([A-Z]{2,4}-?\d+(?:\.\d+)?)/gi;

// Pattern to extract sheet numbers from title blocks
// Must have letters AND numbers to avoid matching "CD" etc.
const SHEET_NUMBER_PATTERNS = [
  /\b(GEN-\d+)\b/gi,           // GEN-5
  /\b(AG\.\d+)\b/gi,           // AG.3
  /\b(LS\d+\.\d+)\b/gi,        // LS2.2
  /\b(A\d+\.\d+)\b/gi,         // A2.1
  /\b([A-Z]{1,2}\d+\.\d+)\b/gi, // Generic: E1.1, M2.3
];

/**
 * Detect if a page is likely a sign legend page
 */
export function isLegendPage(pageText: string): { isLegend: boolean; confidence: number; matches: string[] } {
  const matches: string[] = [];
  let score = 0;

  // Check for explicit legend indicators
  for (const pattern of LEGEND_PAGE_PATTERNS) {
    const match = pageText.match(pattern);
    if (match) {
      matches.push(match[0]);
      score += 0.4;
    }
  }

  // Check for symbol definition patterns
  for (const pattern of SYMBOL_DEFINITION_PATTERNS) {
    const patternMatches = pageText.matchAll(new RegExp(pattern.source, pattern.flags));
    const matchArray = Array.from(patternMatches);
    if (matchArray.length >= 2) {
      // Multiple symbol definitions = likely legend
      score += 0.3;
      matches.push(...matchArray.slice(0, 3).map(m => m[0]));
    }
  }

  // Check for detail references
  const detailMatches = pageText.matchAll(DETAIL_REFERENCE_PATTERN);
  const detailArray = Array.from(detailMatches);
  if (detailArray.length >= 2) {
    score += 0.2;
    matches.push(...detailArray.slice(0, 2).map(m => m[0]));
  }

  // Bonus for sign-related keywords density
  const signKeywords = (pageText.match(/\b(sign|tactile|braille|exit|restroom|ada)\b/gi) || []).length;
  if (signKeywords >= 5) {
    score += 0.1;
  }

  return {
    isLegend: score >= 0.4,
    confidence: Math.min(score, 1.0),
    matches,
  };
}

/**
 * Extract symbol definitions from a legend page
 */
export function extractSymbolDefinitions(pageText: string): SymbolDefinition[] {
  const symbols: SymbolDefinition[] = [];
  const seen = new Set<string>();

  // Extract symbol : description patterns
  for (const pattern of SYMBOL_DEFINITION_PATTERNS) {
    const matches = pageText.matchAll(new RegExp(pattern.source, pattern.flags));
    for (const match of matches) {
      const symbol = match[1].toUpperCase().trim();
      const description = match[2].trim();

      // Skip if already seen or too short
      if (seen.has(symbol) || description.length < 3) continue;
      seen.add(symbol);

      // Look for associated detail reference
      const contextStart = Math.max(0, match.index! - 50);
      const contextEnd = Math.min(pageText.length, match.index! + match[0].length + 50);
      const context = pageText.slice(contextStart, contextEnd);

      const detailMatch = context.match(/(\d+)\s*\/\s*([A-Z]{2,4}-?\d+(?:\.\d+)?)/i);

      symbols.push({
        symbol,
        description: cleanDescription(description),
        detailReference: detailMatch ? `${detailMatch[1]}/${detailMatch[2]}` : undefined,
      });
    }
  }

  return symbols;
}

/**
 * Extract sheet number from page text (usually in title block)
 */
export function extractSheetNumber(pageText: string): string | null {
  // Check last 500 chars (title block usually at bottom)
  const titleBlockArea = pageText.slice(-500);

  for (const pattern of SHEET_NUMBER_PATTERNS) {
    const matches = titleBlockArea.matchAll(new RegExp(pattern.source, pattern.flags));
    const matchArray = Array.from(matches);
    if (matchArray.length > 0) {
      // Return the last match (most likely the actual sheet number)
      return matchArray[matchArray.length - 1][1];
    }
  }

  return null;
}

/**
 * Clean up extracted description text
 */
function cleanDescription(text: string): string {
  return text
    .replace(/\s+/g, ' ')           // Normalize whitespace
    .replace(/["\u201C\u201D]/g, '"') // Normalize quotes
    .replace(/\s*-\s*/g, ' - ')     // Normalize dashes
    .trim();
}

/**
 * Main function: Detect legend pages and extract symbol definitions
 *
 * @param pages - Array of parsed PDF pages
 * @param maxPagesToScan - How many pages to scan (default: first 20)
 */
export function detectSignageLegend(
  pages: ParsedPage[],
  maxPagesToScan: number = 20
): LegendDetectionResult {
  const result: LegendDetectionResult = {
    found: false,
    legendPages: [],
    sheetNumbers: [],
    symbols: [],
    confidence: 0,
    rawMatches: [],
  };

  // Scan first N pages for legend
  const pagesToScan = pages.slice(0, maxPagesToScan);

  for (const page of pagesToScan) {
    const detection = isLegendPage(page.text);

    if (detection.isLegend) {
      result.found = true;
      result.legendPages.push(page.pageNumber);
      result.rawMatches.push(...detection.matches);
      result.confidence = Math.max(result.confidence, detection.confidence);

      // Extract sheet number
      const sheetNum = extractSheetNumber(page.text);
      if (sheetNum && !result.sheetNumbers.includes(sheetNum)) {
        result.sheetNumbers.push(sheetNum);
      }

      // Extract symbol definitions
      const symbols = extractSymbolDefinitions(page.text);
      for (const sym of symbols) {
        // Avoid duplicates
        if (!result.symbols.find(s => s.symbol === sym.symbol)) {
          result.symbols.push(sym);
        }
      }
    }
  }

  return result;
}

/**
 * Quick check if document likely has signage legend
 * (faster than full detection - for filtering)
 */
export function hasSignageLegendIndicators(fullText: string): boolean {
  // Quick regex check on full document text
  const indicators = [
    /sign\s*legend/i,
    /signage\s*schedule/i,
    /[A-Z]{2}-\d{2}\s*:/,  // Symbol code pattern
    /tactile.*sign/i,
  ];

  return indicators.some(pattern => pattern.test(fullText));
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Save legend detection result to document record
 */
export async function saveSignageLegend(
  documentId: string,
  legend: LegendDetectionResult
): Promise<void> {
  // Don't store rawMatches in DB (debugging only)
  const { rawMatches, ...legendData } = legend;

  await db
    .update(documents)
    .set({ signageLegend: legendData })
    .where(eq(documents.id, documentId));
}

/**
 * Retrieve legend data from document record
 */
export async function getSignageLegend(
  documentId: string
): Promise<LegendDetectionResult | null> {
  const [doc] = await db
    .select({ signageLegend: documents.signageLegend })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc?.signageLegend) return null;

  // Type assertion - we know the structure from saveSignageLegend
  const legend = doc.signageLegend as Omit<LegendDetectionResult, 'rawMatches'>;

  return {
    ...legend,
    rawMatches: [], // Not stored in DB
  };
}

/**
 * Get symbol definition by code from document's legend
 */
export async function getSymbolDefinition(
  documentId: string,
  symbolCode: string
): Promise<SymbolDefinition | null> {
  const legend = await getSignageLegend(documentId);
  if (!legend?.symbols) return null;

  return legend.symbols.find(
    s => s.symbol.toUpperCase() === symbolCode.toUpperCase()
  ) || null;
}

/**
 * Check if document has legend data
 */
export async function hasSignageLegend(documentId: string): Promise<boolean> {
  const [doc] = await db
    .select({ signageLegend: documents.signageLegend })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  const legend = doc?.signageLegend as LegendDetectionResult | null;
  return legend?.found === true;
}
