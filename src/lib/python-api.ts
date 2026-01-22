/**
 * Python API Client
 *
 * Centralized client for communicating with the Python vector/rendering service.
 * Features:
 * - Fail-fast if PYTHON_VECTOR_API_URL is not configured
 * - Retry logic with exponential backoff
 * - Timeout handling
 * - Type-safe request/response handling
 */

import { fetchWithTimeout, FetchTimeoutError } from './fetch-with-timeout';

// Validate environment on module load
const PYTHON_API_URL = process.env.PYTHON_VECTOR_API_URL;

export class PythonApiNotConfiguredError extends Error {
  constructor() {
    super(
      'PYTHON_VECTOR_API_URL environment variable is not configured. ' +
      'This is required for PDF rendering, tile generation, and vector extraction.'
    );
    this.name = 'PythonApiNotConfiguredError';
  }
}

export class PythonApiError extends Error {
  constructor(
    public endpoint: string,
    public statusCode: number,
    message: string
  ) {
    super(`Python API error at ${endpoint}: ${message} (status: ${statusCode})`);
    this.name = 'PythonApiError';
  }
}

/**
 * Get the Python API URL, throwing if not configured
 */
export function getPythonApiUrl(): string {
  if (!PYTHON_API_URL) {
    throw new PythonApiNotConfiguredError();
  }
  return PYTHON_API_URL;
}

/**
 * Check if Python API is configured
 */
export function isPythonApiConfigured(): boolean {
  return !!PYTHON_API_URL;
}

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  timeoutMs: 30000,
};

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const delay = baseDelay * Math.pow(2, attempt);
  const jitter = delay * 0.1 * Math.random(); // Add 10% jitter
  return Math.min(delay + jitter, maxDelay);
}

/**
 * Make a request to the Python API with retry logic
 */
