/**
 * Storage Module - Vercel Blob Only
 *
 * All files are stored in Vercel Blob storage.
 * No local filesystem operations.
 */

import { put, del, head } from '@vercel/blob';
import { downloadWithTimeout } from './fetch-with-timeout';

export interface UploadResult {
  url: string;
  pathname: string;
}

/**
 * Upload a file to Vercel Blob
 */
export async function uploadFile(
  buffer: Buffer,
  pathname: string,
  options?: { contentType?: string }
): Promise<UploadResult> {
  const blob = await put(pathname, buffer, {
    access: 'public',
    contentType: options?.contentType || 'application/octet-stream',
    addRandomSuffix: false,
  });
  return {
    url: blob.url,
    pathname: blob.pathname,
  };
}

/**
 * Download a file from Vercel Blob
 * @param url - Blob URL to download from
 * @param timeoutMs - Timeout in milliseconds (default 60s)
 */
export async function downloadFile(url: string, timeoutMs: number = 60000): Promise<Buffer> {
  if (!url.startsWith('https://')) {
    throw new Error('URL must be an HTTPS Blob URL');
  }

  return downloadWithTimeout(url, timeoutMs);
}

/**
 * Get file info from Vercel Blob
 */
export async function getFileInfo(url: string): Promise<{ exists: boolean; size?: number; contentType?: string }> {
  if (!url.startsWith('https://')) {
    return { exists: false };
  }

  try {
    const blobInfo = await head(url);
    return {
      exists: true,
      size: blobInfo.size,
      contentType: blobInfo.contentType,
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Check if a file exists in Vercel Blob
 */
export async function fileExists(url: string): Promise<boolean> {
  const info = await getFileInfo(url);
  return info.exists;
}

/**
 * Delete a file from Vercel Blob
 */
export async function deleteFile(url: string): Promise<void> {
  if (!url.startsWith('https://')) {
    throw new Error('URL must be an HTTPS Blob URL');
  }
  await del(url);
}

/**
 * Check if a URL is a Vercel Blob URL
 */
export function isBlobUrl(url: string): boolean {
  return url.startsWith('https://') && url.includes('.blob.');
}

/**
 * Maximum allowed file size (500MB)
 */
export const MAX_FILE_SIZE = 500 * 1024 * 1024;

/**
 * Validate a Blob URL - checks existence and size
 * @param url - Blob URL to validate
 * @param maxSizeBytes - Maximum allowed size in bytes (default 500MB)
 * @returns Validation result with error message if invalid
 */
export async function validateBlobUrl(
  url: string,
  maxSizeBytes: number = MAX_FILE_SIZE
): Promise<{ valid: boolean; size?: number; error?: string }> {
  if (!url.startsWith('https://')) {
    return { valid: false, error: 'URL must be an HTTPS URL' };
  }

  // Check URL format for PDF extension
  try {
    const urlPath = new URL(url).pathname;
    if (!urlPath.toLowerCase().endsWith('.pdf')) {
      return { valid: false, error: 'URL does not point to a PDF file' };
    }
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Get file info to check existence and size
  const info = await getFileInfo(url);
  if (!info.exists) {
    return { valid: false, error: 'File not found in storage' };
  }

  if (info.size && info.size > maxSizeBytes) {
    const sizeMB = Math.round(info.size / (1024 * 1024));
    const maxMB = Math.round(maxSizeBytes / (1024 * 1024));
    return { valid: false, size: info.size, error: `File too large (${sizeMB}MB exceeds ${maxMB}MB limit)` };
  }

  return { valid: true, size: info.size };
}
