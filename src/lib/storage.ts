/**
 * Storage Module - Vercel Blob Only
 *
 * All files are stored in Vercel Blob storage.
 * No local filesystem operations.
 */

import { put, del, head } from '@vercel/blob';

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
 */
export async function downloadFile(url: string): Promise<Buffer> {
  if (!url.startsWith('https://')) {
    throw new Error('URL must be an HTTPS Blob URL');
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
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
