/**
 * Thumbnail Generator for PDF Documents
 *
 * Generates small preview images for all pages of a PDF document.
 * Thumbnails are stored on disk and served via API.
 */

import sharp from 'sharp';
import { readFile, mkdir, writeFile, access, unlink } from 'fs/promises';
import { join, dirname, isAbsolute } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PDFDocument } from 'pdf-lib';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { downloadFile, isBlobUrl } from '@/lib/storage';

const execFileAsync = promisify(execFile);

// Thumbnail settings
const THUMBNAIL_WIDTH = 150;  // Width in pixels
const THUMBNAIL_DPI = 72;     // Low DPI for fast generation

// Use /tmp for serverless environments (Vercel has read-only filesystem except /tmp)
const THUMBNAILS_DIR = process.env.VERCEL ? '/tmp/thumbnails' : 'thumbnails';

export interface ThumbnailConfig {
  documentId: string;
  storagePath: string;  // Path to PDF file
}

export interface ThumbnailResult {
  documentId: string;
  pageCount: number;
  thumbnailsGenerated: number;
  outputDir: string;
}

/**
 * Validate documentId is UUID format
 */
function validateDocumentId(id: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(id);
}

/**
 * Get the output directory for a document's thumbnails
 */
export function getThumbnailDir(documentId: string): string {
  // On Vercel, THUMBNAILS_DIR is already an absolute path (/tmp/thumbnails)
  if (process.env.VERCEL) {
    return join(THUMBNAILS_DIR, documentId);
  }
  return join(process.cwd(), THUMBNAILS_DIR, documentId);
}

/**
 * Get the path to a specific page's thumbnail
 */
export function getThumbnailPath(documentId: string, pageNumber: number): string {
  return join(getThumbnailDir(documentId), `${pageNumber}.webp`);
}

/**
 * Check if a thumbnail exists
 */
export async function thumbnailExists(documentId: string, pageNumber: number): Promise<boolean> {
  try {
    await access(getThumbnailPath(documentId, pageNumber));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if all thumbnails exist for a document
 */
export async function allThumbnailsExist(documentId: string, pageCount: number): Promise<boolean> {
  for (let i = 1; i <= pageCount; i++) {
    if (!(await thumbnailExists(documentId, i))) {
      return false;
    }
  }
  return true;
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
 * Generate thumbnails for all pages of a PDF document
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

    // Create output directory
    const outputDir = getThumbnailDir(documentId);
    await mkdir(outputDir, { recursive: true });

    let thumbnailsGenerated = 0;

    // Generate thumbnail for each page
    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const thumbnailPath = getThumbnailPath(documentId, pageNum);

      // Skip if already exists
      if (await thumbnailExists(documentId, pageNum)) {
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

        // Save thumbnail
        await mkdir(dirname(thumbnailPath), { recursive: true });
        await writeFile(thumbnailPath, imageBuffer);
        thumbnailsGenerated++;

      } catch (error) {
        console.error(`Failed to generate thumbnail for page ${pageNum}:`, error);
        // Generate placeholder on error
        const placeholder = await generatePlaceholderThumbnail(pageNum);
        await writeFile(thumbnailPath, placeholder);
        thumbnailsGenerated++;
      }
    }

    return {
      documentId,
      pageCount,
      thumbnailsGenerated,
      outputDir,
    };
  } finally {
    // Clean up temp file
    await unlink(tempPath).catch(() => {});
  }
}

/**
 * Generate a single page thumbnail (for on-demand generation)
 */
export async function generateSingleThumbnail(
  documentId: string,
  storagePath: string,
  pageNumber: number
): Promise<Buffer> {
  if (!validateDocumentId(documentId)) {
    throw new Error('Invalid documentId format');
  }

  const thumbnailPath = getThumbnailPath(documentId, pageNumber);

  // Check if already exists
  try {
    return await readFile(thumbnailPath);
  } catch {
    // Need to generate
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

    // Save for future requests
    await mkdir(dirname(thumbnailPath), { recursive: true });
    await writeFile(thumbnailPath, imageBuffer);

    return imageBuffer;
  } finally {
    // Clean up temp file
    await unlink(tempPath).catch(() => {});
  }
}

/**
 * Get thumbnail buffer (from cache or generate on-demand)
 */
export async function getThumbnail(
  documentId: string,
  storagePath: string,
  pageNumber: number
): Promise<Buffer> {
  const thumbnailPath = getThumbnailPath(documentId, pageNumber);

  try {
    // Try to read from cache
    return await readFile(thumbnailPath);
  } catch {
    // Generate on-demand
    return generateSingleThumbnail(documentId, storagePath, pageNumber);
  }
}
