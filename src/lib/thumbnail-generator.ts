/**
 * Thumbnail Generator for PDF Documents
 *
 * Generates small preview images for all pages of a PDF document.
 * Thumbnails are stored in Vercel Blob and served via direct CDN URLs.
 * PDFs must be stored in Vercel Blob - passes URLs to Python for rendering.
 *
 * Memory optimized: Uses Python metadata endpoint to get page count
 * without loading entire PDF into Node.js memory.
 */

import sharp from 'sharp';
import { put, list } from '@vercel/blob';
import { pythonApi, PythonApiNotConfiguredError } from './python-api';
import { fetchWithTimeout } from './fetch-with-timeout';

// Thumbnail settings
const THUMBNAIL_WIDTH = 150;

export interface ThumbnailConfig {
  documentId: string;
  storagePath: string;  // Blob URL to PDF file
}

export interface ThumbnailResult {
  documentId: string;
  pageCount: number;
  thumbnailsGenerated: number;
  thumbnailUrls: string[];
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
 */
export async function thumbnailExistsInBlob(documentId: string, pageNumber: number): Promise<string | null> {
  try {
    const pathname = getThumbnailBlobPath(documentId, pageNumber);
    const { blobs } = await list({ prefix: pathname, limit: 1 });
    const match = blobs.find(b => b.pathname === pathname);
    return match?.url || null;
  } catch {
    return null;
  }
}

/**
 * Get all thumbnail URLs for a document from Blob storage
 */
export async function getAllThumbnailUrls(documentId: string, pageCount: number): Promise<(string | null)[]> {
  try {
    const prefix = `thumbnails/${documentId}/`;
    const { blobs } = await list({ prefix, limit: pageCount + 10 });

    const urlMap = new Map<number, string>();
    for (const blob of blobs) {
      const match = blob.pathname.match(/\/(\d+)\.webp$/);
      if (match) {
        urlMap.set(parseInt(match[1], 10), blob.url);
      }
    }

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
    addRandomSuffix: false,
  });
  return blob.url;
}

/**
 * Render a page via Python service (passes URL, Python fetches)
 */
async function renderPageViaPythonService(
  pdfUrl: string,
  pageNumber: number
): Promise<Buffer | null> {
  // Check if Python API is configured
  if (!pythonApi.isConfigured()) {
    console.warn('Python API not configured - cannot render PDF page');
    return null;
  }

  try {
    const result = await pythonApi.render({
      pdfUrl,
      pageNum: pageNumber,
      scale: 0.25,
      returnBase64: true,
    });

    if (!result.success || !result.image) {
      console.warn('Python render service failed:', result.error);
      return null;
    }

    return Buffer.from(result.image, 'base64');
  } catch (error) {
    // Don't log config errors as warnings since they're expected in some environments
    if (error instanceof PythonApiNotConfiguredError) {
      return null;
    }
    console.warn(`Python render service failed for page ${pageNumber}:`, error);
    return null;
  }
}

/**
 * Generate a placeholder thumbnail
 */
