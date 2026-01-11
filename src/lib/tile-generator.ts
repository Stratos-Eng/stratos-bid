// src/lib/tile-generator.ts
import { PDFDocument } from "pdf-lib"
import sharp from "sharp"
import { readFile, mkdir, writeFile } from "fs/promises"
import { join, dirname } from "path"
import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

// Validate documentId is UUID format
function validateDocumentId(id: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(id)
}

const TILE_SIZE = 256
const MAX_ZOOM = 5
const BASE_DPI = 150

export interface TileConfig {
  documentId: string
  pageNumber: number
  storagePath: string
  outputDir: string
}

export interface TileResult {
  zoomLevels: number
  totalTiles: number
  tileUrlPattern: string
  pageWidth: number
  pageHeight: number
}

/**
 * Generate tiles for a PDF page using pdftoppm or fallback to placeholder.
 * Tiles follow XYZ pattern: /{z}/{x}/{y}.png
 */
export async function generateTilesForPage(config: TileConfig): Promise<TileResult> {
  const { documentId, pageNumber, storagePath, outputDir } = config

  if (!validateDocumentId(documentId)) {
    throw new Error("Invalid documentId format")
  }
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error("Invalid pageNumber")
  }

  const fullPath = join(process.cwd(), storagePath)

  // Get page dimensions
  const pdfBytes = await readFile(fullPath)
  const pdfDoc = await PDFDocument.load(pdfBytes)
  const page = pdfDoc.getPage(pageNumber - 1)
  const { width: pdfWidth, height: pdfHeight } = page.getSize()

  // Calculate max zoom based on page size
  const maxDimension = Math.max(pdfWidth, pdfHeight)
  const naturalZoom = Math.ceil(Math.log2(maxDimension * (BASE_DPI / 72) / TILE_SIZE))
  const zoomLevels = Math.min(naturalZoom, MAX_ZOOM)

  // Output directory for this page's tiles
  const pageOutputDir = join(outputDir, documentId, String(pageNumber))

  // Generate full-resolution image first
  const fullResImage = await renderPageToBuffer(fullPath, pageNumber, BASE_DPI * Math.pow(2, zoomLevels - 2))

  if (!fullResImage) {
    // Fallback: generate placeholder tiles
    return generatePlaceholderTiles(pageOutputDir, pdfWidth, pdfHeight, zoomLevels, documentId, pageNumber)
  }

  // Generate tiles for each zoom level
  let totalTiles = 0
  for (let z = 0; z <= zoomLevels; z++) {
    const scale = Math.pow(2, z - zoomLevels)
    const scaledWidth = Math.round(pdfWidth * (BASE_DPI / 72) * Math.pow(2, zoomLevels - 2) * scale)
    const scaledHeight = Math.round(pdfHeight * (BASE_DPI / 72) * Math.pow(2, zoomLevels - 2) * scale)

    // Resize image for this zoom level
    const resized = await sharp(fullResImage)
      .resize(scaledWidth, scaledHeight, { fit: "fill" })
      .toBuffer()

    // Calculate tile grid
    const tilesX = Math.ceil(scaledWidth / TILE_SIZE)
    const tilesY = Math.ceil(scaledHeight / TILE_SIZE)

    for (let x = 0; x < tilesX; x++) {
      for (let y = 0; y < tilesY; y++) {
        const left = x * TILE_SIZE
        const top = y * TILE_SIZE
        const tileWidth = Math.min(TILE_SIZE, scaledWidth - left)
        const tileHeight = Math.min(TILE_SIZE, scaledHeight - top)

        // Extract tile
        let tile = await sharp(resized)
          .extract({ left, top, width: tileWidth, height: tileHeight })
          .toBuffer()

        // Pad if needed
        if (tileWidth < TILE_SIZE || tileHeight < TILE_SIZE) {
          tile = await sharp(tile)
            .extend({
              right: TILE_SIZE - tileWidth,
              bottom: TILE_SIZE - tileHeight,
              background: { r: 255, g: 255, b: 255, alpha: 1 }
            })
            .toBuffer()
        }

        // Save tile
        const tilePath = join(pageOutputDir, String(z), String(x), `${y}.png`)
        await mkdir(dirname(tilePath), { recursive: true })
        await writeFile(tilePath, await sharp(tile).png({ quality: 80 }).toBuffer())
        totalTiles++
      }
    }
  }

  return {
    zoomLevels,
    totalTiles,
    tileUrlPattern: `/api/tiles/${documentId}/${pageNumber}/{z}/{x}/{y}.png`,
    pageWidth: pdfWidth,
    pageHeight: pdfHeight
  }
}

async function renderPageToBuffer(pdfPath: string, pageNumber: number, dpi: number): Promise<Buffer | null> {
  // Cap DPI to prevent memory exhaustion
  const safeDpi = Math.min(Math.round(dpi), 600)

  try {
    const { stdout } = await execFileAsync('pdftoppm', [
      '-f', String(pageNumber),
      '-l', String(pageNumber),
      '-png',
      '-r', String(safeDpi),
      '-singlefile',
      pdfPath,
      '-'
    ], { maxBuffer: 100 * 1024 * 1024, encoding: 'buffer' })
    return stdout
  } catch {
    console.warn("pdftoppm not available, using placeholder tiles")
    return null
  }
}

async function generatePlaceholderTiles(
  outputDir: string,
  pdfWidth: number,
  pdfHeight: number,
  zoomLevels: number,
  documentId: string,
  pageNumber: number
): Promise<TileResult> {
  // Generate simple gray placeholder tiles
  let totalTiles = 0

  // Create placeholder tile once
  const placeholderTile = await sharp({
    create: {
      width: TILE_SIZE,
      height: TILE_SIZE,
      channels: 4,
      background: { r: 245, g: 245, b: 243, alpha: 1 }
    }
  }).png().toBuffer()

  for (let z = 0; z <= zoomLevels; z++) {
    const scale = Math.pow(2, z - zoomLevels)
    const scaledWidth = Math.round(pdfWidth * (BASE_DPI / 72) * scale)
    const scaledHeight = Math.round(pdfHeight * (BASE_DPI / 72) * scale)

    const tilesX = Math.ceil(scaledWidth / TILE_SIZE)
    const tilesY = Math.ceil(scaledHeight / TILE_SIZE)

    for (let x = 0; x < tilesX; x++) {
      for (let y = 0; y < tilesY; y++) {
        const tilePath = join(outputDir, String(z), String(x), `${y}.png`)
        await mkdir(dirname(tilePath), { recursive: true })
        await writeFile(tilePath, placeholderTile)
        totalTiles++
      }
    }
  }

  return {
    zoomLevels,
    totalTiles,
    tileUrlPattern: `/api/tiles/${documentId}/${pageNumber}/{z}/{x}/{y}.png`,
    pageWidth: pdfWidth,
    pageHeight: pdfHeight
  }
}

/**
 * Check if tiles exist for a page
 */
export async function tilesExist(documentId: string, pageNumber: number): Promise<boolean> {
  if (!validateDocumentId(documentId)) {
    return false
  }

  const tilePath = join(process.cwd(), "tiles", documentId, String(pageNumber), "0", "0", "0.png")
  try {
    await readFile(tilePath)
    return true
  } catch {
    return false
  }
}
