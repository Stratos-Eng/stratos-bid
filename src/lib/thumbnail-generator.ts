/**
 * Thumbnail Generator for PDF Documents
 *
 * Generates small preview images for all pages of a PDF document.
 * Thumbnails are stored in Vercel Blob and served via direct CDN URLs.
 * PDFs must be stored in Vercel Blob - passes URLs to Python for rendering.
 */

import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { put, list } from '@vercel/blob';

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
  const pythonApiUrl = process.env.PYTHON_VECTOR_API_URL || 'http://localhost:8001';

  try {
    const response = await fetch(`${pythonApiUrl}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdfUrl,
        pageNum: pageNumber,
        scale: 0.25,
        returnBase64: true,
      }),
    });

    if (!response.ok) {
      console.warn(`Python render service returned ${response.status}`);
      return null;
    }

    const result = await response.json();
    if (!result.success || !result.image) {
      console.warn('Python render service failed:', result.error);
      return null;
    }

    return Buffer.from(result.image, 'base64');
  } catch (error) {
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

/**
 * Generate thumbnails for all pages of a PDF
 */
export async function generateThumbnails(config: ThumbnailConfig): Promise<ThumbnailResult> {
  const { documentId, storagePath } = config;

  if (!validateDocumentId(documentId)) {
    throw new Error('Invalid documentId format');
  }

  if (!storagePath.startsWith('https://')) {
    throw new Error('storagePath must be a Blob URL');
  }

  // Fetch PDF to get page count
  const response = await fetch(storagePath);
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF: ${response.status}`);
  }
  const pdfBuffer = Buffer.from(await response.arrayBuffer());
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pageCount = pdfDoc.getPageCount();

  let thumbnailsGenerated = 0;
  const thumbnailUrls: string[] = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    // Check if already exists
    const existingUrl = await thumbnailExistsInBlob(documentId, pageNum);
    if (existingUrl) {
      thumbnailUrls.push(existingUrl);
      thumbnailsGenerated++;
      continue;
    }

    try {
      // Render via Python (it fetches PDF from URL)
      let imageBuffer = await renderPageViaPythonService(storagePath, pageNum);

      if (imageBuffer && imageBuffer.length > 0) {
        imageBuffer = await sharp(imageBuffer).webp({ quality: 75 }).toBuffer();
      } else {
        imageBuffer = await generatePlaceholderThumbnail(pageNum);
      }

      const url = await uploadThumbnailToBlob(documentId, pageNum, imageBuffer);
      thumbnailUrls.push(url);
      thumbnailsGenerated++;
    } catch (error) {
      console.error(`Failed to generate thumbnail for page ${pageNum}:`, error);
      const placeholder = await generatePlaceholderThumbnail(pageNum);
      const url = await uploadThumbnailToBlob(documentId, pageNum, placeholder);
      thumbnailUrls.push(url);
      thumbnailsGenerated++;
    }
  }

  return { documentId, pageCount, thumbnailsGenerated, thumbnailUrls };
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
    const response = await fetch(existingUrl);
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
    const response = await fetch(existingUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { url: existingUrl, buffer };
  }

  return generateSingleThumbnail(documentId, storagePath, pageNumber);
}
