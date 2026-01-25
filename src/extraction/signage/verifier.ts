/**
 * Cross-Verification for Signage Extraction
 *
 * Compares results from different sources to identify discrepancies.
 * When sources disagree, investigates why and attempts resolution.
 */

import type {
  SignageEntry,
  ParseResult,
  SourceType,
  Discrepancy,
  DiscrepancyType,
  Resolution,
  VerificationResult,
} from './types';
import { normalizeRoomName, findPotentialDuplicates } from './deduplication';

// ============================================================================
// Count Verification
// ============================================================================

/**
 * Compare total counts between sources.
 */
function verifyTotalCounts(
  primary: ParseResult,
  secondary: ParseResult[]
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const primaryCount = primary.entries.length;

  for (const sec of secondary) {
    const secCount = sec.entries.length;
    const diff = Math.abs(primaryCount - secCount);

    // Allow small differences (within 10% or 3 entries)
    const tolerance = Math.max(3, Math.ceil(primaryCount * 0.1));

    if (diff > tolerance) {
      discrepancies.push({
        type: 'count_mismatch',
        source1: primary.source,
        source2: sec.source,
        description: `${primary.source} has ${primaryCount} entries, ${sec.source} has ${secCount} (diff: ${diff})`,
        affectedEntries: [],
        autoResolvable: diff < primaryCount * 0.2, // <20% diff might be resolvable
        resolution: diff < primaryCount * 0.2
          ? {
              action: 'keep',
              confidence: 0.7,
              reason: `Keeping ${primary.source} as primary (higher confidence source)`,
            }
          : undefined,
      });
    }
  }

  return discrepancies;
}

// ============================================================================
// Entry Verification
// ============================================================================

/**
 * Find entries in source1 that don't exist in source2.
 */
function findMissingEntries(
  source1: ParseResult,
  source2: ParseResult
): SignageEntry[] {
  const missing: SignageEntry[] = [];
  const normalizedNames2 = new Set(
    source2.entries.map(e => normalizeRoomName(e.name))
  );
  const roomNumbers2 = new Set(
    source2.entries
      .filter(e => e.roomNumber)
      .map(e => e.roomNumber!.toUpperCase())
  );

  for (const entry of source1.entries) {
    const normalizedName = normalizeRoomName(entry.name);
    const roomNum = entry.roomNumber?.toUpperCase();

    // Check if entry exists in source2 by name or room number
    const foundByName = normalizedNames2.has(normalizedName);
    const foundByRoomNum = roomNum && roomNumbers2.has(roomNum);

    if (!foundByName && !foundByRoomNum) {
      missing.push(entry);
    }
  }

  return missing;
}

/**
 * Verify individual entries between sources.
 */
function verifyEntries(
  primary: ParseResult,
  secondary: ParseResult[]
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  for (const sec of secondary) {
    // Find entries in primary missing from secondary
    const missingFromSec = findMissingEntries(primary, sec);
    if (missingFromSec.length > 0) {
      discrepancies.push({
        type: 'extra_entry',
        source1: primary.source,
        source2: sec.source,
        description: `${missingFromSec.length} entries in ${primary.source} not found in ${sec.source}`,
        affectedEntries: missingFromSec,
        autoResolvable: missingFromSec.length < 3,
        resolution: missingFromSec.length < 3
          ? {
              action: 'keep',
              confidence: 0.6,
              reason: `Keeping entries from primary source (${primary.source})`,
            }
          : undefined,
      });
    }

    // Find entries in secondary missing from primary
    const missingFromPrimary = findMissingEntries(sec, primary);
    if (missingFromPrimary.length > 0) {
      discrepancies.push({
        type: 'missing_entry',
        source1: primary.source,
        source2: sec.source,
        description: `${missingFromPrimary.length} entries in ${sec.source} not found in ${primary.source}`,
        affectedEntries: missingFromPrimary,
        autoResolvable: missingFromPrimary.length < 3,
        resolution: missingFromPrimary.length < 3
          ? {
              action: 'add',
              confidence: 0.5,
              reason: `Consider adding entries from ${sec.source}`,
            }
          : undefined,
      });
    }
  }

  return discrepancies;
}

