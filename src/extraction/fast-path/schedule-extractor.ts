/**
 * Fast-Path Schedule Extractor
 *
 * When a signage schedule or legend is clearly identified,
 * extract directly using pattern matching - no AI needed.
 *
 * This provides significant cost savings and faster results
 * when documents have clear, structured signage data.
 */

import { execSync } from 'child_process';
import type { SignageEntry } from '../signage/types';
import {
  SIGNAGE_PATTERNS,
  isExcluded,
  getContentConfidence,
} from '../scoring/patterns/signage';

/**
 * Fast-path extraction result
 */
export interface FastPathResult {
  success: boolean;
  confidence: number;
  entries: SignageEntry[];
  totalCount: number;
  source: 'signage_schedule' | 'legend' | 'door_schedule' | 'site_plan';
  skippedAI: boolean;
  issues: FastPathIssue[];
  notes: string;
}

/**
 * Issues found during fast-path extraction
 */
export interface FastPathIssue {
  type: 'ambiguous' | 'missing_quantity' | 'grouped_entry' | 'unknown_code';
  description: string;
  entries: string[];
}

/**
 * Extract text from a PDF file using pdftotext
 */
export async function extractPdfText(
  pdfPath: string,
  startPage?: number,
  endPage?: number
): Promise<string> {
  try {
    let pageArg = '';
    if (startPage && endPage) {
      pageArg = `-f ${startPage} -l ${endPage}`;
    }

    const text = execSync(`pdftotext ${pageArg} "${pdfPath}" -`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });

    return text;
  } catch (error) {
    console.warn(`[fast-path] Could not extract text from ${pdfPath}`);
    return '';
  }
}

/**
 * Attempt fast-path extraction from document text
 *
 * Returns a result if confident enough, or null to fall back to AI
 */
export function tryFastPathExtraction(
  text: string,
  sourceType: 'signage_schedule' | 'legend' | 'door_schedule' | 'site_plan'
): FastPathResult | null {
  // Check if this looks like signage content
  const contentConfidence = getContentConfidence(text);
  if (contentConfidence < 0.7) {
    return null; // Not confident enough, fall back to AI
  }

  const entries: SignageEntry[] = [];
  const issues: FastPathIssue[] = [];
  const seenIdentifiers = new Set<string>();

  // Extract entries based on source type
  if (sourceType === 'signage_schedule' || sourceType === 'legend') {
    extractFromSchedule(text, entries, issues, seenIdentifiers);
  } else if (sourceType === 'site_plan') {
    extractFromSitePlan(text, entries, issues, seenIdentifiers);
  } else if (sourceType === 'door_schedule') {
    extractFromDoorSchedule(text, entries, issues, seenIdentifiers);
  }

  // Check if we found enough entries to be confident
  if (entries.length < 3) {
    return null; // Not enough found, fall back to AI
  }

  // Calculate total count
  const totalCount = entries.reduce((sum, e) => sum + e.quantity, 0);

  // Determine confidence based on source type and what we found
  let confidence = 0.7;

  if (sourceType === 'site_plan') {
    // Site plans have complex layouts - be more conservative
    confidence = 0.65;
    if (entries.length >= 10) confidence = 0.70;
    if (entries.length >= 15) confidence = 0.75;
    // Penalize heavily if issues found (missing types, ambiguities)
    if (issues.length > 0) confidence -= 0.10;
  } else {
    // Schedules and legends are more reliable
    if (entries.length >= 10) confidence = 0.85;
    if (entries.length >= 20) confidence = 0.90;
    if (issues.length === 0) confidence += 0.05;
  }

  // Cap confidence - never claim 100% without verification
  confidence = Math.max(0.5, Math.min(confidence, 0.90));

  return {
    success: true,
    confidence,
    entries,
    totalCount,
    source: sourceType,
    skippedAI: true,
    issues,
    notes: `Fast-path extracted ${entries.length} entries (${totalCount} total) from ${sourceType}. ${issues.length > 0 ? 'Review issues.' : ''}`,
  };
}

