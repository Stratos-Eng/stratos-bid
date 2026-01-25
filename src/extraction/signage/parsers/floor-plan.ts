/**
 * Floor Plan Extractor for Signage Extraction
 *
 * Extracts room tags from floor plans as a fallback source.
 * Lower confidence than schedules because:
 * - Same room may appear on multiple sheets
 * - Room tags may be partial or abbreviated
 * - Requires deduplication across sheets
 */

import type { ParsedPage } from '../../pdf-parser';
import type {
  FloorPlanEntry,
  SignageEntry,
  ParseResult,
  RoomNumberPattern,
} from '../types';

// ============================================================================
// Room Tag Patterns
// ============================================================================

/**
 * Patterns for detecting room tags on floor plans.
 * Different projects use different conventions.
 */
const ROOM_TAG_PATTERNS: RoomNumberPattern[] = [
  {
    pattern: /(\d{3}-\d{2}[A-Z]?)/g,
    name: 'floor-room',
    example: '214-03',
  },
  {
    pattern: /([A-Z]\d{3}[A-Z]?)/g,
    name: 'building-room',
    example: 'B201',
  },
  {
    pattern: /([A-Z]\d-\d{3})/g,
    name: 'level-room',
    example: 'L2-105',
  },
  {
    pattern: /(?:ROOM|RM)\s*#?\s*(\d{3,4}[A-Z]?)/gi,
    name: 'simple-prefix',
    example: 'ROOM 101',
  },
  {
    pattern: /(\d{4,5}[A-Z]?)/g,
    name: 'long-number',
    example: '12345',
  },
];

/**
 * Common room name patterns (name followed by number).
 */
const ROOM_NAME_PATTERNS = [
  // Standard room types
  /(?:OFFICE|OFF)\s*(\d+[A-Z]?)/gi,
  /(?:CONFERENCE|CONF)\s*(?:ROOM|RM)?\s*(\d+[A-Z]?)/gi,
  /(?:STORAGE|STOR)\s*(\d+[A-Z]?)?/gi,
  /(?:RESTROOM|TOILET|TLT|RR)\s*(\d+[A-Z]?)?/gi,
  /(?:CORRIDOR|CORR|HALL)\s*(\d+[A-Z]?)?/gi,
  /(?:LOBBY)\s*(\d+[A-Z]?)?/gi,
  /(?:MECHANICAL|MECH)\s*(\d+[A-Z]?)?/gi,
  /(?:ELECTRICAL|ELEC)\s*(\d+[A-Z]?)?/gi,
  /(?:JANITOR|JAN)\s*(\d+[A-Z]?)?/gi,
  /(?:STAIR)\s*(\d+[A-Z]?)?/gi,
  /(?:ELEVATOR|ELEV)\s*(\d+[A-Z]?)?/gi,

  // Healthcare specific (but common)
  /(?:EXAM)\s*(?:ROOM|RM)?\s*(\d+[A-Z]?)/gi,
  /(?:PATIENT)\s*(?:ROOM|RM)?\s*(\d+[A-Z]?)/gi,
  /(?:NURSE)\s*(?:STATION|STA)?\s*(\d+[A-Z]?)?/gi,
  /(?:WAITING)\s*(?:ROOM|RM|AREA)?\s*(\d+[A-Z]?)?/gi,
  /(?:LAB|LABORATORY)\s*(\d+[A-Z]?)?/gi,

  // Commercial
  /(?:RETAIL)\s*(\d+[A-Z]?)?/gi,
  /(?:SUITE)\s*(\d+[A-Z]?)/gi,
  /(?:UNIT)\s*(\d+[A-Z]?)/gi,

  // Generic with room number
  /([A-Z][A-Z\s]{2,20})\s+(?:\d{3}[-.]?\d{0,2})/g,
];

/**
 * Patterns to exclude (not actual rooms needing signs).
 */
const EXCLUDE_PATTERNS = [
  /^(?:SHAFT|CHASE|PLENUM|RISER|DUCT)$/i,
  /^(?:VOID|OPEN\s*TO\s*BELOW|OTB)$/i,
  /^(?:EXISTING|EXIST|E\.)$/i,
  /^(?:NEW|N\.)$/i,
  /^(?:DEMO|DEMOLISH)$/i,
  /(?:NOT\s*IN\s*(?:CONTRACT|SCOPE))/i,
  /(?:BY\s*OTHERS)/i,
];

