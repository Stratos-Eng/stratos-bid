/**
 * Signage Schedule Parser for Signage Extraction
 *
 * Parses dedicated signage schedules - the best source when available.
 * These explicitly list sign types, quantities, and locations.
 *
 * Common formats:
 * - Sign Type | Description | Quantity | Locations
 * - Sign Code + Description with qty in separate column
 * - Legend format with symbols
 */

import type { ParsedPage } from '../../pdf-parser';
import type {
  SignageScheduleEntry,
  SignageEntry,
  ParseResult,
  SourceFormat,
} from '../types';

// ============================================================================
// Sign Type Patterns
// ============================================================================

/**
 * Common sign type code patterns across different projects.
 */
const SIGN_TYPE_PATTERNS = [
  /^(TS[-\s]?\d{1,2})/i,           // Tactile Sign: TS-01, TS-1
  /^(RS[-\s]?\d{1,2})/i,           // Room Sign: RS-01
  /^(RR[-\s]?\d{1,2})/i,           // Restroom: RR-01
  /^(EX[-\s]?\d{1,2})/i,           // Exit: EX-01
  /^(IS[-\s]?\d{1,2})/i,           // ISA/Accessible: IS-01
  /^(WS[-\s]?\d{1,2})/i,           // Wayfinding: WS-01
  /^(DS[-\s]?\d{1,2})/i,           // Directory Sign: DS-01
  /^(PS[-\s]?\d{1,2})/i,           // Parking Sign: PS-01
  /^([A-Z]{1,3}[-\s]?\d{1,3})/,   // Generic: XX-00
];

/**
 * Sign description keywords.
 */
const SIGN_DESCRIPTION_KEYWORDS = [
  /tactile/i,
  /braille/i,
  /exit/i,
  /room\s*id/i,
  /restroom/i,
  /accessible/i,
  /ada/i,
  /wayfinding/i,
  /directional/i,
  /identification/i,
  /warning/i,
  /caution/i,
  /notice/i,
];

// ============================================================================
// Table Parsing
// ============================================================================

/**
 * Parse a tabular signage schedule.
 */
function parseTabularSignageSchedule(text: string): SignageScheduleEntry[] {
  const entries: SignageScheduleEntry[] = [];
  const lines = text.split('\n');

  // Find header to understand columns
  const headerIndex = lines.findIndex(line =>
    (/sign\s*(?:type|code)/i.test(line) && /(?:desc|qty|quantity)/i.test(line)) ||
    /(?:type|code)\s+(?:description|desc)/i.test(line)
  );

  if (headerIndex === -1) {
    // No clear header - try pattern matching
    return parseWithoutHeader(text);
  }

  // Parse lines after header
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < 3) continue;

    // Try to match sign type pattern at start of line
    let signType: string | null = null;
    for (const pattern of SIGN_TYPE_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        signType = match[1];
        break;
      }
    }

    if (!signType) continue;

    // Parse rest of line
    const afterType = line.slice(signType.length).trim();

    // Try to extract quantity (look for standalone number)
    const qtyMatch = afterType.match(/\s(\d{1,3})\s/);
    const quantity = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;

    // Extract description (text before quantity or end)
    const descEnd = qtyMatch ? afterType.indexOf(qtyMatch[0]) : afterType.length;
    const description = afterType.slice(0, descEnd).trim();

    // Extract locations (text after quantity if any)
    const locationsText = qtyMatch
      ? afterType.slice(afterType.indexOf(qtyMatch[0]) + qtyMatch[0].length)
      : '';
    const locations = parseLocations(locationsText);

    if (description) {
      entries.push({
        signType,
        description,
        quantity,
        locations,
      });
    }
  }

  return entries;
}

/**
 * Parse signage schedule without clear header structure.
 */