// ============================================================================
// Grouped Entry Verification
// ============================================================================

/**
 * Detect issues with grouped entries (e.g., "BAY 1-3").
 */
function verifyGroupedEntries(
  primary: ParseResult,
  secondary: ParseResult[]
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  // Get all grouped entries from primary
  const groupedPrimary = primary.entries.filter(e => e.isGrouped);

  for (const grouped of groupedPrimary) {
    // Check if secondary sources have individual entries for this group
    for (const sec of secondary) {
      const range = grouped.groupRange;
      if (!range) continue;

      // Look for individual entries that might be part of this group
      const possibleIndividuals = sec.entries.filter(e => {
        const baseName = normalizeRoomName(grouped.name.replace(/\d+\s*[-–]\s*\d+/, ''));
        const entryName = normalizeRoomName(e.name);

        // Check if same base name with different number
        return entryName.includes(baseName) && !e.isGrouped;
      });

      if (possibleIndividuals.length > 0) {
        const rangeSize = range[1] - range[0] + 1;

        if (possibleIndividuals.length >= rangeSize - 1) {
          discrepancies.push({
            type: 'grouped_interpretation',
            source1: primary.source,
            source2: sec.source,
            description: `"${grouped.name}" is grouped in ${primary.source} but ${sec.source} has ${possibleIndividuals.length} individual entries`,
            affectedEntries: [grouped, ...possibleIndividuals],
            autoResolvable: true,
            resolution: {
              action: 'keep',
              confidence: 0.8,
              reason: `Grouped entry represents ONE sign, not ${rangeSize}. Trust door schedule grouping.`,
            },
          });
        }
      }
    }
  }

  return discrepancies;
}

// ============================================================================
// Duplicate Detection
// ============================================================================

/**
 * Find potential duplicates within a single source.
 */
function verifyNoDuplicates(result: ParseResult): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  const duplicates = findPotentialDuplicates(result.entries);

  for (const dup of duplicates) {
    if (dup.similarity > 0.9) {
      discrepancies.push({
        type: 'duplicate_suspected',
        source1: result.source,
        source2: result.source,
        description: `Potential duplicate: "${dup.entry1.name}" and "${dup.entry2.name}" (${Math.round(dup.similarity * 100)}% similar)`,
        affectedEntries: [dup.entry1, dup.entry2],
        autoResolvable: dup.similarity === 1.0,
        resolution: dup.similarity === 1.0
          ? {
              action: 'merge',
              confidence: 0.9,
              reason: 'Exact duplicate detected, merging entries',
            }
          : undefined,
      });
    }
  }

  return discrepancies;
}

// ============================================================================
// Confidence Calculation
// ============================================================================

/**
 * Calculate overall verification confidence.
 */
function calculateConfidence(
  primary: ParseResult,
  secondary: ParseResult[],
  discrepancies: Discrepancy[]
): number {
  // Start with primary source confidence
  let confidence = primary.confidence;

  // Reduce for each discrepancy
  for (const d of discrepancies) {
    switch (d.type) {
      case 'count_mismatch':
        confidence -= 0.1;
        break;
      case 'missing_entry':
        confidence -= 0.05 * d.affectedEntries.length;
        break;
      case 'extra_entry':
        confidence -= 0.03 * d.affectedEntries.length;
        break;
      case 'grouped_interpretation':
        // This is actually informational, not a problem
        break;
      case 'duplicate_suspected':
        confidence -= 0.05;
        break;
    }
  }

  // Boost if secondary sources agree
  const agreementCount = secondary.filter(sec => {
    const countDiff = Math.abs(primary.entries.length - sec.entries.length);
    return countDiff <= 2;
  }).length;

  if (agreementCount > 0) {
    confidence += 0.05 * agreementCount;
  }

  // Clamp to 0-1
  return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
}

