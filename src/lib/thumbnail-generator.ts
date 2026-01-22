/**
 * Thumbnail Generator for PDF Documents
 *
 * Generates small preview images for all pages of a PDF document.
 * Thumbnails are stored in Vercel Blob and served via direct CDN URLs.
 * Uses Python service for rendering - passes URLs to avoid memory overhead.
 */

import sharp from 'sharp';
import { readFile } from 'fs/promises';
import { join, isAbsolute } from 'path';
import { PDFDocument } from 'pdf-lib';
import { put, list } from '@vercel/blob';
import { isBlobUrl } from '@/lib/storage';

// Thumbnail settings
const THUMBNAIL_WIDTH = 150;  // Width in pixels

export interface ThumbnailConfig {
  documentId: string;
  storagePath: string;  // Path to PDF file (local or Blob URL)
}

export interface ThumbnailResult {
  documentId: string;
  pageCount: number;
  thumbnailsGenerated: number;
  thumbnailUrls: string[];  // Blob URLs for all thumbnails
}

/**
 * Validate documentId is UUID format
 */
function validateDocumentId(id: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(id);
}

/**
 * Get the Blob pathname for a thumbnail
 */
export function getThumbnailBlobPath(documentId: string, pageNumber: number): string {
  return `thumbnails/${documentId}/${pageNumber}.webp`;
}

/**
 * Check if a thumbnail exists in Blob storage
 * Returns the Blob URL if exists, null otherwise
 */
export async function thumbnailExistsInBlob(documentId: string, pageNumber: number): Promise<string | null> {
  try {
    const pathname = getThumbnailBlobPath(documentId, pageNumber);
    // List blobs with exact pathname prefix
    const { blobs } = await list({ prefix: pathname, limit: 1 });
    // Check if we found the exact file (not just prefix match)
    const match = blobs.find(b => b.pathname === pathname);
    return match?.url || null;
  } catch {
    return null;
  }
}

/**
 * Get all thumbnail URLs for a document from Blob storage
 * Returns an array where index corresponds to page number - 1
 * Null values indicate missing thumbnails
 */
export async function getAllThumbnailUrls(documentId: string, pageCount: number): Promise<(string | null)[]> {
  try {
    // List all blobs under this document's thumbnail prefix
    const prefix = `thumbnails/${documentId}/`;
    const { blobs } = await list({ prefix, limit: pageCount + 10 }); // +10 buffer

    // Build a map of page number -> URL
    const urlMap = new Map<number, string>();
    for (const blob of blobs) {
      // Extract page number from pathname like "thumbnails/{docId}/1.webp"
      const match = blob.pathname.match(/\/(\d+)\.webp$/);
      if (match) {
        urlMap.set(parseInt(match[1], 10), blob.url);
      }
    }

    // Build result array
    const urls: (string | null)[] = [];
    for (let i = 1; i <= pageCount; i++) {
      urls.push(urlMap.get(i) || null);
    }
    return urls;
  } catch (error) {
    console.error('Failed to list thumbnail URLs:', error);
    return new Array(pageCount).fill(null);
  }
}

/**
 * Upload a thumbnail to Blob storage
 */
async function uploadThumbnailToBlob(
  documentId: string,
  pageNumber: number,
  imageBuffer: Buffer
): Promise<string> {
  const pathname = getThumbnailBlobPath(documentId, pageNumber);
  const blob = await put(pathname, imageBuffer, {
    access: 'public',
    contentType: 'image/webp',
    addRandomSuffix: false, // Use exact pathname
  });
  return blob.url;
}

/**
 * Get all thumbnail URLs for a document (checks what exists in Blob)
 */
export async function getThumbnailUrls(documentId: string, pageCount: number): Promise<(string | null)[]> {
  const urls: (string | null)[] = [];
  for (let i = 1; i <= pageCount; i++) {
    urls.push(await thumbnailExistsInBlob(documentId, i));
  }
  return urls;
}

/**
 * Render a single page using the Python service
 * Prefers URL-based fetching to reduce memory usage
 */