function parseWithoutHeader(text: string): SignageScheduleEntry[] {
  const entries: SignageScheduleEntry[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    // Look for sign type patterns anywhere in line
    for (const pattern of SIGN_TYPE_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        const signType = match[1];
        const afterType = line.slice(line.indexOf(signType) + signType.length).trim();

        // Look for descriptive keywords
        const hasDescription = SIGN_DESCRIPTION_KEYWORDS.some(kw => kw.test(afterType));
        if (!hasDescription && afterType.length < 10) continue;

        // Extract quantity
        const qtyMatch = afterType.match(/(?:qty|quantity)?[:\s]*(\d{1,3})/i);
        const quantity = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;

        // Clean description
        const description = afterType
          .replace(/(?:qty|quantity)?[:\s]*\d{1,3}/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (description) {
          entries.push({
            signType,
            description,
            quantity,
            locations: [],
          });
        }
        break;
      }
    }
  }

  return entries;
}

/**
 * Parse location text into array of location strings.
 */
function parseLocations(text: string): string[] {
  if (!text.trim()) return [];

  // Split on common delimiters
  const raw = text.split(/[,;]|\band\b/i);

  return raw
    .map(loc => loc.trim())
    .filter(loc => loc.length > 0 && !/^\d+$/.test(loc));
}

// ============================================================================
// Legend/Symbol Parsing
// ============================================================================

/**
 * Parse a legend-style signage schedule (symbols with descriptions).
 */
function parseLegendSchedule(text: string): SignageScheduleEntry[] {
  const entries: SignageScheduleEntry[] = [];

  // Pattern: Symbol/Code followed by description
  const legendPatterns = [
    /([A-Z]{1,3}[-\s]?\d{1,2})\s*[-:=]\s*(.+)/gm,
    /(?:symbol|type)\s*[:\s]+([A-Z0-9-]+)\s*[-:=]?\s*(.+)/gim,
  ];

  for (const pattern of legendPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const signType = match[1].trim();
      const description = match[2].trim();

      // Skip if description doesn't look like a sign
      if (!SIGN_DESCRIPTION_KEYWORDS.some(kw => kw.test(description))) {
        continue;
      }

      entries.push({
        signType,
        description,
        quantity: 1, // Legend items typically don't have quantity
        locations: [],
      });
    }
  }

  return entries;
}

// ============================================================================
// Entry Conversion
// ============================================================================

/**
 * Convert SignageScheduleEntry to unified SignageEntry format.
 */
function convertToSignageEntry(
  entry: SignageScheduleEntry,
  index: number,
  pageNumbers: number[],
  sheetRefs: string[]
): SignageEntry {
  return {
    id: `signage-${entry.signType}-${index}`,
    identifier: entry.signType,
    name: entry.description,
    signTypeCode: entry.signType,
    quantity: entry.quantity,
    isGrouped: entry.quantity > 1,
    source: 'signage_schedule',
    sheetRefs,
    pageNumbers,
    confidence: 0.95, // Signage schedules are most reliable
    notes: entry.locations.length > 0
      ? `Locations: ${entry.locations.join(', ')}`
      : undefined,
  };
}

// ============================================================================
// Main Parse Function
// ============================================================================

/**
 * Parse signage schedule pages and extract entries.
 *
 * @param pages - All parsed pages from document
 * @param pageNumbers - Specific pages containing signage schedule
 * @returns Parse result with signage entries
 */
