/**
 * Deduplication Utilities for Signage Extraction
 *
 * Room numbers are just ONE technique for deduplication.
 * This module handles all dedup strategies:
 * 1. Room number matching (most reliable when available)
 * 2. Name matching (normalized comparison)
 * 3. AI similarity (last resort for complex cases)
 */

import type {
  SignageEntry,
  DeduplicationStrategy,
  DeduplicationResult,
  MergedGroup,
  RoomNumberPattern,
  COMMON_ROOM_NUMBER_PATTERNS,
} from './types';

// ============================================================================
// Room Number Deduplication
// ============================================================================

/**
 * Auto-detect room number pattern from entries.
 * Returns the pattern with best coverage.
 */
export function detectRoomNumberPattern(entries: SignageEntry[]): RegExp | null {
  const patterns = [
    { regex: /(\d{3}-\d{2}[A-Z]?)/g, name: 'floor-room' },
    { regex: /([A-Z]\d{3}[A-Z]?)/g, name: 'building-room' },
    { regex: /([A-Z]\d-\d{3})/g, name: 'level-room' },
    { regex: /(?:ROOM|RM)\s*#?\s*(\d{3,4}[A-Z]?)/gi, name: 'simple-prefix' },
  ];

  let bestPattern: RegExp | null = null;
  let bestCoverage = 0;

  for (const { regex } of patterns) {
    let matches = 0;
    for (const entry of entries) {
      // Check identifier and name
      const combined = `${entry.identifier} ${entry.name} ${entry.roomNumber || ''}`;
      regex.lastIndex = 0;
      if (regex.test(combined)) {
        matches++;
      }
    }

    const coverage = matches / entries.length;
    if (coverage > bestCoverage && coverage > 0.3) { // At least 30% coverage
      bestCoverage = coverage;
      bestPattern = new RegExp(regex.source, regex.flags);
    }
  }

  return bestPattern;
}

/**
 * Extract room number from entry using detected pattern.
 */
function extractRoomNumber(entry: SignageEntry, pattern: RegExp): string | null {
  if (entry.roomNumber) {
    return entry.roomNumber.toUpperCase().trim();
  }

  const combined = `${entry.identifier} ${entry.name}`;
  pattern.lastIndex = 0;
  const match = combined.match(pattern);

  if (match) {
    return match[1].toUpperCase().trim();
  }

  return null;
}

/**
 * Deduplicate entries by room number.
 */
export function deduplicateByRoomNumber(
  entries: SignageEntry[],
  pattern: RegExp
): DeduplicationResult {
  const roomMap = new Map<string, SignageEntry[]>();
  const noRoomNumber: SignageEntry[] = [];

  // Group by room number
  for (const entry of entries) {
    const roomNum = extractRoomNumber(entry, pattern);

    if (roomNum) {
      const existing = roomMap.get(roomNum) || [];
      existing.push(entry);
      roomMap.set(roomNum, existing);
    } else {
      noRoomNumber.push(entry);
    }
  }

  // Merge groups
  const uniqueEntries: SignageEntry[] = [];
  const mergedGroups: MergedGroup[] = [];

  for (const [roomNum, group] of roomMap.entries()) {
    if (group.length === 1) {
      uniqueEntries.push(group[0]);
    } else {
      // Merge duplicates - keep highest confidence entry
      const sorted = group.sort((a, b) => b.confidence - a.confidence);
      const kept = mergeEntries(sorted);
      uniqueEntries.push(kept);

      mergedGroups.push({
        kept,
        merged: sorted.slice(1),
        reason: `Same room number: ${roomNum}`,
      });
    }
  }

  // Add entries without room numbers (can't dedupe)
  uniqueEntries.push(...noRoomNumber);

  return {
    uniqueEntries,
    duplicatesRemoved: entries.length - uniqueEntries.length,
    strategy: 'room_number',
    mergedGroups,
  };
}

// ============================================================================
// Name Matching Deduplication
// ============================================================================

/**
 * Normalize room name for comparison.
 */
export function normalizeRoomName(name: string): string {
  return name
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/['"()]/g, '')
    .replace(/\bROOM\b|\bRM\b/g, '')
    .replace(/\bNO\.?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate similarity between two room names.
 * Returns 0-1 score.
 */
function calculateNameSimilarity(name1: string, name2: string): number {
  const n1 = normalizeRoomName(name1);
  const n2 = normalizeRoomName(name2);

  // Exact match
  if (n1 === n2) return 1.0;

  // Check if one contains the other
  if (n1.includes(n2) || n2.includes(n1)) {
    const shorter = n1.length < n2.length ? n1 : n2;
    const longer = n1.length >= n2.length ? n1 : n2;
    return shorter.length / longer.length;
  }

  // Word-based similarity
  const words1 = new Set(n1.split(' ').filter(w => w.length > 1));
  const words2 = new Set(n2.split(' ').filter(w => w.length > 1));

  const intersection = [...words1].filter(w => words2.has(w)).length;
  const union = new Set([...words1, ...words2]).size;

  return union > 0 ? intersection / union : 0;
}

/**
 * Deduplicate entries by name matching.
 */
export function deduplicateByName(entries: SignageEntry[]): DeduplicationResult {
  const groups: SignageEntry[][] = [];
  const used = new Set<number>();

  // Group similar names
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;

    const group = [entries[i]];
    used.add(i);

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;

      const similarity = calculateNameSimilarity(entries[i].name, entries[j].name);

      if (similarity > 0.8) { // High similarity threshold
        group.push(entries[j]);
        used.add(j);
      }
    }

    groups.push(group);
  }

  // Merge groups
  const uniqueEntries: SignageEntry[] = [];
  const mergedGroups: MergedGroup[] = [];

  for (const group of groups) {
    if (group.length === 1) {
      uniqueEntries.push(group[0]);
    } else {
      // Merge duplicates
      const sorted = group.sort((a, b) => b.confidence - a.confidence);
      const kept = mergeEntries(sorted);
      uniqueEntries.push(kept);

      mergedGroups.push({
        kept,
        merged: sorted.slice(1),
        reason: `Similar names: ${group.map(e => e.name).join(', ')}`,
      });
    }
  }

  return {
    uniqueEntries,
    duplicatesRemoved: entries.length - uniqueEntries.length,
    strategy: 'name_match',
    mergedGroups,
  };
}

// ============================================================================
// Combined Deduplication
// ============================================================================

/**
 * Check if entries have consistent room numbers.
 */
export function hasRoomNumbers(entries: SignageEntry[]): boolean {
  const withNumbers = entries.filter(e => e.roomNumber && e.roomNumber.trim() !== '');
  return withNumbers.length > entries.length * 0.5; // >50% coverage
}

/**
 * Check if entries have consistent names for matching.
 */
export function hasConsistentNames(entries: SignageEntry[]): boolean {
  const validNames = entries.filter(e => e.name && e.name.length > 3);
  return validNames.length > entries.length * 0.8; // >80% have valid names
}

/**
 * Main deduplication function.
 * Tries room number dedup first, falls back to name matching.
 */
export function deduplicateEntries(
  entries: SignageEntry[],
  roomNumberPattern?: RegExp
): DeduplicationResult {
  if (entries.length === 0) {
    return {
      uniqueEntries: [],
      duplicatesRemoved: 0,
      strategy: 'room_number',
      mergedGroups: [],
    };
  }

  // 1. Try room number deduplication first
  const pattern = roomNumberPattern || detectRoomNumberPattern(entries);

  if (pattern && hasRoomNumbers(entries)) {
    const result = deduplicateByRoomNumber(entries, pattern);

    // If we removed duplicates, return the result
    if (result.duplicatesRemoved > 0) {
      return result;
    }
  }

  // 2. Fall back to name matching
  if (hasConsistentNames(entries)) {
    return deduplicateByName(entries);
  }

  // 3. No deduplication possible
  return {
    uniqueEntries: entries,
    duplicatesRemoved: 0,
    strategy: 'room_number',
    mergedGroups: [],
  };
}

// ============================================================================
// Entry Merging
// ============================================================================

/**
 * Merge multiple entries into one, preserving the best information.
 */
function mergeEntries(entries: SignageEntry[]): SignageEntry {
  if (entries.length === 0) {
    throw new Error('Cannot merge empty entries array');
  }

  if (entries.length === 1) {
    return entries[0];
  }

  // Start with highest confidence entry
  const base = { ...entries[0] };

  // Merge data from others
  for (let i = 1; i < entries.length; i++) {
    const other = entries[i];

    // Collect all sheet refs
    const allSheetRefs = new Set([...base.sheetRefs, ...other.sheetRefs]);
    base.sheetRefs = Array.from(allSheetRefs);

    // Collect all page numbers
    const allPages = new Set([...base.pageNumbers, ...other.pageNumbers]);
    base.pageNumbers = Array.from(allPages);

    // Use room number if base doesn't have one
    if (!base.roomNumber && other.roomNumber) {
      base.roomNumber = other.roomNumber;
    }

    // Use sign type code if base doesn't have one
    if (!base.signTypeCode && other.signTypeCode) {
      base.signTypeCode = other.signTypeCode;
    }

    // Keep the longer/more descriptive name
    if (other.name.length > base.name.length) {
      base.name = other.name;
    }

    // Merge notes
    if (other.notes && other.notes !== base.notes) {
      base.notes = base.notes
        ? `${base.notes}; ${other.notes}`
        : other.notes;
    }
  }

  // Update id to reflect merge
  base.id = `merged-${base.id}`;

  // Note the merge
  base.notes = base.notes
    ? `${base.notes}; Merged from ${entries.length} sources`
    : `Merged from ${entries.length} sources`;

  return base;
}

// ============================================================================
// Cross-Source Deduplication
// ============================================================================

/**
 * Deduplicate entries across multiple sources.
 * Entries from different sources may describe the same sign.
 */
export function deduplicateAcrossSources(
  sourceResults: { source: string; entries: SignageEntry[] }[]
): DeduplicationResult {
  // Flatten all entries, tracking source
  const allEntries: SignageEntry[] = [];

  for (const result of sourceResults) {
    allEntries.push(...result.entries);
  }

  // First try room number dedup
  const pattern = detectRoomNumberPattern(allEntries);

  if (pattern && hasRoomNumbers(allEntries)) {
    return deduplicateByRoomNumber(allEntries, pattern);
  }

  // Fall back to name matching
  return deduplicateByName(allEntries);
}

/**
 * Find potential duplicates without merging.
 * Useful for verification.
 */
export function findPotentialDuplicates(
  entries: SignageEntry[]
): { entry1: SignageEntry; entry2: SignageEntry; similarity: number }[] {
  const duplicates: { entry1: SignageEntry; entry2: SignageEntry; similarity: number }[] = [];

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      // Check room number match
      if (entries[i].roomNumber && entries[j].roomNumber) {
        if (entries[i].roomNumber === entries[j].roomNumber) {
          duplicates.push({
            entry1: entries[i],
            entry2: entries[j],
            similarity: 1.0,
          });
          continue;
        }
      }

      // Check name similarity
      const similarity = calculateNameSimilarity(entries[i].name, entries[j].name);

      if (similarity > 0.7) {
        duplicates.push({
          entry1: entries[i],
          entry2: entries[j],
          similarity,
        });
      }
    }
  }

  return duplicates.sort((a, b) => b.similarity - a.similarity);
}
