/**
 * Fetch with Timeout
 *
 * Wraps fetch with configurable timeout to prevent hanging requests.
 */

export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Fetch with configurable timeout
 * @param url - URL to fetch
 * @param options - Fetch options plus optional timeoutMs
 * @returns Response
 * @throws FetchTimeoutError if request times out
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FetchTimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Download file with timeout
 * @param url - URL to download from
 * @param timeoutMs - Timeout in milliseconds (default 60s for large files)
 * @returns Buffer of downloaded content
 */
export async function downloadWithTimeout(
  url: string,
  timeoutMs: number = 60000
): Promise<Buffer> {
  const response = await fetchWithTimeout(url, { timeoutMs });
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
