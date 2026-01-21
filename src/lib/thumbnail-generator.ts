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
const THUMBNAILS_DIR = 'thumbnails';

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
 * Render a single page to a thumbnail buffer using pdftoppm
 */
async function renderPageThumbnail(
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
    console.warn(`pdftoppm failed for page ${pageNumber}:`, error);
    // Clean up temp file on error
    await unlink(tempFile).catch(() => {});
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
 * Resolve storage path - handles absolute paths, relative paths, and Blob URLs
 * For Blob URLs, downloads to a temp file and returns the temp path
 */
async function resolveStoragePath(storagePath: string): Promise<{ path: string; isTemp: boolean }> {
  if (isBlobUrl(storagePath)) {
    // Download to temp file for pdftoppm
    const tempPath = join(tmpdir(), `pdf-${randomUUID()}.pdf`);
    const buffer = await downloadFile(storagePath);
    await writeFile(tempPath, buffer);
    return { path: tempPath, isTemp: true };
  }

  if (isAbsolute(storagePath)) {
    return { path: storagePath, isTemp: false };
  }
  return { path: join(process.cwd(), storagePath), isTemp: false };
}

/**
 * Generate thumbnails for all pages of a PDF document
 */
export async function generateThumbnails(config: ThumbnailConfig): Promise<ThumbnailResult> {
  const { documentId, storagePath } = config;

  if (!validateDocumentId(documentId)) {
    throw new Error('Invalid documentId format');
  }

  const resolved = await resolveStoragePath(storagePath);
  const fullPath = resolved.path;

  try {
    // Get page count from PDF
    const pdfBytes = await readFile(fullPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
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
        // Try to render with pdftoppm
        let imageBuffer = await renderPageThumbnail(fullPath, pageNum);

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
    // Clean up temp file if we downloaded from Blob
    if (resolved.isTemp) {
      await unlink(fullPath).catch(() => {});
    }
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

  const resolved = await resolveStoragePath(storagePath);
  const fullPath = resolved.path;

  try {
    // Try to render with pdftoppm
    let imageBuffer = await renderPageThumbnail(fullPath, pageNumber);

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
    // Clean up temp file if we downloaded from Blob
    if (resolved.isTemp) {
      await unlink(fullPath).catch(() => {});
    }
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