async function renderPageViaPythonService(
  pdfUrlOrBuffer: string | Buffer,
  pageNumber: number
): Promise<Buffer | null> {
  const pythonApiUrl = process.env.PYTHON_VECTOR_API_URL || 'http://localhost:8001';

  // Prefer URL to avoid base64 encoding overhead
  const isUrl = typeof pdfUrlOrBuffer === 'string';

  try {
    const response = await fetch(`${pythonApiUrl}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(isUrl
          ? { pdfUrl: pdfUrlOrBuffer }
          : { pdfData: pdfUrlOrBuffer.toString('base64') }),
        pageNum: pageNumber,
        scale: 0.25, // Small scale for thumbnails (roughly 150px width)
        returnBase64: true,
      }),
    });

    if (!response.ok) {
      console.warn(`Python render service returned ${response.status}`);
      return null;
    }

    const result = await response.json();
    if (!result.success || !result.image) {
      console.warn('Python render service returned unsuccessful result');
      return null;
    }

    return Buffer.from(result.image, 'base64');
  } catch (error) {
    console.warn(`Python render service failed for page ${pageNumber}:`, error);
    return null;
  }
}


/**
 * Generate a placeholder thumbnail when pdftoppm fails
 */
async function generatePlaceholderThumbnail(
  pageNumber: number,
  width: number = THUMBNAIL_WIDTH,
  height: number = Math.round(THUMBNAIL_WIDTH * 1.4)  // Approximate letter ratio
): Promise<Buffer> {
  // Create a light gray placeholder with page number
  const svg = `
    <svg width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#f5f5f3"/>
      <text x="50%" y="50%" text-anchor="middle" dy="0.3em"
            font-family="sans-serif" font-size="14" fill="#999">
        Page ${pageNumber}
      </text>
    </svg>
  `;

  return sharp(Buffer.from(svg))
    .webp({ quality: 80 })
    .toBuffer();
}

/**
 * Generate thumbnails for all pages of a PDF document and upload to Blob
 * Uses URL-based rendering when possible to minimize memory usage
 */
export async function generateThumbnails(config: ThumbnailConfig): Promise<ThumbnailResult> {
  const { documentId, storagePath } = config;

  if (!validateDocumentId(documentId)) {
    throw new Error('Invalid documentId format');
  }

  // For Blob URLs, we'll pass URL directly to Python (no download needed)
  // For local files, we still need to load the buffer
  const usesUrl = isBlobUrl(storagePath);

  // We need to get page count - use pdf-lib which can work with URLs or buffers
  let pageCount: number;
  let pdfBuffer: Buffer | null = null;

  if (usesUrl) {
    // Fetch just enough to get page count, then let Python handle rendering
    const response = await fetch(storagePath);
    if (!response.ok) {
      throw new Error(`Failed to fetch PDF: ${response.status}`);
    }
    pdfBuffer = Buffer.from(await response.arrayBuffer());
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pageCount = pdfDoc.getPageCount();
    // Clear buffer - Python will fetch from URL
    pdfBuffer = null;
  } else {
    pdfBuffer = await readFile(isAbsolute(storagePath) ? storagePath : join(process.cwd(), storagePath));
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pageCount = pdfDoc.getPageCount();
  }

  let thumbnailsGenerated = 0;
  const thumbnailUrls: string[] = [];

  // Generate thumbnail for each page
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    // Check if already exists in Blob
    const existingUrl = await thumbnailExistsInBlob(documentId, pageNum);
    if (existingUrl) {
      thumbnailUrls.push(existingUrl);
      thumbnailsGenerated++;
      continue;
    }

    try {
      // Use Python service - pass URL when available, otherwise buffer
      let imageBuffer = usesUrl
        ? await renderPageViaPythonService(storagePath, pageNum)
        : await renderPageViaPythonService(pdfBuffer!, pageNum);

      if (imageBuffer && imageBuffer.length > 0) {
        // Convert to WebP for better compression
        imageBuffer = await sharp(imageBuffer)
          .webp({ quality: 75 })
          .toBuffer();
      } else {
        // Fall back to placeholder
        imageBuffer = await generatePlaceholderThumbnail(pageNum);
      }

      // Upload to Blob
      const url = await uploadThumbnailToBlob(documentId, pageNum, imageBuffer);
      thumbnailUrls.push(url);
      thumbnailsGenerated++;

    } catch (error) {
      console.error(`Failed to generate thumbnail for page ${pageNum}:`, error);
      // Generate and upload placeholder on error
      const placeholder = await generatePlaceholderThumbnail(pageNum);
      const url = await uploadThumbnailToBlob(documentId, pageNum, placeholder);
      thumbnailUrls.push(url);
      thumbnailsGenerated++;
    }
  }

  return {
    documentId,
    pageCount,
    thumbnailsGenerated,
    thumbnailUrls,
  };
}

/**
 * Generate a single page thumbnail and upload to Blob
 * Returns the Blob URL
 */
export async function generateSingleThumbnail(
  documentId: string,
  storagePath: string,
  pageNumber: number
): Promise<{ url: string; buffer: Buffer }> {
  if (!validateDocumentId(documentId)) {
    throw new Error('Invalid documentId format');
  }

  // Check if already exists in Blob
  const existingUrl = await thumbnailExistsInBlob(documentId, pageNumber);
  if (existingUrl) {
    // Fetch the existing thumbnail
    const response = await fetch(existingUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { url: existingUrl, buffer };
  }

  // Use URL-based rendering when possible (avoids downloading entire PDF)
  const usesUrl = isBlobUrl(storagePath);

  let imageBuffer: Buffer;
  if (usesUrl) {
    // Pass URL to Python - it will fetch what it needs
    const rendered = await renderPageViaPythonService(storagePath, pageNumber);
    if (rendered && rendered.length > 0) {
      imageBuffer = await sharp(rendered).webp({ quality: 75 }).toBuffer();
    } else {
      imageBuffer = await generatePlaceholderThumbnail(pageNumber);
    }
  } else {
    // Local file - load buffer and pass to Python
    const pdfBuffer = await readFile(isAbsolute(storagePath) ? storagePath : join(process.cwd(), storagePath));
    const rendered = await renderPageViaPythonService(pdfBuffer, pageNumber);
    if (rendered && rendered.length > 0) {
      imageBuffer = await sharp(rendered).webp({ quality: 75 }).toBuffer();
    } else {
      imageBuffer = await generatePlaceholderThumbnail(pageNumber);
    }
  }

  // Upload to Blob
  const url = await uploadThumbnailToBlob(documentId, pageNumber, imageBuffer);

  return { url, buffer: imageBuffer };
}

/**
 * Get thumbnail (from Blob or generate on-demand)
 * Returns both the URL and the buffer
 */
export async function getThumbnail(
  documentId: string,
  storagePath: string,
  pageNumber: number
): Promise<{ url: string; buffer: Buffer }> {
  // Check if exists in Blob
  const existingUrl = await thumbnailExistsInBlob(documentId, pageNumber);
  if (existingUrl) {
    const response = await fetch(existingUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { url: existingUrl, buffer };
  }

  // Generate on-demand and upload to Blob
  return generateSingleThumbnail(documentId, storagePath, pageNumber);
}
