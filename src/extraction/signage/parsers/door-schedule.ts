/**
 * Door Schedule Parser for Signage Extraction
 *
 * Parses door schedules to extract room names associated with doors.
 * Door schedules are the most common source of room information in construction documents.
 *
 * Key challenges:
 * - Grouped entries like "INFUSION BAY 1-3" represent ONE sign, not three
 * - Multiple doors to same room should yield ONE sign
 * - Different formats: tabular, list, embedded in drawings
 */

import type { ParsedPage } from '../../pdf-parser';
import type {
  DoorScheduleEntry,
  SignageEntry,
  ParseResult,
  SourceFormat,
} from '../types';

// ============================================================================
// Grouped Entry Detection
// ============================================================================

/**
 * Detect if a room name represents a grouped entry (e.g., "INFUSION BAY 1-3")
 * Grouped entries get ONE sign, not one per number in the range.
 */
export function detectGroupedEntry(roomName: string): {
  isGrouped: boolean;
  groupRange?: [number, number];
  groupedCount: number;
} {
  // Pattern: text followed by range like "1-3" or "14-17"
  const rangePatterns = [
    /(\d+)\s*[-–—]\s*(\d+)\s*$/,           // "BAY 1-3", "BAY 14-17"
    /(\d+)\s*(?:thru|through|to)\s*(\d+)/i, // "BAY 1 thru 3"
    /(?:bays?|rooms?|units?)\s*(\d+)\s*[-–—]\s*(\d+)/i, // "BAYS 1-3"
  ];

  for (const pattern of rangePatterns) {
    const match = roomName.match(pattern);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);

      // Validate it's a reasonable range
      if (end > start && (end - start) < 20) {
        return {
          isGrouped: true,
          groupRange: [start, end],
          groupedCount: 1, // ONE sign for the group
        };
      }
    }
  }

  return {
    isGrouped: false,
    groupedCount: 1,
  };
}

// ============================================================================
// Room Name Normalization
// ============================================================================

/**
 * Normalize room name for comparison and deduplication.
 */
export function normalizeRoomName(name: string): string {
  return name
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/['"]/g, '')
    .replace(/\(\s*\)/g, '')
    .trim();
}

/**
 * Extract a clean room name from door schedule text.
 */
function cleanRoomName(raw: string): string {
  return raw
    .replace(/^\d+[-.]?\s*/, '')    // Remove leading numbers
    .replace(/\s*\(.*?\)\s*$/, '')  // Remove trailing parenthetical
    .replace(/\s*-\s*$/, '')        // Remove trailing dash
    .trim();
}

// ============================================================================
// Table Parsing
// ============================================================================

/**
 * Parse a tabular door schedule.
 * Expected columns: Door No, Room Name/Description, Room No, Hardware Set, etc.
 */
function parseTabularSchedule(text: string): DoorScheduleEntry[] {
  const entries: DoorScheduleEntry[] = [];
  const lines = text.split('\n');

  // Find header line to determine column positions
  const headerIndex = lines.findIndex(line =>
    /door\s*(?:no|#|number)/i.test(line) ||
    /(?:room|mark)\s*(?:name|desc)/i.test(line)
  );

  if (headerIndex === -1) {
    return entries;
  }

  // Parse data lines after header
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Common door schedule patterns
    const patterns = [
      // Pattern: DoorNo  RoomName  RoomNo  Hardware
      /^([A-Z]?\d{3}[-.]?\d{0,2}[A-Z]?)\s+(.+?)\s+(\d{3}[-.]?\d{2,3})\s+/,
      // Pattern: DoorNo  RoomName (no room number)
      /^([A-Z]?\d{3}[-.]?\d{0,2}[A-Z]?)\s{2,}([A-Z][A-Z\s\d-]+)/,
      // Pattern: Simple door/room pair
      /^(\S+)\s{2,}([A-Z][A-Z\s\d-]+)/,
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const doorNumber = match[1];
        const roomName = cleanRoomName(match[2]);
        const roomNumber = match[3] || undefined;

        if (roomName && roomName.length > 2) {
          const groupInfo = detectGroupedEntry(roomName);

          entries.push({
            doorNumber,
            roomName,
            roomNumber,
            signRequired: true, // Assume all doors need signs unless specified
            isGroupedEntry: groupInfo.isGrouped,
            groupedCount: groupInfo.groupedCount,
          });
          break;
        }
      }
    }
  }

  return entries;
}