/**
 * Extract sign entries from a schedule or legend
 */
function extractFromSchedule(
  text: string,
  entries: SignageEntry[],
  issues: FastPathIssue[],
  seenIdentifiers: Set<string>
): void {
  // Look for sign type patterns: "D7 - Monument Sign" or "TS-01: Tactile Sign"
  for (const codePattern of SIGNAGE_PATTERNS.signTypeCodes) {
    // Pattern: CODE [-:=] DESCRIPTION [QUANTITY]
    const regex = new RegExp(
      `(${codePattern.prefix}[-\\s]?\\d{0,2})\\s*[-:=]?\\s*([A-Za-z][A-Za-z\\s\\-"'&/()]{2,60})(?:\\s*(\\d+))?`,
      'gi'
    );

    let match;
    while ((match = regex.exec(text)) !== null) {
      const signType = match[1].toUpperCase().replace(/\s/g, '-').trim();
      const description = match[2].trim().toUpperCase();
      const quantityStr = match[3];

      // Skip if excluded
      if (isExcluded(description)) continue;

      // Skip if we've seen this identifier
      if (seenIdentifiers.has(signType)) continue;
      seenIdentifiers.add(signType);

      // Parse quantity
      let quantity = 1;
      if (quantityStr) {
        quantity = parseInt(quantityStr, 10) || 1;
      }

      entries.push({
        id: `fp-${entries.length.toString().padStart(3, '0')}`,
        identifier: signType,
        name: description,
        signTypeCode: signType,
        quantity,
        isGrouped: false,
        source: 'signage_schedule',
        sheetRefs: [],
        pageNumbers: [],
        confidence: 0.85,
      });
    }
  }

  // Check for quantity tables
  const hasQuantityColumn = /qty|quantity|count|no\./i.test(text);
  if (!hasQuantityColumn && entries.length > 0) {
    issues.push({
      type: 'missing_quantity',
      description: 'No quantity column detected - verify quantities from drawings',
      entries: entries.slice(0, 5).map((e) => e.signTypeCode || e.identifier),
    });
  }
}

/**
 * Extract sign entries from a site plan (Metro D/P series)
 *
 * Metro site plans use callout patterns: "7.P3.28" = Area 7, Type P3, Sign #28
 * Each unique callout represents ONE sign. We count total unique callouts.
 *
 * IMPORTANT: This fast-path extraction may undercount when:
 * - Text extraction loses some callouts due to PDF layout complexity
 * - Signs are only shown in legends, not as callouts
 *
 * For Metro projects, consider using agentic extraction for 100% accuracy.
 */
function extractFromSitePlan(
  text: string,
  entries: SignageEntry[],
  issues: FastPathIssue[],
  seenIdentifiers: Set<string>
): void {
  // Track unique callouts per type
  // Use Set to avoid double-counting when same callout appears twice in text
  const uniqueCallouts = new Map<string, Set<string>>();

  // Look for callout patterns: "7.P3.28" means Area 7, Type P3, Sign #28
  const calloutRegex = /(\d+)\.(D\d{1,2}|P\d{1,2})\.(\d+)/gi;

  let match;
  while ((match = calloutRegex.exec(text)) !== null) {
    const signType = match[2].toUpperCase();
    const fullCallout = match[0].toUpperCase(); // e.g., "7.P3.28"

    if (!uniqueCallouts.has(signType)) {
      uniqueCallouts.set(signType, new Set());
    }
    uniqueCallouts.get(signType)!.add(fullCallout);
  }

  // Count unique callouts per type
  const calloutCounts = new Map<string, number>();
  for (const [signType, callouts] of uniqueCallouts) {
    calloutCounts.set(signType, callouts.size);
  }

  // Create entries from callout counts
  for (const [signType, count] of calloutCounts) {
    if (seenIdentifiers.has(signType)) continue;
    seenIdentifiers.add(signType);

    // Find description from pattern library
    const pattern = SIGNAGE_PATTERNS.signTypeCodes.find((p) =>
      signType.startsWith(p.prefix)
    );
    const description = pattern?.description || signType;

    entries.push({
      id: `fp-${entries.length.toString().padStart(3, '0')}`,
      identifier: signType,
      name: description.toUpperCase(),
      signTypeCode: signType,
      quantity: count,
      isGrouped: false,
      source: 'site_plan',
      sheetRefs: [],
      pageNumbers: [],
      confidence: 0.75, // Lower confidence for site plan extraction
    });
  }

  // Check if P13/P14 exist in text but weren't found as callouts
  // These often appear only in legends, not as callouts
  const missingTypes = [];
  for (const type of ['P13', 'P14']) {
    if (!calloutCounts.has(type) && text.includes(type)) {
      missingTypes.push(type);
    }
  }

  if (missingTypes.length > 0) {
    issues.push({
      type: 'missing_quantity',
      description: `${missingTypes.join(', ')} found in text but not as callouts - quantities may be incomplete`,
      entries: missingTypes,
    });
  }

  // Add a general note about potential undercounting
  if (entries.length > 0) {
    issues.push({
      type: 'ambiguous',
      description: 'Site plan extraction counts visible callouts only. Verify against legend totals.',
      entries: [],
    });
  }
}

