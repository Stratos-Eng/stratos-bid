/**
 * Agentic Signage Extraction Module
 *
 * Uses a tool-loop pattern where Claude investigates documents
 * iteratively to find and extract signage requirements.
 */

export { runExtractionLoop, extractSignageAgentic } from './tool-loop';
export { EXTRACTION_TOOLS, executeToolCall } from './tools';
export { EXTRACTION_SYSTEM_PROMPT, buildInitialPrompt } from './prompts';
export type {
  DocumentInfo,
  AgenticExtractionResult,
  SubmittedEntry,
  SubmitEntriesInput,
  TokenUsage,
} from './types';
