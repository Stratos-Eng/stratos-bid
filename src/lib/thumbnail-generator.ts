/**
 * Thumbnail Generator for PDF Documents
 *
 * Generates small preview images for all pages of a PDF document.
 * Thumbnails are stored in Vercel Blob and served via direct CDN URLs.
 */

import sharp from 'sharp';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join, isAbsolute } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PDFDocument } from 'pdf-lib';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { put, head } from '@vercel/blob';
import { downloadFile, isBlobUrl } from '@/lib/storage';

const execFileAsync = promisify(execFile);

// Thumbnail settings
const THUMBNAIL_WIDTH = 150;  // Width in pixels
const THUMBNAIL_DPI = 72;     // Low DPI for fast generation

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
 */
export async function thumbnailExistsInBlob(documentId: string, pageNumber: number): Promise<string | null> {
  try {
    const pathname = getThumbnailBlobPath(documentId, pageNumber);
    // Try to get the blob info - if it exists, return the URL
    const blobInfo = await head(`https://${process.env.BLOB_STORE_ID}.public.blob.vercel-storage.com/${pathname}`);
    return blobInfo.url;
  } catch {
    return null;
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
 */
async function renderPageViaPythonService(
  pdfBuffer: Buffer,
  pageNumber: number
): Promise<Buffer | null> {
  const pythonApiUrl = process.env.PYTHON_VECTOR_API_URL || 'http://localhost:8001';
  const pdfBase64 = pdfBuffer.toString('base64');

  try {
    const response = await fetch(`${pythonApiUrl}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdfData: pdfBase64,
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
 * Render a single page to a thumbnail buffer using pdftoppm (local only)
 */
async function renderPageWithPdftoppm(
  pdfPath: string,
  pageNumber: number
): Promise<Buffer | null> {
  // pdftoppm doesn't support stdout, must write to temp file
  const tempPrefix = join(tmpdir(), `thumb-${randomUUID()}`);
  const tempFile = `${tempPrefix}.png`;

  try {
    // Use pdftoppm to render the page to temp file
    await execFileAsync('pdftoppm', [
      '-f', String(pageNumber),
      '-l', String(pageNumber),
      '-png',
      '-r', String(THUMBNAIL_DPI),
      '-singlefile',
      '-scale-to', String(THUMBNAIL_WIDTH),
      pdfPath,
      tempPrefix
    ], { maxBuffer: 10 * 1024 * 1024 });

    // Read the generated file
    const buffer = await readFile(tempFile);

    // Clean up temp file
    await unlink(tempFile).catch(() => {});

    return buffer;
  } catch (error) {
    // pdftoppm not available (serverless) or failed
    await unlink(tempFile).catch(() => {});
    return null;
  }
}

/**
 * Render a single page to a thumbnail buffer
 * Tries pdftoppm first (local), then Python service (serverless)
 */
async function renderPageThumbnail(
  pdfPath: string,
  pdfBuffer: Buffer,
  pageNumber: number
): Promise<Buffer | null> {
  // Try pdftoppm first (fast, local)
  let result = await renderPageWithPdftoppm(pdfPath, pageNumber);
  if (result) return result;

  // Fall back to Python service (works in serverless)
  result = await renderPageViaPythonService(pdfBuffer, pageNumber);
  return result;
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
 */
export async function generateThumbnails(config: ThumbnailConfig): Promise<ThumbnailResult> {
  const { documentId, storagePath } = config;

  if (!validateDocumentId(documentId)) {
    throw new Error('Invalid documentId format');
  }

  // Download PDF if it's a Blob URL, or read from local path
  const pdfBuffer = isBlobUrl(storagePath)
    ? await downloadFile(storagePath)
    : await readFile(isAbsolute(storagePath) ? storagePath : join(process.cwd(), storagePath));

  // Write to temp file for pdftoppm (local rendering)
  const tempPath = join(tmpdir(), `pdf-${randomUUID()}.pdf`);
  await writeFile(tempPath, pdfBuffer);

  try {
    // Get page count from PDF
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();

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
        // Try to render (pdftoppm first, then Python service)
        let imageBuffer = await renderPageThumbnail(tempPath, pdfBuffer, pageNum);

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
  } finally {
    // Clean up temp file
    await unlink(tempPath).catch(() => {});
  }
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

  // Download PDF if it's a Blob URL, or read from local path
  const pdfBuffer = isBlobUrl(storagePath)
    ? await downloadFile(storagePath)
    : await readFile(isAbsolute(storagePath) ? storagePath : join(process.cwd(), storagePath));

  // Write to temp file for pdftoppm (local rendering)
  const tempPath = join(tmpdir(), `pdf-${randomUUID()}.pdf`);
  await writeFile(tempPath, pdfBuffer);

  try {
    // Try to render (pdftoppm first, then Python service)
    let imageBuffer = await renderPageThumbnail(tempPath, pdfBuffer, pageNumber);

    if (imageBuffer && imageBuffer.length > 0) {
      imageBuffer = await sharp(imageBuffer)
        .webp({ quality: 75 })
        .toBuffer();
    } else {
      imageBuffer = await generatePlaceholderThumbnail(pageNumber);
    }

    // Upload to Blob
    const url = await uploadThumbnailToBlob(documentId, pageNumber, imageBuffer);

    return { url, buffer: imageBuffer };
  } finally {
    // Clean up temp file
    await unlink(tempPath).catch(() => {});
  }
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
