// src/app/api/tiles/[...path]/route.ts
import { NextRequest, NextResponse } from "next/server"
import { readFile } from "fs/promises"
import { join } from "path"

// Validate documentId is UUID format
function validateDocumentId(id: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(id)
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params

  // Path format: [documentId, pageNumber, z, x, y.png]
  if (path.length !== 5) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 })
  }

  const [documentId, pageNumber, z, x, yPng] = path

  // Security: validate documentId
  if (!validateDocumentId(documentId)) {
    return NextResponse.json({ error: "Invalid documentId" }, { status: 400 })
  }

  // Validate numeric parameters
  const pageNum = parseInt(pageNumber, 10)
  const zoomLevel = parseInt(z, 10)
  const xCoord = parseInt(x, 10)

  if (isNaN(pageNum) || isNaN(zoomLevel) || isNaN(xCoord)) {
    return NextResponse.json({ error: "Invalid parameters" }, { status: 400 })
  }

  const y = yPng.replace(".png", "")
  const yCoord = parseInt(y, 10)

  if (isNaN(yCoord)) {
    return NextResponse.json({ error: "Invalid y coordinate" }, { status: 400 })
  }

  const tilePath = join(process.cwd(), "tiles", documentId, pageNumber, z, x, `${y}.png`)

  try {
    const tileData = await readFile(tilePath)

    return new NextResponse(tileData, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    })
  } catch {
    // Return 404 for missing tiles
    return new NextResponse(null, { status: 404 })
  }
}
