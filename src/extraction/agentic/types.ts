/**
 * Types for Agentic Signage Extraction
 *
 * This module implements a tool-loop pattern where Claude
 * investigates documents iteratively using tools.
 */

import type { SignageEntry } from '../signage/types';

// Re-export SignageEntry for convenience
export type { SignageEntry } from '../signage/types';

/**
 * Document info passed to the extraction loop
 */
export interface DocumentInfo {
  id: string;
  name: string;
  path: string;
  pageCount?: number;
  s3Url?: string;
}

/**
 * Token usage tracking
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

/**
 * Result from the agentic extraction
 */
export interface AgenticExtractionResult {
  entries: SignageEntry[];
  totalCount: number;
  confidence: number;
  notes: string;
  iterationsUsed: number;
  toolCallsCount: number;
  tokenUsage: TokenUsage;
}

/**
 * Tool call from Claude's response
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Image data for vision-based tools
 */
export interface ImageData {
  type: 'base64';
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

/**
 * Result from executing a tool
 * Note: tool_use_id is set by the tool-loop, not by executeToolCall
 */
export interface ToolExecutionResult {
  content: string;
  is_error?: boolean;
  imageData?: ImageData; // For vision-based tools
}

/**
 * Entry submitted via submit_entries tool
 */
export interface SubmittedEntry {
  roomName: string;
  roomNumber?: string;
  quantity?: number;
  signType?: string;
  isGrouped?: boolean;
  groupRange?: [number, number];
  sheetRef?: string;
  pageNumber?: number;
  confidence?: number;
  notes?: string;
}

/**
 * Input for submit_entries tool
 */
export interface SubmitEntriesInput {
  entries: SubmittedEntry[];
  confidence: number;
  notes?: string;
}

/**
 * Input for list_files tool
 */
export interface ListFilesInput {
  path?: string;
}

/**
 * Input for read_pdf_pages tool
 */
export interface ReadPdfPagesInput {
  file: string;
  pages?: number[];
  startPage?: number;
  endPage?: number;
}

/**
 * Input for search_text tool
 */
export interface SearchTextInput {
  pattern: string;
  file?: string;
  maxResults?: number;
}

/**
 * Input for view_pdf_page tool
 */
export interface ViewPdfPageInput {
  file: string;
  page: number;
  scale?: number;
}
