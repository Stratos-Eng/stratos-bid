/**
 * Tile Generator for PDF Pages
 *
 * Generates map-style tiles for PDF pages at multiple zoom levels.
 * Tiles are stored in Vercel Blob and served via direct CDN URLs.
 *
 * Tile coordinate system:
 * - z=0: 1x1 grid (1 tile covers whole page)
 * - z=1: 2x2 grid (4 tiles)
 * - z=2: 4x4 grid (16 tiles)
 * - z=3: 8x8 grid (64 tiles)
 * - z=4: 16x16 grid (256 tiles)
 */

import { put, list, del } from '@vercel/blob';
import { downloadFile, isBlobUrl } from '@/lib/storage';
import { readFile } from 'fs/promises';
import { isAbsolute, join } from 'path';

// Tile settings
export const TILE_SIZE = 256;
export const MAX_ZOOM = 4;
export const UPLOAD_ZOOM_LEVELS = [0, 1]; // Generated on upload (5 tiles per page)

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface TileGenerationResult {
  sheetId: string;
  tilesGenerated: number;
  maxZoom: number;
  tileUrlTemplate: string;
}

/**
 * Validate sheetId is UUID format
 */
function validateSheetId(id: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(id);
}

/**
 * Get the Blob pathname for a tile
 */
export function getTileBlobPath(sheetId: string, z: number, x: number, y: number): string {
  return `tiles/${sheetId}/${z}/${x}/${y}.webp`;
}

/**
 * Build the tile URL template for OpenLayers
 * Returns a template with {z}, {x}, {y} placeholders
 */
export function buildTileUrlTemplate(baseUrl: string, sheetId: string): string {
  // baseUrl is like: https://xxx.blob.vercel-storage.com
  return `${baseUrl}/tiles/${sheetId}/{z}/{x}/{y}.webp`;
}

/**
 * Check if a tile exists in Blob storage
 */
export async function tileExistsInBlob(sheetId: string, z: number, x: number, y: number): Promise<string | null> {
  try {
    const pathname = getTileBlobPath(sheetId, z, x, y);
    const { blobs } = await list({ prefix: pathname, limit: 1 });
    const match = blobs.find(b => b.pathname === pathname);
    return match?.url || null;
  } catch {
    return null;
  }
}

/**
 * Get all tile URLs for a sheet at a specific zoom level
 */
export async function getTileUrlsForZoom(sheetId: string, z: number): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>();
  try {
    const prefix = `tiles/${sheetId}/${z}/`;
    const { blobs } = await list({ prefix, limit: 1000 });

    for (const blob of blobs) {
      // Extract x/y from pathname like "tiles/{sheetId}/{z}/{x}/{y}.webp"
      const match = blob.pathname.match(/\/(\d+)\/(\d+)\.webp$/);
      if (match) {
        const key = `${match[1]},${match[2]}`;
        urlMap.set(key, blob.url);
      }
    }
  } catch (error) {
    console.error(`Failed to list tiles for zoom ${z}:`, error);
  }
  return urlMap;
}

/**
 * Calculate the number of tiles at a given zoom level
 */
export function getTileCount(z: number): { cols: number; rows: number; total: number } {
  const scale = Math.pow(2, z);
  return { cols: scale, rows: scale, total: scale * scale };
}

/**
 * Get all tile coordinates for a zoom level
 */
export function getTileCoords(z: number): TileCoord[] {
  const { cols, rows } = getTileCount(z);
  const coords: TileCoord[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      coords.push({ z, x, y });
    }
  }
  return coords;
}

/**
 * Render a single tile via Python service
 */
