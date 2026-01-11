"use client"

import { useEffect, useRef, useState, useCallback } from "react"

interface TileViewerProps {
  documentId: string
  pageNumber: number
  pageWidth: number
  pageHeight: number
  maxZoom: number
  tileUrlPattern: string
}

const TILE_SIZE = 256

export function TileViewer({
  documentId,
  pageNumber,
  pageWidth,
  pageHeight,
  maxZoom,
  tileUrlPattern
}: TileViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })

  // Calculate visible tiles based on viewport and zoom
  const getVisibleTiles = useCallback(() => {
    if (!containerRef.current) return []

    const container = containerRef.current
    const containerWidth = container.clientWidth
    const containerHeight = container.clientHeight

    const scale = Math.pow(2, zoom - maxZoom)
    const scaledWidth = Math.round(pageWidth * 2 * scale)
    const scaledHeight = Math.round(pageHeight * 2 * scale)

    const tilesX = Math.ceil(scaledWidth / TILE_SIZE)
    const tilesY = Math.ceil(scaledHeight / TILE_SIZE)

    // Visible tile range based on offset
    const startX = Math.max(0, Math.floor(-offset.x / TILE_SIZE))
    const endX = Math.min(tilesX, Math.ceil((containerWidth - offset.x) / TILE_SIZE))
    const startY = Math.max(0, Math.floor(-offset.y / TILE_SIZE))
    const endY = Math.min(tilesY, Math.ceil((containerHeight - offset.y) / TILE_SIZE))

    const tiles = []
    for (let x = startX; x < endX; x++) {
      for (let y = startY; y < endY; y++) {
        tiles.push({ x, y, z: zoom })
      }
    }
    return tiles
  }, [zoom, offset, pageWidth, pageHeight, maxZoom])

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -1 : 1
    setZoom(z => Math.max(0, Math.min(maxZoom, z + delta)))
  }, [maxZoom])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDragging(true)
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y })
  }, [offset])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    setOffset({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y
    })
  }, [isDragging, dragStart])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.addEventListener("wheel", handleWheel, { passive: false })
    return () => container.removeEventListener("wheel", handleWheel)
  }, [handleWheel])

  const visibleTiles = getVisibleTiles()
  const tileUrl = (z: number, x: number, y: number) =>
    `/api/tiles/${documentId}/${pageNumber}/${z}/${x}/${y}.png`

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-muted cursor-grab"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: isDragging ? "grabbing" : "grab" }}
    >
      <div
        className="absolute"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px)`
        }}
      >
        {visibleTiles.map(({ x, y, z }) => (
          <img
            key={`${z}-${x}-${y}-${pageNumber}`}
            src={tileUrl(z, x, y)}
            alt=""
            className="absolute"
            style={{
              left: x * TILE_SIZE,
              top: y * TILE_SIZE,
              width: TILE_SIZE,
              height: TILE_SIZE
            }}
            loading="lazy"
          />
        ))}
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 flex gap-2">
        <button
          onClick={() => setZoom(z => Math.min(maxZoom, z + 1))}
          className="rounded bg-background px-3 py-1 shadow border text-sm"
        >
          +
        </button>
        <span className="rounded bg-background px-3 py-1 shadow border text-sm">
          {Math.round(Math.pow(2, zoom) * 100)}%
        </span>
        <button
          onClick={() => setZoom(z => Math.max(0, z - 1))}
          className="rounded bg-background px-3 py-1 shadow border text-sm"
        >
          &minus;
        </button>
      </div>
    </div>
  )
}
