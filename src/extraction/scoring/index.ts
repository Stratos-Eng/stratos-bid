/**
 * Document Scoring Module
 *
 * Exports document scoring functionality for pre-filtering
 * documents before AI extraction.
 */

// Main scorer functions
export {
  scoreDocument,
  scoreDocuments,
  scoreAllDocuments,
  getTopDocument,
  getHighPriorityDocuments,
  formatScoresForLog,
  type DocumentInfo,
} from './document-scorer';

// Pattern types and utilities
export {
  type TradePatterns,
  type ContentPattern,
  type SignTypePattern,
  type ScoreSignal,
  type DocumentScore,
} from './patterns/types';

// Pattern registry
export {
  getTradePatterns,
  getRegisteredTrades,
  registerTradePatterns,
  scoreFolderPath,
  scoreFilename,
} from './patterns';

// Signage-specific utilities
export {
  SIGNAGE_PATTERNS,
  isExcluded,
  extractSignTypeCode,
  getContentConfidence,
} from './patterns/signage';

// AI-powered fallback classifier
export {
  classifyFilenames,
  boostScoresWithAI,
  type FileClassification,
  type ClassificationResult,
} from './ai-classifier';
