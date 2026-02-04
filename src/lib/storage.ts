/**
 * Storage Module - DigitalOcean Spaces (S3-compatible)
 *
 * All files are stored in DigitalOcean Spaces.
 * Uses AWS S3 SDK for compatibility.
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { downloadWithTimeout } from './fetch-with-timeout';

// Configuration from environment
const BUCKET = process.env.DO_SPACES_BUCKET || '';
const REGION = process.env.DO_SPACES_REGION || 'nyc3';

// Derive the bare regional endpoint (strip bucket prefix if included).
// e.g. "https://my-bucket.sfo3.digitaloceanspaces.com" → "https://sfo3.digitaloceanspaces.com"
function getBareEndpoint(): string {
  const raw =
    process.env.DO_SPACES_ENDPOINT || `https://${REGION}.digitaloceanspaces.com`;
  try {
    const u = new URL(raw);
    const parts = u.hostname.split('.');
    // If hostname has 3+ parts and the first matches the bucket, strip it
    if (
      parts.length >= 3 &&
      parts[0] === BUCKET
    ) {
      u.hostname = parts.slice(1).join('.');
    }
    return u.origin;
  } catch {
    return raw;
  }
}

const ENDPOINT = getBareEndpoint();

// Derive the actual region from the endpoint (e.g. sfo3 from sfo3.digitaloceanspaces.com)
function getRegionFromEndpoint(): string {
  try {
    const u = new URL(ENDPOINT);
    const first = u.hostname.split('.')[0];
    return first || REGION;
  } catch {
    return REGION;
  }
}

const EFFECTIVE_REGION = getRegionFromEndpoint();

// Public base URL for constructing direct access URLs
const PUBLIC_BASE_URL = `https://${BUCKET}.${EFFECTIVE_REGION}.digitaloceanspaces.com`;

// Lazy-initialize S3 client (avoids errors when env vars not yet set at import time)
let _s3: S3Client | null = null;
function getS3Client(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      endpoint: ENDPOINT,
      region: EFFECTIVE_REGION,
      credentials: {
        accessKeyId: process.env.DO_SPACES_KEY || '',
        secretAccessKey: process.env.DO_SPACES_SECRET || '',
      },
      forcePathStyle: false,
    });
  }
  return _s3;
}

export interface UploadResult {
  url: string;
  pathname: string;
}

/**
 * Maximum allowed file size (500MB)
 */
export const MAX_FILE_SIZE = 500 * 1024 * 1024;

/**
 * Extract S3 key from a storage URL
 */
function extractKeyFromUrl(url: string): string {
  const urlObj = new URL(url);
  return urlObj.pathname.slice(1); // Remove leading /
}

/**
 * Upload a file to DigitalOcean Spaces
 */
export async function uploadFile(
  buffer: Buffer,
  pathname: string,
  options?: { contentType?: string; allowOverwrite?: boolean }
): Promise<UploadResult> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: pathname,
      Body: buffer,
      ContentType: options?.contentType || 'application/octet-stream',
      ACL: 'public-read',
    })
  );

  const url = `${PUBLIC_BASE_URL}/${pathname}`;
  return { url, pathname };
}

/**
 * Download a file from storage
 * Uses authenticated S3 GetObject for DO Spaces URLs,
 * falls back to public HTTP fetch for legacy Vercel Blob URLs.
 * @param url - URL to download from
 * @param timeoutMs - Timeout in milliseconds (default 60s)
 */
export async function downloadFile(
  url: string,
  timeoutMs: number = 60000
): Promise<Buffer> {
  if (!url.startsWith('https://')) {
    throw new Error('URL must be an HTTPS URL');
  }

  // For DO Spaces URLs, use authenticated S3 SDK download
  if (url.includes('.digitaloceanspaces.com')) {
    const key = extractKeyFromUrl(url);
    const result = await getS3Client().send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
      })
    );

    if (!result.Body) {
      throw new Error('Empty response body from S3');
    }

    // Convert readable stream to Buffer
    const chunks: Uint8Array[] = [];
    const stream = result.Body as AsyncIterable<Uint8Array>;
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // For legacy Vercel Blob URLs or other HTTPS URLs, use public fetch
  return downloadWithTimeout(url, timeoutMs);
}