async function generatePlaceholderThumbnail(
  pageNumber: number,
  width: number = THUMBNAIL_WIDTH,
  height: number = Math.round(THUMBNAIL_WIDTH * 1.4)
): Promise<Buffer> {
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

// Batch size for thumbnail generation
// PDF is cached after first batch, so subsequent batches are fast
const THUMBNAIL_BATCH_SIZE = 10;

/**
 * Generate thumbnails for all pages of a PDF using batch rendering
 *
 * Uses batch rendering to avoid re-downloading the PDF for each page.
 * The Python service caches the PDF after the first batch, making
 * subsequent batches much faster.
 *
 * Before: 100 pages = 100 requests × 148MB PDF download = ~14.8GB transferred
 * After:  100 pages = 10 batches × 1 cached download = ~148MB transferred
 */
export async function generateThumbnails(config: ThumbnailConfig): Promise<ThumbnailResult> {
  const { documentId, storagePath } = config;

  if (!validateDocumentId(documentId)) {
    throw new Error('Invalid documentId format');
  }

  if (!storagePath.startsWith('https://')) {
    throw new Error('storagePath must be a Blob URL');
  }

  // Get page count via Python metadata endpoint (memory efficient)
  // This avoids loading the entire PDF into Node.js memory
  if (!pythonApi.isConfigured()) {
    throw new Error('Python API is required for thumbnail generation');
  }

  const metadata = await pythonApi.metadata({ pdfUrl: storagePath });
  if (!metadata.success) {
    throw new Error(`Failed to get PDF metadata: ${metadata.error}`);
  }
  const pageCount = metadata.pageCount;

  // Initialize thumbnail URLs array
  const thumbnailUrls: (string | null)[] = new Array(pageCount).fill(null);
  let thumbnailsGenerated = 0;

  // Find pages that need thumbnails (don't already exist)
  const pagesToGenerate: number[] = [];
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const existingUrl = await thumbnailExistsInBlob(documentId, pageNum);
    if (existingUrl) {
      thumbnailUrls[pageNum - 1] = existingUrl;
      thumbnailsGenerated++;
    } else {
      pagesToGenerate.push(pageNum);
    }
  }

  console.log(`[thumbnails] ${pagesToGenerate.length} of ${pageCount} pages need thumbnails`);

  // Process in batches using renderBatch endpoint
  // This downloads the PDF once and renders multiple pages
  for (let i = 0; i < pagesToGenerate.length; i += THUMBNAIL_BATCH_SIZE) {
    const batch = pagesToGenerate.slice(i, i + THUMBNAIL_BATCH_SIZE);
    console.log(`[thumbnails] Processing batch ${Math.floor(i / THUMBNAIL_BATCH_SIZE) + 1}: pages ${batch.join(', ')}`);

    try {
      const result = await pythonApi.renderBatch({
        pdfUrl: storagePath,
        pages: batch,
        scale: 0.25, // Thumbnail scale
        format: 'webp',
      });

      if (result.success) {
        // Upload each rendered thumbnail
        for (const pageResult of result.results) {
          try {
            // Convert base64 to buffer and resize for consistent thumbnail size
            const imageBuffer = await sharp(Buffer.from(pageResult.image, 'base64'))
              .resize(THUMBNAIL_WIDTH)
              .webp({ quality: 75 })
              .toBuffer();

            const url = await uploadThumbnailToBlob(documentId, pageResult.page, imageBuffer);
            thumbnailUrls[pageResult.page - 1] = url;
            thumbnailsGenerated++;
          } catch (uploadError) {
            console.error(`Failed to upload thumbnail for page ${pageResult.page}:`, uploadError);
            // Generate placeholder for this page
            const placeholder = await generatePlaceholderThumbnail(pageResult.page);
            const url = await uploadThumbnailToBlob(documentId, pageResult.page, placeholder);
            thumbnailUrls[pageResult.page - 1] = url;
            thumbnailsGenerated++;
          }
        }

        // Handle failed pages from batch
        for (const failedPage of result.failed) {
          console.warn(`[thumbnails] Page ${failedPage} failed in batch, using placeholder`);
          const placeholder = await generatePlaceholderThumbnail(failedPage);
          const url = await uploadThumbnailToBlob(documentId, failedPage, placeholder);
          thumbnailUrls[failedPage - 1] = url;
          thumbnailsGenerated++;
        }
      } else {
        // Entire batch failed - fall back to placeholders
        console.error(`[thumbnails] Batch render failed: ${result.error}`);
        for (const pageNum of batch) {
          const placeholder = await generatePlaceholderThumbnail(pageNum);
          const url = await uploadThumbnailToBlob(documentId, pageNum, placeholder);
          thumbnailUrls[pageNum - 1] = url;
          thumbnailsGenerated++;
        }
      }
    } catch (error) {
      // Batch request failed entirely - fall back to individual rendering
      console.error(`[thumbnails] Batch request failed, falling back to individual renders:`, error);
      for (const pageNum of batch) {
        try {
          const imageBuffer = await renderPageViaPythonService(storagePath, pageNum);
          if (imageBuffer && imageBuffer.length > 0) {
            const processed = await sharp(imageBuffer)
              .resize(THUMBNAIL_WIDTH)
              .webp({ quality: 75 })
              .toBuffer();
            const url = await uploadThumbnailToBlob(documentId, pageNum, processed);
            thumbnailUrls[pageNum - 1] = url;
          } else {
            const placeholder = await generatePlaceholderThumbnail(pageNum);
            const url = await uploadThumbnailToBlob(documentId, pageNum, placeholder);
            thumbnailUrls[pageNum - 1] = url;
          }
          thumbnailsGenerated++;
        } catch (err) {
          console.error(`Failed to generate thumbnail for page ${pageNum}:`, err);
          const placeholder = await generatePlaceholderThumbnail(pageNum);
          const url = await uploadThumbnailToBlob(documentId, pageNum, placeholder);
          thumbnailUrls[pageNum - 1] = url;
          thumbnailsGenerated++;
        }
      }
    }
  }

  return {
    documentId,
    pageCount,
    thumbnailsGenerated,
    thumbnailUrls: thumbnailUrls.filter((url): url is string => url !== null),
  };
}

/**
 * Generate a single thumbnail
 */
export async function generateSingleThumbnail(
  documentId: string,
  storagePath: string,
  pageNumber: number
): Promise<{ url: string; buffer: Buffer }> {
  if (!validateDocumentId(documentId)) {
    throw new Error('Invalid documentId format');
  }

  if (!storagePath.startsWith('https://')) {
    throw new Error('storagePath must be a Blob URL');
  }

  // Check if already exists
  const existingUrl = await thumbnailExistsInBlob(documentId, pageNumber);
  if (existingUrl) {
    const response = await fetchWithTimeout(existingUrl, { timeoutMs: 30000 });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { url: existingUrl, buffer };
  }

  // Render via Python
  const rendered = await renderPageViaPythonService(storagePath, pageNumber);
  let imageBuffer: Buffer;

  if (rendered && rendered.length > 0) {
    imageBuffer = await sharp(rendered).webp({ quality: 75 }).toBuffer();
  } else {
    imageBuffer = await generatePlaceholderThumbnail(pageNumber);
  }

  const url = await uploadThumbnailToBlob(documentId, pageNumber, imageBuffer);
  return { url, buffer: imageBuffer };
}

/**
 * Get thumbnail (from Blob or generate on-demand)
 */
export async function getThumbnail(
  documentId: string,
  storagePath: string,
  pageNumber: number
): Promise<{ url: string; buffer: Buffer }> {
  const existingUrl = await thumbnailExistsInBlob(documentId, pageNumber);
  if (existingUrl) {
    const response = await fetchWithTimeout(existingUrl, { timeoutMs: 30000 });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { url: existingUrl, buffer };
  }

  return generateSingleThumbnail(documentId, storagePath, pageNumber);
}
