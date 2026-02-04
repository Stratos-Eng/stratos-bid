/**
 * Pattern Registry
 *
 * Central registry for trade-specific pattern libraries.
 * Supports multiple trades (signage, glazing, etc.)
 */

import type { TradePatterns } from './types';
import { SIGNAGE_PATTERNS } from './signage';

// Re-export types
export * from './types';
export { SIGNAGE_PATTERNS, isExcluded, extractSignTypeCode, getContentConfidence } from './signage';

/**
 * Registry of all trade patterns
 */
const PATTERN_REGISTRY: Map<string, TradePatterns> = new Map([
  ['division_10', SIGNAGE_PATTERNS],
  ['signage', SIGNAGE_PATTERNS], // Alias
]);

/**
 * Get patterns for a specific trade
 */
export function getTradePatterns(tradeCode: string): TradePatterns | undefined {
  return PATTERN_REGISTRY.get(tradeCode.toLowerCase());
}

/**
 * Get all registered trade codes
 */
export function getRegisteredTrades(): string[] {
  return Array.from(PATTERN_REGISTRY.keys());
}

/**
 * Register a new trade pattern (for extensibility)
 */
export function registerTradePatterns(tradeCode: string, patterns: TradePatterns): void {
  PATTERN_REGISTRY.set(tradeCode.toLowerCase(), patterns);
}

/**
 * Get folder score for a path based on trade patterns
 * Returns points (0-100) based on folder name matches
 */
export function scoreFolderPath(path: string, tradeCode: string): number {
  const patterns = getTradePatterns(tradeCode);
  if (!patterns) return 0;

  const pathLower = path.toLowerCase();
  let maxScore = 0;

  // Check each folder keyword
  for (let i = 0; i < patterns.folderKeywords.length; i++) {
    const keyword = patterns.folderKeywords[i];
    if (pathLower.includes(`/${keyword}/`) || pathLower.includes(`\\${keyword}\\`)) {
      // Higher priority keywords get higher scores (first in list = highest)
      const score = 100 - i * 5; // 100, 95, 90, 85...
      maxScore = Math.max(maxScore, score);
    }
  }

  return maxScore;
}

/**
 * Get filename score based on trade patterns
 * Returns points (0-100) based on filename matches
 */
export function scoreFilename(filename: string, tradeCode: string): number {
  const patterns = getTradePatterns(tradeCode);
  if (!patterns) return 0;

  // Normalize: replace underscores and hyphens with spaces for matching
  // (filenames are sanitized during download, replacing spaces with underscores)
  const nameLower = filename.toLowerCase().replace(/[_-]/g, ' ');
  let maxScore = 0;

  // Check each file keyword
  for (let i = 0; i < patterns.fileKeywords.length; i++) {
    const keyword = patterns.fileKeywords[i];
    if (nameLower.includes(keyword)) {
      // Higher priority keywords get higher scores
      const score = 95 - i * 5; // 95, 90, 85, 80...
      maxScore = Math.max(maxScore, score);
    }
  }

  return maxScore;
}