/**
 * Parse a list-format door schedule.
 */
function parseListSchedule(text: string): DoorScheduleEntry[] {
  const entries: DoorScheduleEntry[] = [];

  // Pattern for list items
  const listPatterns = [
    /[-•●]\s*(?:Door\s*)?(\S+)[:\s]+(.+)/gi,
    /(\d{3}[-.]?\d{2}[A-Z]?)[:\s]+(.+)/g,
  ];

  for (const pattern of listPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const doorNumber = match[1];
      const roomName = cleanRoomName(match[2]);

      if (roomName && roomName.length > 2) {
        const groupInfo = detectGroupedEntry(roomName);

        entries.push({
          doorNumber,
          roomName,
          signRequired: true,
          isGroupedEntry: groupInfo.isGrouped,
          groupedCount: groupInfo.groupedCount,
        });
      }
    }
  }

  return entries;
}

// ============================================================================
// Sign Requirement Detection
// ============================================================================

/**
 * Determine if a door entry requires signage.
 * Some doors (mechanical, electrical closets) may not need room signs.
 */
function requiresSignage(entry: DoorScheduleEntry): boolean {
  const noSignPatterns = [
    /^(?:mech|mechanical)\s*(?:room|closet|rm)?$/i,
    /^(?:elec|electrical)\s*(?:room|closet|rm)?$/i,
    /^shaft$/i,
    /^chase$/i,
    /^(?:tel|telecom)\s*(?:room|closet)?$/i,
    /^riser$/i,
    /^plenum$/i,
  ];

  return !noSignPatterns.some(p => p.test(entry.roomName));
}

// ============================================================================
// Deduplication
// ============================================================================

/**
 * Deduplicate entries by room.
 * Multiple doors to the same room should result in ONE sign.
 */
function deduplicateByRoom(entries: DoorScheduleEntry[]): DoorScheduleEntry[] {
  const roomMap = new Map<string, DoorScheduleEntry>();

  for (const entry of entries) {
    // Key by room number if available, otherwise by normalized name
    const key = entry.roomNumber || normalizeRoomName(entry.roomName);

    if (!roomMap.has(key)) {
      roomMap.set(key, entry);
    }
    // If duplicate, keep the first one (could track all door numbers if needed)
  }

  return Array.from(roomMap.values());
}

// ============================================================================
// Main Parse Function
// ============================================================================

/**
 * Parse door schedule pages and extract signage entries.
 *
 * @param pages - All parsed pages from document
 * @param pageNumbers - Specific pages containing door schedule
 * @returns Parse result with signage entries
 */