export function parseSignageSchedule(
  pages: ParsedPage[],
  pageNumbers: number[]
): ParseResult {
  const relevantPages = pages.filter(p => pageNumbers.includes(p.pageNumber));
  const allText = relevantPages.map(p => p.text).join('\n');

  // Detect format and parse
  const format = detectSignageFormat(allText);
  let rawEntries: SignageScheduleEntry[] = [];

  if (format === 'tabular') {
    rawEntries = parseTabularSignageSchedule(allText);
  } else if (format === 'list') {
    rawEntries = parseLegendSchedule(allText);
  } else {
    // Try all parsing methods
    rawEntries = [
      ...parseTabularSignageSchedule(allText),
      ...parseLegendSchedule(allText),
    ];
    // Deduplicate by sign type
    rawEntries = deduplicateBySignType(rawEntries);
  }

  // Extract sheet refs
  const sheetRefs = extractSheetRefs(relevantPages);

  // Convert to unified format
  const entries = rawEntries.map((entry, index) =>
    convertToSignageEntry(entry, index, pageNumbers, sheetRefs)
  );

  // Calculate total quantity
  const totalCount = rawEntries.reduce((sum, e) => sum + e.quantity, 0);

  return {
    entries,
    source: 'signage_schedule',
    pagesParsed: pageNumbers,
    confidence: entries.length > 0 ? 0.95 : 0.30,
    warnings: generateWarnings(rawEntries, totalCount),
    rawCount: rawEntries.length,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Detect the format of the signage schedule.
 */
function detectSignageFormat(text: string): SourceFormat {
  // Check for tabular indicators
  const hasTableHeader = /sign\s*(?:type|code)\s+(?:desc|description)/i.test(text);
  const hasColumns = /\t/.test(text) || /\s{3,}/.test(text);

  if (hasTableHeader && hasColumns) {
    return 'tabular';
  }

  // Check for legend format
  const hasLegendFormat = /(?:legend|symbol)[:\s]/i.test(text);
  const hasSignDefinitions = /[A-Z]{2}-\d{1,2}\s*[-:=]/.test(text);

  if (hasLegendFormat || hasSignDefinitions) {
    return 'list';
  }

  return 'unknown';
}

/**
 * Deduplicate entries by sign type.
 */
function deduplicateBySignType(entries: SignageScheduleEntry[]): SignageScheduleEntry[] {
  const typeMap = new Map<string, SignageScheduleEntry>();

  for (const entry of entries) {
    const key = entry.signType.toUpperCase().replace(/\s/g, '');
    if (!typeMap.has(key)) {
      typeMap.set(key, entry);
    } else {
      // Merge: keep higher quantity and combine locations
      const existing = typeMap.get(key)!;
      existing.quantity = Math.max(existing.quantity, entry.quantity);
      existing.locations = [...new Set([...existing.locations, ...entry.locations])];
    }
  }

  return Array.from(typeMap.values());
}

/**
 * Extract sheet references from pages.
 */
function extractSheetRefs(pages: ParsedPage[]): string[] {
  const refs: string[] = [];

  for (const page of pages) {
    const match = page.text.match(/(?:sheet|dwg)[:\s]*([A-Z]?\d+\.\d+[A-Z]?)/i);
    if (match) {
      refs.push(match[1].toUpperCase());
    }
  }

  return [...new Set(refs)];
}

/**
 * Generate warnings based on parsing results.
 */
function generateWarnings(
  entries: SignageScheduleEntry[],
  totalCount: number
): string[] {
  const warnings: string[] = [];

  if (entries.length === 0) {
    warnings.push('No sign types found in signage schedule. May need AI extraction.');
  }

  // Check for entries without quantities
  const noQty = entries.filter(e => e.quantity === 1);
  if (noQty.length > entries.length * 0.8) {
    warnings.push('Most entries have quantity=1. May need to verify quantities from drawings.');
  }

  // Check for entries without locations
  const noLoc = entries.filter(e => e.locations.length === 0);
  if (noLoc.length > entries.length * 0.5) {
    warnings.push('Many entries missing location information.');
  }

  return warnings;
}

/**
 * Quick analysis of signage schedule content.
 */
export function analyzeSignageScheduleContent(text: string): {
  estimatedSignTypes: number;
  hasQuantities: boolean;
  hasLocations: boolean;
  signTypeCodes: string[];
} {
  // Count sign type patterns
  const signTypes: string[] = [];
  for (const pattern of SIGN_TYPE_PATTERNS) {
    const matches = text.match(new RegExp(pattern, 'g'));
    if (matches) {
      signTypes.push(...matches);
    }
  }

  const uniqueTypes = [...new Set(signTypes.map(t => t.toUpperCase()))];

  // Check for quantity indicators
  const hasQuantities = /(?:qty|quantity)[:\s]*\d/i.test(text) ||
    /\s\d{1,3}\s+(?:ea|each|pcs|pieces)/i.test(text);

  // Check for location indicators
  const hasLocations = /(?:location|room|at\s)/i.test(text);

  return {
    estimatedSignTypes: uniqueTypes.length,
    hasQuantities,
    hasLocations,
    signTypeCodes: uniqueTypes,
  };
}