/**
 * Extract room names from a door schedule
 */
function extractFromDoorSchedule(
  text: string,
  entries: SignageEntry[],
  issues: FastPathIssue[],
  seenIdentifiers: Set<string>
): void {
  // Look for room patterns in door schedules
  // Pattern: ROOM NUMBER - ROOM NAME
  const roomRegex = /(\d{3}[-\s]?\d{0,2})\s*[-–]\s*([A-Z][A-Z\s\-'&/()]{2,40})/g;

  let match;
  while ((match = roomRegex.exec(text)) !== null) {
    const roomNumber = match[1].replace(/\s/g, '-');
    const roomName = match[2].trim().toUpperCase();

    // Skip if excluded or already seen
    if (isExcluded(roomName)) continue;
    if (seenIdentifiers.has(roomNumber)) continue;
    seenIdentifiers.add(roomNumber);

    // Skip utility spaces that typically don't get signs
    if (/SHAFT|CHASE|VOID|PLENUM|DUCT|RISER|MECH|ELECT|TELECOM/i.test(roomName)) {
      continue;
    }

    entries.push({
      id: `fp-${entries.length.toString().padStart(3, '0')}`,
      identifier: roomNumber,
      name: roomName,
      roomNumber,
      quantity: 1,
      isGrouped: false,
      source: 'door_schedule',
      sheetRefs: [],
      pageNumbers: [],
      confidence: 0.75,
    });
  }

  // Check for grouped entries like "ROOM 101-105"
  const groupedRegex = /ROOM[S]?\s*(\d+)\s*[-–]\s*(\d+)/gi;
  while ((match = groupedRegex.exec(text)) !== null) {
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);

    if (end > start && end - start <= 20) {
      issues.push({
        type: 'grouped_entry',
        description: `Rooms ${start}-${end} - verify if this is 1 sign or ${end - start + 1} signs`,
        entries: [`ROOMS ${start}-${end}`],
      });
    }
  }
}

/**
 * Determine source type from document text
 */
export function detectSourceType(
  text: string
): 'signage_schedule' | 'legend' | 'door_schedule' | 'site_plan' | null {
  const textLower = text.toLowerCase();

  // Check for explicit schedule types
  if (/signage\s*schedule/i.test(textLower)) return 'signage_schedule';
  if (/sign\s*legend/i.test(textLower)) return 'legend';
  if (/door\s*schedule/i.test(textLower)) return 'door_schedule';
  if (/site\s*plan/i.test(textLower)) return 'site_plan';

  // Check for D/P series patterns (Metro)
  if (/\d\.(D\d{1,2}|P\d{1,2})\.\d/.test(text)) return 'site_plan';

  // Check for sign type codes
  if (/TS-\d|RR-\d|RS-\d|EX-\d/i.test(text)) return 'signage_schedule';

  return null;
}