export function parseDoorSchedule(
  pages: ParsedPage[],
  pageNumbers: number[]
): ParseResult {
  const relevantPages = pages.filter(p => pageNumbers.includes(p.pageNumber));
  const allText = relevantPages.map(p => p.text).join('\n');

  // Detect format and parse accordingly
  const format = detectScheduleFormat(allText);
  let rawEntries: DoorScheduleEntry[];

  if (format === 'tabular') {
    rawEntries = parseTabularSchedule(allText);
  } else if (format === 'list') {
    rawEntries = parseListSchedule(allText);
  } else {
    // Unknown format - try both and combine
    rawEntries = [
      ...parseTabularSchedule(allText),
      ...parseListSchedule(allText),
    ];
  }

  // Filter to only entries requiring signage
  const signageRequired = rawEntries.filter(requiresSignage);

  // Deduplicate by room
  const deduped = deduplicateByRoom(signageRequired);

  // Convert to SignageEntry format
  const entries: SignageEntry[] = deduped.map((entry, index) => ({
    id: `door-${entry.roomNumber || entry.doorNumber}-${index}`,
    identifier: entry.roomNumber || entry.doorNumber,
    name: entry.roomName,
    roomNumber: entry.roomNumber,
    quantity: entry.groupedCount,
    isGrouped: entry.isGroupedEntry,
    source: 'door_schedule' as const,
    sheetRefs: extractSheetRefs(relevantPages),
    pageNumbers,
    confidence: format === 'tabular' ? 0.85 : 0.70,
    notes: entry.isGroupedEntry ? 'Grouped entry from door schedule' : undefined,
  }));

  return {
    entries,
    source: 'door_schedule',
    pagesParsed: pageNumbers,
    confidence: entries.length > 0 ? (format === 'tabular' ? 0.85 : 0.70) : 0.30,
    warnings: generateWarnings(rawEntries, deduped, format),
    rawCount: rawEntries.length,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Detect the format of the door schedule.
 */
function detectScheduleFormat(text: string): SourceFormat {
  // Check for table-like structure
  const hasColumns = /\s{3,}/.test(text); // Multiple spaces between columns
  const hasHeader = /door\s*(?:no|#|number)/i.test(text);
  const hasTabularData = /^\s*\d{3}[-.]?\d{0,2}\s+[A-Z]/m.test(text);

  if (hasHeader && hasTabularData) {
    return 'tabular';
  }

  // Check for list structure
  const hasBullets = /^[-•●]\s/m.test(text);
  const hasNumberedList = /^\d+\.\s/m.test(text);

  if (hasBullets || hasNumberedList) {
    return 'list';
  }

  return 'unknown';
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
  rawEntries: DoorScheduleEntry[],
  dedupedEntries: DoorScheduleEntry[],
  format: SourceFormat
): string[] {
  const warnings: string[] = [];

  if (rawEntries.length === 0) {
    warnings.push('No door entries found in schedule. May require AI extraction.');
  }

  const duplicatesRemoved = rawEntries.length - dedupedEntries.length;
  if (duplicatesRemoved > 0) {
    warnings.push(`Removed ${duplicatesRemoved} duplicate entries (multiple doors to same room).`);
  }

  if (format === 'unknown') {
    warnings.push('Door schedule format not recognized. Results may be incomplete.');
  }

  const groupedCount = dedupedEntries.filter(e => e.isGroupedEntry).length;
  if (groupedCount > 0) {
    warnings.push(`Found ${groupedCount} grouped entries (e.g., "BAY 1-3" = 1 sign).`);
  }

  return warnings;
}

/**
 * Quick analysis of door schedule content without full parsing.
 * Useful for validation.
 */
export function analyzeDoorScheduleContent(text: string): {
  estimatedDoorCount: number;
  hasGroupedEntries: boolean;
  format: SourceFormat;
  columnHeaders: string[];
} {
  const format = detectScheduleFormat(text);

  // Count door number patterns
  const doorPatterns = text.match(/\b\d{3}[-.]?\d{0,2}[A-Z]?\b/g) || [];

  // Check for grouped entries
  const groupedPatterns = text.match(/\d+\s*[-–—]\s*\d+/g) || [];

  // Extract column headers
  const headerLine = text.split('\n').find(line =>
    /door\s*(?:no|#|number)/i.test(line)
  );
  const columnHeaders = headerLine
    ? headerLine.split(/\s{2,}/).map(h => h.trim()).filter(Boolean)
    : [];

  return {
    estimatedDoorCount: doorPatterns.length,
    hasGroupedEntries: groupedPatterns.length > 0,
    format,
    columnHeaders,
  };
}
