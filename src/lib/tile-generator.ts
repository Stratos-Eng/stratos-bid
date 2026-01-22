/**
 * Tile Generator for PDF Pages
 *
 * Generates map-style tiles for PDF pages at multiple zoom levels.
 * Tiles are stored in Vercel Blob and served via direct CDN URLs.
 * PDFs must be stored in Vercel Blob - passes URLs to Python for rendering.
 *
 * Tile coordinate system:
 * - z=0: 1x1 grid (1 tile covers whole page)
 * - z=1: 2x2 grid (4 tiles)
 * - z=2: 4x4 grid (16 tiles)
 * - z=3: 8x8 grid (64 tiles)
 * - z=4: 16x16 grid (256 tiles)
 */

import { put, list, del } from '@vercel/blob';

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
 * Get tile count at a zoom level
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
 * Render a tile via Python service (passes URL, Python fetches)
 */
async function renderTileViaPython(
  pdfUrl: string,
  pageNum: number,
  z: number,
  x: number,
  y: number
): Promise<Buffer | null> {
  const pythonApiUrl = process.env.PYTHON_VECTOR_API_URL || 'http://localhost:8001';

  try {
    const response = await fetch(`${pythonApiUrl}/tile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdfUrl,
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
      console.warn('Python tile service failed:', result.error);
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
 * Generate a single tile and upload to Blob
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

  if (!storagePath.startsWith('https://')) {
    throw new Error('storagePath must be a Blob URL');
  }

  // Check if already exists
  const existingUrl = await tileExistsInBlob(sheetId, z, x, y);
  if (existingUrl) {
    return existingUrl;
  }

  // Render tile (Python fetches PDF from URL)
  const tileBuffer = await renderTileViaPython(storagePath, pageNum, z, x, y);
  if (!tileBuffer) {
    return null;
  }

  // Upload to Blob
  return uploadTileToBlob(sheetId, z, x, y, tileBuffer);
}

/**
 * Generate tiles for specified zoom levels
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

  if (!storagePath.startsWith('https://')) {
    throw new Error('storagePath must be a Blob URL');
  }

  let generated = 0;
  let failed = 0;
  const urls = new Map<string, string>();

  for (const z of zoomLevels) {
    const coords = getTileCoords(z);

    for (const { x, y } of coords) {
      const existingUrl = await tileExistsInBlob(sheetId, z, x, y);
      if (existingUrl) {
        urls.set(`${z}/${x}/${y}`, existingUrl);
        generated++;
        continue;
      }

      try {
        const tileBuffer = await renderTileViaPython(storagePath, pageNum, z, x, y);
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

  // Build tile URL template from first generated tile
  let tileUrlTemplate = '';
  const firstUrl = result.urls.values().next().value;

  if (firstUrl) {
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
 * Delete all tiles for a sheet
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
 * Check if initial tiles are ready
 */
export async function tilesReady(sheetId: string): Promise<boolean> {
  const z0Tile = await tileExistsInBlob(sheetId, 0, 0, 0);
  return z0Tile !== null;
}
