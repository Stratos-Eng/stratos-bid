/**
 * Trade Pattern Types
 *
 * Shared type definitions for trade-specific pattern libraries.
 */

/**
 * Pattern for detecting content in documents
 */
export interface ContentPattern {
  pattern: RegExp;
  confidence: number; // 0-1
  description: string;
}

/**
 * Sign type code pattern for extraction
 */
export interface SignTypePattern {
  prefix: string;
  examples: string[];
  description: string;
}

/**
 * Complete trade pattern configuration
 */
export interface TradePatterns {
  tradeCode: string; // e.g., 'division_10'
  displayName: string; // e.g., 'Signage'

  // For document scoring (folder/file names)
  folderKeywords: string[];
  fileKeywords: string[];

  // For content detection (cheap text search)
  contentPatterns: ContentPattern[];

  // For extraction
  signTypeCodes: SignTypePattern[];

  // Items to skip
  exclusions: string[];
}

/**
 * Score signal - explains why a document got its score
 */
export interface ScoreSignal {
  type: 'folder' | 'filename' | 'content' | 'ai_classification';
  pattern: string;
  points: number;
  description: string;
}

/**
 * Scored document result
 */
export interface DocumentScore {
  documentId: string;
  filename: string;
  path: string;
  score: number; // 0-100
  signals: ScoreSignal[];
  priority: 'high' | 'medium' | 'low';
}
