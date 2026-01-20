import { put, del, head } from '@vercel/blob';
import fs from 'fs';
import path from 'path';

// Storage provider type
type StorageProvider = 'local' | 'vercel-blob';

// Determine provider based on environment
function getProvider(): StorageProvider {
  // Use Vercel Blob if BLOB_READ_WRITE_TOKEN is set (Vercel sets this automatically)
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return 'vercel-blob';
  }
  return 'local';
}

export interface UploadResult {
  url: string; // For local: file path, for blob: full URL
  pathname: string; // Logical path (e.g., "projects/abc123/file.pdf")
}

export interface StorageFile {
  exists: boolean;
  size?: number;
  contentType?: string;
}

/**
 * Upload a file to storage
 * @param buffer - File contents
 * @param pathname - Logical path (e.g., "projects/abc123/file.pdf")
 * @param options - Upload options
 */
export async function uploadFile(
  buffer: Buffer,
  pathname: string,
  options?: { contentType?: string }
): Promise<UploadResult> {
  const provider = getProvider();

  if (provider === 'vercel-blob') {
    const blob = await put(pathname, buffer, {
      access: 'public',
      contentType: options?.contentType || 'application/octet-stream',
    });
    return {
      url: blob.url,
      pathname: blob.pathname,
    };
  }

  // Local storage
  const fullPath = path.join(process.cwd(), 'uploads', pathname);
  const dir = path.dirname(fullPath);

  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(fullPath, buffer);

  return {
    url: fullPath,
    pathname,
  };
}

/**
 * Download a file from storage
 * @param urlOrPath - Either a Vercel Blob URL or local file path
 */
export async function downloadFile(urlOrPath: string): Promise<Buffer> {
  // Check if it's a Vercel Blob URL
  if (urlOrPath.startsWith('https://') && urlOrPath.includes('.blob.')) {
    const response = await fetch(urlOrPath);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // Local file
  let resolvedPath = urlOrPath;
  if (!path.isAbsolute(urlOrPath)) {
    resolvedPath = path.join(process.cwd(), urlOrPath);
  }

  return fs.promises.readFile(resolvedPath);
}

/**
 * Get file info without downloading
 * @param urlOrPath - Either a Vercel Blob URL or local file path
 */
export async function getFileInfo(urlOrPath: string): Promise<StorageFile> {
  // Check if it's a Vercel Blob URL
  if (urlOrPath.startsWith('https://') && urlOrPath.includes('.blob.')) {
    try {
      const blobInfo = await head(urlOrPath);
      return {
        exists: true,
        size: blobInfo.size,
        contentType: blobInfo.contentType,
      };
    } catch {
      return { exists: false };
    }
  }

  // Local file
  let resolvedPath = urlOrPath;
  if (!path.isAbsolute(urlOrPath)) {
    resolvedPath = path.join(process.cwd(), urlOrPath);
  }

  try {
    const stats = await fs.promises.stat(resolvedPath);
    return {
      exists: true,
      size: stats.size,
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Check if a file exists
 * @param urlOrPath - Either a Vercel Blob URL or local file path
 */
export async function fileExists(urlOrPath: string): Promise<boolean> {
  const info = await getFileInfo(urlOrPath);
  return info.exists;
}

/**
 * Delete a file from storage
 * @param urlOrPath - Either a Vercel Blob URL or local file path
 */
export async function deleteFile(urlOrPath: string): Promise<void> {
  // Check if it's a Vercel Blob URL
  if (urlOrPath.startsWith('https://') && urlOrPath.includes('.blob.')) {
    await del(urlOrPath);
    return;
  }

  // Local file
  let resolvedPath = urlOrPath;
  if (!path.isAbsolute(urlOrPath)) {
    resolvedPath = path.join(process.cwd(), urlOrPath);
  }

  try {
    await fs.promises.unlink(resolvedPath);
  } catch (error) {
    // Ignore if file doesn't exist
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Create a readable stream for a file
 * For local files, returns a Node.js ReadStream
 * For Vercel Blob, fetches and returns the response body
 */
export async function createReadStream(urlOrPath: string): Promise<ReadableStream<Uint8Array> | fs.ReadStream> {
  // Check if it's a Vercel Blob URL
  if (urlOrPath.startsWith('https://') && urlOrPath.includes('.blob.')) {
    const response = await fetch(urlOrPath);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status}`);
    }
    if (!response.body) {
      throw new Error('No response body');
    }
    return response.body;
  }

  // Local file
  let resolvedPath = urlOrPath;
  if (!path.isAbsolute(urlOrPath)) {
    resolvedPath = path.join(process.cwd(), urlOrPath);
  }

  return fs.createReadStream(resolvedPath);
}

/**
 * Resolve a storage path to a full local path (for local provider only)
 * Used for operations that require local filesystem access (e.g., PDF processing)
 */
export function resolveLocalPath(storagePath: string): string {
  if (storagePath.startsWith('https://')) {
    throw new Error('Cannot resolve Vercel Blob URL to local path');
  }

  if (path.isAbsolute(storagePath)) {
    return storagePath;
  }

  return path.join(process.cwd(), storagePath);
}

/**
 * Check if we're using local storage
 */
export function isLocalStorage(): boolean {
  return getProvider() === 'local';
}

/**
 * Check if a path is a Vercel Blob URL
 */
export function isBlobUrl(urlOrPath: string): boolean {
  return urlOrPath.startsWith('https://') && urlOrPath.includes('.blob.');
}