async function requestWithRetry<T>(
  endpoint: string,
  body: Record<string, unknown>,
  options: RetryOptions = {}
): Promise<T> {
  const baseUrl = getPythonApiUrl();
  const url = `${baseUrl}${endpoint}`;
  const { maxRetries, baseDelayMs, maxDelayMs, timeoutMs } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new PythonApiError(endpoint, response.status, errorText);
      }

      return await response.json() as T;
    } catch (error) {
      lastError = error as Error;

      // Don't retry on configuration errors
      if (error instanceof PythonApiNotConfiguredError) {
        throw error;
      }

      // Don't retry on 4xx errors (client errors)
      if (error instanceof PythonApiError && error.statusCode >= 400 && error.statusCode < 500) {
        throw error;
      }

      // Log retry attempt
      if (attempt < maxRetries) {
        const delay = getBackoffDelay(attempt, baseDelayMs, maxDelayMs);
        console.warn(
          `Python API request to ${endpoint} failed (attempt ${attempt + 1}/${maxRetries + 1}), ` +
          `retrying in ${Math.round(delay)}ms:`,
          error instanceof Error ? error.message : error
        );
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error(`Request to ${endpoint} failed after ${maxRetries + 1} attempts`);
}

// Type definitions for API responses
export interface RenderResponse {
  success: boolean;
  image?: string; // Base64 encoded
  width?: number;
  height?: number;
  error?: string;
}

export interface TileResponse {
  success: boolean;
  image?: string; // Base64 encoded
  error?: string;
}

export interface TextExtractionResponse {
  success: boolean;
  pages: Array<{
    page: number;
    text: string;
    needsOcr: boolean;
  }>;
  totalPages: number;
  error?: string;
}

export interface CropResponse {
  success: boolean;
  image?: string; // Base64 encoded
  error?: string;
}

export interface OcrResponse {
  success: boolean;
  text?: string;
  confidence?: number;
  error?: string;
}

export interface EmbedResponse {
  success: boolean;
  embedding?: number[];
  error?: string;
}

export interface VectorExtractionResponse {
  success: boolean;
  vectors?: Array<{
    type: string;
    points: number[][];
  }>;
  error?: string;
}

export interface MetadataResponse {
  success: boolean;
  pageCount: number;
  width: number;  // First page width in points
  height: number; // First page height in points
  title?: string;
  author?: string;
  error?: string;
}

export interface PageInfoItem {
  pageNum: number;
  width: number;
  height: number;
  rotation: number;
}

export interface PagesInfoResponse {
  success: boolean;
  pageCount: number;
  pages: PageInfoItem[];
  error?: string;
}

/**
 * Python API client
 */
export const pythonApi = {
  /**
   * Check if the API is available
   */
  isConfigured(): boolean {
    return isPythonApiConfigured();
  },

  /**
   * Render a PDF page to an image
   */
  async render(params: {
    pdfUrl?: string;
    pdfData?: string; // Base64 encoded
    pageNum: number;
    scale?: number;
    returnBase64?: boolean;
  }): Promise<RenderResponse> {
    return requestWithRetry<RenderResponse>('/render', params, {
      timeoutMs: 60000, // 60s for rendering
    });
  },

  /**
   * Generate a tile from a PDF page
   */
  async tile(params: {
    pdfUrl: string;
    pageNum: number;
    z: number;
    x: number;
    y: number;
    tileSize?: number;
  }): Promise<TileResponse> {
    return requestWithRetry<TileResponse>('/tile', params, {
      timeoutMs: 30000,
    });
  },

  /**
   * Extract text from a PDF (base64 encoded)
   * @deprecated Use extractTextFromUrl for better memory efficiency
   */
  async extractText(params: {
    pdfData: string; // Base64 encoded
  }): Promise<TextExtractionResponse> {
    return requestWithRetry<TextExtractionResponse>('/text', params, {
      timeoutMs: 120000, // 2 minutes for large PDFs
      maxRetries: 2,
    });
  },

  /**
   * Extract text from a PDF via URL (memory efficient)
   * Preferred over extractText() as it avoids base64 encoding overhead
   */
  async extractTextFromUrl(params: {
    pdfUrl: string;
  }): Promise<TextExtractionResponse> {
    return requestWithRetry<TextExtractionResponse>('/text-url', params, {
      timeoutMs: 120000, // 2 minutes for large PDFs
      maxRetries: 2,
    });
  },

  /**
   * Get PDF metadata (page count, dimensions) via URL
   * Memory efficient - Python fetches the PDF directly
   */
  async metadata(params: {
    pdfUrl: string;
  }): Promise<MetadataResponse> {
    return requestWithRetry<MetadataResponse>('/metadata', params, {
      timeoutMs: 30000,
    });
  },

  /**
   * Get detailed info for all pages of a PDF
   * Returns dimensions and rotation for each page
   * Memory efficient - Python fetches the PDF directly
   */
  async pagesInfo(params: {
    pdfUrl: string;
  }): Promise<PagesInfoResponse> {
    return requestWithRetry<PagesInfoResponse>('/pages-info', params, {
      timeoutMs: 60000, // Longer timeout for large PDFs with many pages
    });
  },

  /**
   * Crop a region from a PDF page
   * @deprecated Use cropUrl for better memory efficiency
   */
  async crop(params: {
    pdfData: string; // Base64 encoded
    pageNum: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<CropResponse> {
    return requestWithRetry<CropResponse>('/crop', params, {
      timeoutMs: 30000,
    });
  },

  /**
   * Crop a region from a PDF page via URL (memory efficient)
   * Preferred over crop() as it avoids base64 encoding overhead
   */
  async cropUrl(params: {
    pdfUrl: string;
    pageNum: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<CropResponse> {
    return requestWithRetry<CropResponse>('/crop-url', params, {
      timeoutMs: 30000,
    });
  },

  /**
   * Perform OCR on an image
   */
  async ocr(params: {
    image: string; // Base64 encoded
  }): Promise<OcrResponse> {
    return requestWithRetry<OcrResponse>('/ocr', params, {
      timeoutMs: 30000,
    });
  },

  /**
   * Generate an embedding for an image
   */
  async embed(params: {
    image: string; // Base64 encoded
  }): Promise<EmbedResponse> {
    return requestWithRetry<EmbedResponse>('/embed', params, {
      timeoutMs: 30000,
    });
  },

  /**
   * Extract vectors from a PDF page
   */
  async extractVectors(params: {
    pdfUrl?: string;
    pdfData?: string; // Base64 encoded
    pageNum: number;
  }): Promise<VectorExtractionResponse> {
    return requestWithRetry<VectorExtractionResponse>('/vectors', params, {
      timeoutMs: 60000,
    });
  },
};

export default pythonApi;