// ============================================================================
// Main Verification Function
// ============================================================================

/**
 * Cross-verify primary result against secondary sources.
 *
 * @param primary - The primary source result (highest confidence)
 * @param secondary - Secondary source results for verification
 * @returns Verification result with discrepancies
 */
export function crossVerifySources(
  primary: ParseResult,
  secondary: ParseResult[]
): VerificationResult {
  const discrepancies: Discrepancy[] = [];

  // 1. Verify total counts
  discrepancies.push(...verifyTotalCounts(primary, secondary));

  // 2. Verify individual entries
  discrepancies.push(...verifyEntries(primary, secondary));

  // 3. Verify grouped entries
  discrepancies.push(...verifyGroupedEntries(primary, secondary));

  // 4. Check for duplicates within primary
  discrepancies.push(...verifyNoDuplicates(primary));

  // Calculate confidence
  const confidence = calculateConfidence(primary, secondary, discrepancies);

  // Consider verified if no major discrepancies
  const majorDiscrepancies = discrepancies.filter(d =>
    d.type === 'count_mismatch' ||
    (d.type === 'missing_entry' && d.affectedEntries.length > 3) ||
    (d.type === 'extra_entry' && d.affectedEntries.length > 3)
  );

  return {
    verified: majorDiscrepancies.length === 0,
    discrepancies,
    confidence,
  };
}

// ============================================================================
// Resolution Application
// ============================================================================

/**
 * Apply a resolution to the entries.
 */
export function applyResolution(
  entries: SignageEntry[],
  discrepancy: Discrepancy
): SignageEntry[] {
  if (!discrepancy.resolution) {
    return entries;
  }

  const resolution = discrepancy.resolution;

  switch (resolution.action) {
    case 'merge':
      // Merge duplicate entries
      return mergeDuplicates(entries, discrepancy.affectedEntries);

    case 'remove':
      // Remove affected entries
      const removeIds = new Set(discrepancy.affectedEntries.map(e => e.id));
      return entries.filter(e => !removeIds.has(e.id));

    case 'add':
      // Add missing entries
      const existingIds = new Set(entries.map(e => e.id));
      const toAdd = discrepancy.affectedEntries.filter(e => !existingIds.has(e.id));
      return [...entries, ...toAdd];

    case 'keep':
    case 'split':
    default:
      // No change needed
      return entries;
  }
}

/**
 * Merge duplicate entries.
 */
function mergeDuplicates(
  entries: SignageEntry[],
  duplicates: SignageEntry[]
): SignageEntry[] {
  if (duplicates.length < 2) {
    return entries;
  }

  // Keep first, remove rest
  const toRemove = new Set(duplicates.slice(1).map(e => e.id));
  return entries.filter(e => !toRemove.has(e.id));
}

// ============================================================================
// Verification Summary
// ============================================================================

/**
 * Generate a human-readable verification summary.
 */
export function generateVerificationSummary(result: VerificationResult): string {
  const lines: string[] = [];

  lines.push(`Verification: ${result.verified ? 'PASSED' : 'NEEDS REVIEW'}`);
  lines.push(`Confidence: ${Math.round(result.confidence * 100)}%`);

  if (result.discrepancies.length > 0) {
    lines.push(`\nDiscrepancies (${result.discrepancies.length}):`);

    for (const d of result.discrepancies) {
      const resolvable = d.autoResolvable ? ' [auto-resolvable]' : '';
      lines.push(`  - ${d.type}: ${d.description}${resolvable}`);
    }
  } else {
    lines.push('\nNo discrepancies found.');
  }

  return lines.join('\n');
}

/**
 * Get discrepancies that need manual review.
 */
export function getManualReviewItems(result: VerificationResult): Discrepancy[] {
  return result.discrepancies.filter(d => !d.autoResolvable);
}

/**
 * Get discrepancies that can be auto-resolved.
 */
export function getAutoResolvableItems(result: VerificationResult): Discrepancy[] {
  return result.discrepancies.filter(d => d.autoResolvable && d.resolution);
}