/**
 * Get file info from storage
 */
export async function getFileInfo(
  url: string
): Promise<{ exists: boolean; size?: number; contentType?: string }> {
  if (!url.startsWith('https://')) {
    return { exists: false };
  }

  // For legacy Vercel Blob URLs, use a HEAD fetch instead of S3 SDK
  if (url.includes('.blob.') && !url.includes('.digitaloceanspaces.com')) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok) {
        return {
          exists: true,
          size: Number(response.headers.get('content-length')) || undefined,
          contentType: response.headers.get('content-type') || undefined,
        };
      }
      return { exists: false };
    } catch {
      return { exists: false };
    }
  }

  try {
    const key = extractKeyFromUrl(url);
    const result = await getS3Client().send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        Key: key,
      })
    );
    return {
      exists: true,
      size: result.ContentLength,
      contentType: result.ContentType,
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Check if a file exists in storage
 */
export async function fileExists(url: string): Promise<boolean> {
  const info = await getFileInfo(url);
  return info.exists;
}

/**
 * Delete a file from storage
 */
export async function deleteFile(url: string): Promise<void> {
  if (!url.startsWith('https://')) {
    throw new Error('URL must be an HTTPS URL');
  }

  // Skip deletion of legacy Vercel Blob URLs (can't delete via S3 SDK)
  if (url.includes('.blob.') && !url.includes('.digitaloceanspaces.com')) {
    console.warn(
      `[storage] Skipping deletion of legacy Vercel Blob URL: ${url}`
    );
    return;
  }

  const key = extractKeyFromUrl(url);
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
}

/**
 * Check if a URL is a cloud storage URL (DO Spaces or legacy Vercel Blob)
 */
export function isStorageUrl(url: string): boolean {
  return (
    url.startsWith('https://') &&
    (url.includes('.digitaloceanspaces.com') || url.includes('.blob.'))
  );
}

/**
 * Backwards-compatible alias for isStorageUrl
 */
export const isBlobUrl = isStorageUrl;

/**
 * Get the pathname for a single-page PDF
 * Pages are stored at: pages/{documentId}/{pageNumber}.pdf
 */
export function getPagePdfPath(
  documentId: string,
  pageNumber: number
): string {
  return `pages/${documentId}/${pageNumber}.pdf`;
}

/**
 * Upload a single page PDF to storage
 */
export async function uploadPagePdf(
  documentId: string,
  pageNumber: number,
  buffer: Buffer
): Promise<UploadResult> {
  const pathname = getPagePdfPath(documentId, pageNumber);
  return uploadFile(buffer, pathname, { contentType: 'application/pdf' });
}

/**
 * Check if a single-page PDF exists in storage
 * Returns the URL if it exists, null otherwise
 */
export async function getPagePdfUrl(
  documentId: string,
  pageNumber: number,
  _baseUrl?: string
): Promise<string | null> {
  const pathname = getPagePdfPath(documentId, pageNumber);
  const url = `${PUBLIC_BASE_URL}/${pathname}`;

  const exists = await fileExists(url);
  return exists ? url : null;
}

/**
 * Validate a storage URL - checks existence and size
 * @param url - URL to validate
 * @param maxSizeBytes - Maximum allowed size in bytes (default 500MB)
 */
export async function validateStorageUrl(
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
    return {
      valid: false,
      size: info.size,
      error: `File too large (${sizeMB}MB exceeds ${maxMB}MB limit)`,
    };
  }

  return { valid: true, size: info.size };
}

/**
 * Backwards-compatible alias for validateStorageUrl
 */
export const validateBlobUrl = validateStorageUrl;

/**
 * Generate a presigned URL for client-side direct upload
 * @param key - S3 object key
 * @param contentType - MIME type (default: application/pdf)
 */
export async function getPresignedUploadUrl(
  key: string,
  contentType: string = 'application/pdf'
): Promise<{ url: string; key: string; publicUrl: string }> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    ACL: 'public-read',
  });

  const url = await getSignedUrl(getS3Client(), command, { expiresIn: 3600 });

  return {
    url,
    key,
    publicUrl: `${PUBLIC_BASE_URL}/${key}`,
  };
}