// ============================================================================
// Room Tag Extraction
// ============================================================================

/**
 * Extract room tags from a single page.
 */
function extractRoomTagsFromPage(
  page: ParsedPage
): { roomNumber: string; roomName: string; context: string }[] {
  const results: { roomNumber: string; roomName: string; context: string }[] = [];
  const text = page.text;

  // Try each room tag pattern
  for (const { pattern, name } of ROOM_TAG_PATTERNS) {
    // Reset pattern state
    pattern.lastIndex = 0;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const roomNumber = match[1] || match[0];

      // Get context around the match (for room name)
      const startIdx = Math.max(0, match.index - 50);
      const endIdx = Math.min(text.length, match.index + match[0].length + 50);
      const context = text.slice(startIdx, endIdx);

      // Try to extract room name from context
      const roomName = extractRoomNameFromContext(context, roomNumber);

      if (roomName && !isExcluded(roomName)) {
        results.push({
          roomNumber,
          roomName,
          context: context.replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }

  // Also try room name patterns directly
  for (const pattern of ROOM_NAME_PATTERNS) {
    pattern.lastIndex = 0;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const fullMatch = match[0];
      const number = match[1] || '';

      // Clean up the room name
      const roomName = fullMatch
        .replace(/\d+[A-Z]?$/, '')
        .replace(/(?:ROOM|RM)$/i, '')
        .trim();

      if (roomName.length > 2 && !isExcluded(roomName)) {
        results.push({
          roomNumber: number || fullMatch,
          roomName: roomName.toUpperCase(),
          context: fullMatch,
        });
      }
    }
  }

  return results;
}

/**
 * Extract room name from context around a room number.
 */
function extractRoomNameFromContext(context: string, roomNumber: string): string | null {
  // Common patterns: "ROOM NAME \n 123-45" or "123-45 ROOM NAME"
  const patterns = [
    // Name before number
    new RegExp(`([A-Z][A-Z\\s]{2,25})\\s*${escapeRegex(roomNumber)}`, 'i'),
    // Name after number
    new RegExp(`${escapeRegex(roomNumber)}\\s*([A-Z][A-Z\\s]{2,25})`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = context.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim().toUpperCase();
      if (name.length > 2 && !isExcluded(name)) {
        return name;
      }
    }
  }

  return null;
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a room name should be excluded.
 */
function isExcluded(name: string): boolean {
  return EXCLUDE_PATTERNS.some(p => p.test(name));
}

// ============================================================================
// Sheet Reference Extraction
// ============================================================================

/**
 * Extract sheet reference from page text.
 */
function extractSheetRef(page: ParsedPage): string | null {
  const patterns = [
    /(?:SHEET|DWG)[:\s]*([A-Z]?\d+\.\d+[A-Z]?)/i,
    /^([A-Z]\d+\.\d+[A-Z]?)\s/m,
    /([A-Z]\d+\.\d+[A-Z]?)\s*$/m,
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
// Deduplication
// ============================================================================

/**
 * Deduplicate floor plan entries.
 * Same room appearing on multiple sheets = one sign.
 */
function deduplicateEntries(
  entries: FloorPlanEntry[]
): { unique: FloorPlanEntry[]; duplicatesRemoved: number } {
  const roomMap = new Map<string, FloorPlanEntry>();

  for (const entry of entries) {
    // Key by room number if available, otherwise by normalized name
    const key = entry.roomNumber || normalizeRoomName(entry.roomName);

    if (!roomMap.has(key)) {
      roomMap.set(key, entry);
    } else {
      // Merge sheet refs
      const existing = roomMap.get(key)!;
      if (entry.sheetRef && !existing.sheetRef.includes(entry.sheetRef)) {
        existing.sheetRef += `, ${entry.sheetRef}`;
      }
    }
  }

  return {
    unique: Array.from(roomMap.values()),
    duplicatesRemoved: entries.length - roomMap.size,
  };
}

/**
 * Normalize room name for comparison.
 */
function normalizeRoomName(name: string): string {
  return name
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/['"]/g, '')
    .trim();
}

// ============================================================================
// Main Extract Function
// ============================================================================

/**
 * Extract room information from floor plan pages.
 *
 * @param pages - All parsed pages from document
 * @param pageNumbers - Specific pages containing floor plans
 * @returns Parse result with signage entries
 */
export function extractFromFloorPlans(
  pages: ParsedPage[],
  pageNumbers: number[]
): ParseResult {
  const relevantPages = pages.filter(p => pageNumbers.includes(p.pageNumber));

  // Extract from each page
  const allEntries: FloorPlanEntry[] = [];

  for (const page of relevantPages) {
    const sheetRef = extractSheetRef(page) || `Page ${page.pageNumber}`;
    const tags = extractRoomTagsFromPage(page);

    for (const tag of tags) {
      allEntries.push({
        roomName: tag.roomName,
        roomNumber: tag.roomNumber,
        sheetRef,
        pageNumber: page.pageNumber,
      });
    }
  }

  // Deduplicate
  const { unique, duplicatesRemoved } = deduplicateEntries(allEntries);

  // Convert to SignageEntry format
  const entries: SignageEntry[] = unique.map((entry, index) => ({
    id: `floor-${entry.roomNumber || entry.roomName}-${index}`,
    identifier: entry.roomNumber || entry.roomName,
    name: entry.roomName,
    roomNumber: entry.roomNumber,
    quantity: 1,
    isGrouped: false,
    source: 'floor_plan' as const,
    sheetRefs: [entry.sheetRef],
    pageNumbers: [entry.pageNumber],
    confidence: 0.50, // Floor plans are lowest confidence
    notes: 'Extracted from floor plan room tags',
  }));

  return {
    entries,
    source: 'floor_plan',
    pagesParsed: pageNumbers,
    confidence: entries.length > 0 ? 0.50 : 0.20,
    warnings: generateWarnings(allEntries, unique, duplicatesRemoved),
    rawCount: allEntries.length,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate warnings based on extraction results.
 */
function generateWarnings(
  rawEntries: FloorPlanEntry[],
  uniqueEntries: FloorPlanEntry[],
  duplicatesRemoved: number
): string[] {
  const warnings: string[] = [];

  if (rawEntries.length === 0) {
    warnings.push('No room tags found in floor plans. Document may need AI extraction.');
  }

  if (duplicatesRemoved > 0) {
    warnings.push(`Removed ${duplicatesRemoved} duplicate entries (same room on multiple sheets).`);
  }

  // Check for potential issues
  const noRoomNumbers = uniqueEntries.filter(e => !e.roomNumber);
  if (noRoomNumbers.length > uniqueEntries.length * 0.3) {
    warnings.push('Many rooms without identifiable room numbers. Deduplication may be incomplete.');
  }

  // Warn about floor plan confidence
  warnings.push('Floor plan extraction has lower confidence. Cross-verify with door/signage schedules if available.');

  return warnings;
}

/**
 * Detect the dominant room number pattern in the document.
 */
export function detectRoomNumberPattern(text: string): RoomNumberPattern | null {
  let bestPattern: RoomNumberPattern | null = null;
  let maxMatches = 0;

  for (const pattern of ROOM_TAG_PATTERNS) {
    // Reset pattern state
    pattern.pattern.lastIndex = 0;

    const matches = text.match(pattern.pattern);
    const count = matches ? matches.length : 0;

    if (count > maxMatches) {
      maxMatches = count;
      bestPattern = pattern;
    }
  }

  // Only return if we have meaningful coverage
  if (maxMatches > 5) {
    return bestPattern;
  }

  return null;
}

/**
 * Quick analysis of floor plan content.
 */
export function analyzeFloorPlanContent(text: string): {
  estimatedRoomCount: number;
  dominantPattern: string | null;
  hasRoomNumbers: boolean;
  hasRoomNames: boolean;
} {
  // Count room tag matches
  let totalMatches = 0;
  let dominantPattern: string | null = null;
  let maxMatches = 0;

  for (const pattern of ROOM_TAG_PATTERNS) {
    pattern.pattern.lastIndex = 0;
    const matches = text.match(pattern.pattern);
    const count = matches ? matches.length : 0;
    totalMatches += count;

    if (count > maxMatches) {
      maxMatches = count;
      dominantPattern = pattern.name;
    }
  }

  // Check for room name patterns
  const hasRoomNames = ROOM_NAME_PATTERNS.some(p => {
    p.lastIndex = 0;
    return p.test(text);
  });

  return {
    estimatedRoomCount: Math.ceil(totalMatches / 2), // Rough estimate (each room may match multiple times)
    dominantPattern,
    hasRoomNumbers: totalMatches > 0,
    hasRoomNames,
  };
}