async function renderTileViaPython(
  pdfBuffer: Buffer,
  pageNum: number,
  z: number,
  x: number,
  y: number
): Promise<Buffer | null> {
  const pythonApiUrl = process.env.PYTHON_VECTOR_API_URL || 'http://localhost:8001';
  const pdfBase64 = pdfBuffer.toString('base64');

  try {
    const response = await fetch(`${pythonApiUrl}/tile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdfData: pdfBase64,
        pageNum,
        z,
        x,
        y,
        tileSize: TILE_SIZE,
      }),
    });

    if (!response.ok) {
      console.warn(`Python tile service returned ${response.status}`);
      return null;
    }

    const result = await response.json();
    if (!result.success || !result.image) {
      console.warn('Python tile service returned unsuccessful result:', result.error);
      return null;
    }

    return Buffer.from(result.image, 'base64');
  } catch (error) {
    console.warn(`Python tile service failed for tile ${z}/${x}/${y}:`, error);
    return null;
  }
}

/**
 * Upload a tile to Blob storage
 */
async function uploadTileToBlob(
  sheetId: string,
  z: number,
  x: number,
  y: number,
  imageBuffer: Buffer
): Promise<string> {
  const pathname = getTileBlobPath(sheetId, z, x, y);
  const blob = await put(pathname, imageBuffer, {
    access: 'public',
    contentType: 'image/webp',
    addRandomSuffix: false,
  });
  return blob.url;
}

/**
 * Load PDF buffer from storage path
 */
async function loadPdfBuffer(storagePath: string): Promise<Buffer> {
  if (isBlobUrl(storagePath)) {
    return downloadFile(storagePath);
  }
  const fullPath = isAbsolute(storagePath) ? storagePath : join(process.cwd(), storagePath);
  return readFile(fullPath);
}

/**
 * Generate a single tile and upload to Blob
 * Returns the Blob URL or null on failure
 */
export async function generateSingleTile(
  sheetId: string,
  storagePath: string,
  pageNum: number,
  z: number,
  x: number,
  y: number
): Promise<string | null> {
  if (!validateSheetId(sheetId)) {
    throw new Error('Invalid sheetId format');
  }

  // Check if already exists
  const existingUrl = await tileExistsInBlob(sheetId, z, x, y);
  if (existingUrl) {
    return existingUrl;
  }

  // Download PDF
  const pdfBuffer = await loadPdfBuffer(storagePath);

  // Render tile
  const tileBuffer = await renderTileViaPython(pdfBuffer, pageNum, z, x, y);
  if (!tileBuffer) {
    return null;
  }

  // Upload to Blob
  const url = await uploadTileToBlob(sheetId, z, x, y, tileBuffer);
  return url;
}

/**
 * Generate tiles for specified zoom levels
 * Downloads PDF once and generates all tiles
 */
export async function generateTilesForZoomLevels(
  sheetId: string,
  storagePath: string,
  pageNum: number,
  zoomLevels: number[]
): Promise<{ generated: number; failed: number; urls: Map<string, string> }> {
  if (!validateSheetId(sheetId)) {
    throw new Error('Invalid sheetId format');
  }

  // Download PDF once
  const pdfBuffer = await loadPdfBuffer(storagePath);

  let generated = 0;
  let failed = 0;
  const urls = new Map<string, string>();

  for (const z of zoomLevels) {
    const coords = getTileCoords(z);

    for (const { x, y } of coords) {
      // Check if exists
      const existingUrl = await tileExistsInBlob(sheetId, z, x, y);
      if (existingUrl) {
        urls.set(`${z}/${x}/${y}`, existingUrl);
        generated++;
        continue;
      }

      // Render and upload
      try {
        const tileBuffer = await renderTileViaPython(pdfBuffer, pageNum, z, x, y);
        if (tileBuffer) {
          const url = await uploadTileToBlob(sheetId, z, x, y, tileBuffer);
          urls.set(`${z}/${x}/${y}`, url);
          generated++;
        } else {
          failed++;
        }
      } catch (error) {
        console.error(`Failed to generate tile ${z}/${x}/${y}:`, error);
        failed++;
      }
    }
  }

  return { generated, failed, urls };
}

/**
 * Generate initial tiles (zoom 0-1) for a sheet
 * Called on upload via Inngest - generates 5 tiles total
 */
export async function generateInitialTiles(
  sheetId: string,
  storagePath: string,
  pageNum: number
): Promise<TileGenerationResult> {
  const result = await generateTilesForZoomLevels(
    sheetId,
    storagePath,
    pageNum,
    UPLOAD_ZOOM_LEVELS
  );

  // Get the base URL from any generated tile to build template
  let tileUrlTemplate = '';
  const firstUrl = result.urls.values().next().value;

  if (firstUrl) {
    // Extract base URL and build template
    // From: https://xxx.blob.vercel-storage.com/tiles/sheetId/0/0/0.webp
    // To: https://xxx.blob.vercel-storage.com/tiles/sheetId/{z}/{x}/{y}.webp
    const baseMatch = firstUrl.match(/^(https:\/\/[^/]+)\/tiles\/([^/]+)\//);
    if (baseMatch) {
      tileUrlTemplate = `${baseMatch[1]}/tiles/${baseMatch[2]}/{z}/{x}/{y}.webp`;
    }
  }

  return {
    sheetId,
    tilesGenerated: result.generated,
    maxZoom: Math.max(...UPLOAD_ZOOM_LEVELS),
    tileUrlTemplate,
  };
}

/**
 * Delete all tiles for a sheet from Blob storage
 */
export async function deleteAllTiles(sheetId: string): Promise<number> {
  if (!validateSheetId(sheetId)) {
    throw new Error('Invalid sheetId format');
  }

  const prefix = `tiles/${sheetId}/`;
  const { blobs } = await list({ prefix, limit: 1000 });

  let deleted = 0;
  for (const blob of blobs) {
    try {
      await del(blob.url);
      deleted++;
    } catch (error) {
      console.error(`Failed to delete tile ${blob.pathname}:`, error);
    }
  }

  return deleted;
}

/**
 * Check if initial tiles are ready for a sheet
 */
export async function tilesReady(sheetId: string): Promise<boolean> {
  // Check if zoom level 0 tile exists (always just 1 tile at z=0)
  const z0Tile = await tileExistsInBlob(sheetId, 0, 0, 0);
  return z0Tile !== null;
}
