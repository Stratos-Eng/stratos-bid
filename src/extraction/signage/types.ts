/**
 * Shared Types for Signage Extraction System
 *
 * These types are used across the source-finder, parsers, verifier, and orchestrator.
 */

import type { ParsedPage } from '../pdf-parser';

// ============================================================================
// Source Types
// ============================================================================

export type SourceType =
  | 'signage_schedule'    // Dedicated signage schedule (best)
  | 'door_schedule'       // Door schedule with room names
  | 'finish_schedule'     // Room finish schedule
  | 'floor_plan'          // Floor plan room tags (fallback)
  | 'ai_extraction';      // AI-only extraction (last resort)

export type SourceFormat = 'tabular' | 'list' | 'tagged' | 'unknown';

export interface FoundSource {
  type: SourceType;
  pages: number[];
  confidence: number;
  format: SourceFormat;
  metadata?: Record<string, unknown>;
}

export interface SourceDiscoveryResult {
  sources: FoundSource[];
  primarySource: FoundSource | null;
  warnings: string[];
}

// ============================================================================
// Signage Entry Types
// ============================================================================

export interface SignageEntry {
  /** Unique identifier for deduplication */
  id: string;

  /** Room or sign identifier (e.g., "214-03", "TS-01") */
  identifier: string;

  /** Human-readable name (e.g., "PATIENT TOILET", "Exit Sign") */
  name: string;

  /** Room number if available (e.g., "214-03") */
  roomNumber?: string;

  /** Sign type code if available (e.g., "TS-01", "RR") */
  signTypeCode?: string;

  /** Quantity (usually 1, but may be more for grouped) */
  quantity: number;

  /** Whether this is a grouped entry (e.g., "BAY 1-3") */
  isGrouped: boolean;

  /** If grouped, what range? (e.g., [1, 3]) */
  groupRange?: [number, number];

  /** Source this was extracted from */
  source: SourceType;

  /** Sheet references where found */
  sheetRefs: string[];

  /** Page numbers where found */
  pageNumbers: number[];

  /** Extraction confidence (0-1) */
  confidence: number;

  /** Additional notes */
  notes?: string;
}

// ============================================================================
// Parser Result Types
// ============================================================================

export interface ParseResult {
  entries: SignageEntry[];
  source: SourceType;
  pagesParsed: number[];
  confidence: number;
  warnings: string[];
  rawCount: number;  // Before deduplication
}

// ============================================================================
// Door Schedule Types
// ============================================================================

export interface DoorScheduleEntry {
  doorNumber: string;
  roomName: string;
  roomNumber?: string;
  hardwareSet?: string;
  signRequired: boolean;
  isGroupedEntry: boolean;
  groupedCount: number;
}

// ============================================================================
// Signage Schedule Types
// ============================================================================

export interface SignageScheduleEntry {
  signType: string;
  description: string;
  quantity: number;
  locations: string[];
  specifications?: string;
}

// ============================================================================
// Floor Plan Types
// ============================================================================

export interface FloorPlanEntry {
  roomName: string;
  roomNumber?: string;
  sheetRef: string;
  pageNumber: number;
}

// ============================================================================
// Deduplication Types
// ============================================================================

export type DeduplicationStrategy = 'room_number' | 'name_match' | 'ai_similarity';

export interface DeduplicationResult {
  uniqueEntries: SignageEntry[];
  duplicatesRemoved: number;
  strategy: DeduplicationStrategy;
  mergedGroups: MergedGroup[];
}

export interface MergedGroup {
  kept: SignageEntry;
  merged: SignageEntry[];
  reason: string;
}

// ============================================================================
// Verification Types
// ============================================================================

export type DiscrepancyType =
  | 'count_mismatch'
  | 'missing_entry'
  | 'extra_entry'
  | 'grouped_interpretation'
  | 'duplicate_suspected';

export interface Discrepancy {
  type: DiscrepancyType;
  source1: SourceType;
  source2: SourceType;
  description: string;
  affectedEntries: SignageEntry[];
  autoResolvable: boolean;
  resolution?: Resolution;
}

export interface Resolution {
  action: 'merge' | 'split' | 'remove' | 'add' | 'keep';
  confidence: number;
  reason: string;
}

export interface VerificationResult {
  verified: boolean;
  discrepancies: Discrepancy[];
  confidence: number;
}

// ============================================================================
// Clarification Types
// ============================================================================

export type ClarificationPriority = 'high' | 'medium' | 'low';
export type ClarificationCategory = 'scope' | 'quantity' | 'grouped_entry' | 'specification';

export interface Clarification {
  priority: ClarificationPriority;
  category: ClarificationCategory;
  question: string;
  context: string;
  suggestedRFI?: string;
}

// ============================================================================
// Final Result Types
// ============================================================================

export interface ExtractionResult {
  entries: SignageEntry[];
  totalCount: number;
  confidence: number;
  primarySource: SourceType;
  sourcesUsed: SourceType[];
  discrepancies: Discrepancy[];
  clarifications: Clarification[];
  converged: boolean;
  iterations: number;
  warnings: string[];
}

// ============================================================================
// Utility Types
// ============================================================================

export interface RoomNumberPattern {
  pattern: RegExp;
  name: string;
  example: string;
}

export const COMMON_ROOM_NUMBER_PATTERNS: RoomNumberPattern[] = [
  {
    pattern: /(\d{3}-\d{2})/g,
    name: 'floor-room',
    example: '214-03'
  },
  {
    pattern: /([A-Z]\d{3})/g,
    name: 'building-room',
    example: 'B201'
  },
  {
    pattern: /([A-Z]\d-\d{3})/g,
    name: 'level-room',
    example: 'L2-105'
  },
  {
    pattern: /(?:ROOM|RM)\s*(\d{3,4})/gi,
    name: 'simple-prefix',
    example: 'ROOM 101'
  },
];
