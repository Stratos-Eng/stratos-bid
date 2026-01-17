"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import Map from "ol/Map"
import View from "ol/View"
import ImageLayer from "ol/layer/Image"
import VectorLayer from "ol/layer/Vector"
import VectorSource from "ol/source/Vector"
import Static from "ol/source/ImageStatic"
import Projection from "ol/proj/Projection"
import { defaults as defaultControls } from "ol/control"
import { defaults as defaultInteractions } from "ol/interaction"
import Feature from "ol/Feature"
import { Point } from "ol/geom"
import { Style, Circle as CircleStyle, Fill, Stroke, Text } from "ol/style"
import "ol/ol.css"

import type { SignageItem } from "@/lib/stores/project-store"
import { cn } from "@/lib/utils"

interface QuickAddCoords {
  screenX: number // Screen position for form placement
  screenY: number
  pdfX: number // Normalized PDF coordinates (0-1)
  pdfY: number
}

interface ProjectViewerProps {
  documentId: string | null
  pageNumber: number
  totalPages?: number
  items: SignageItem[]
  selectedItemId: string | null
  onSelectItem: (id: string | null) => void
  quickAddMode: boolean
  onQuickAddClick: (coords: QuickAddCoords) => void
}

export function ProjectViewer({
  documentId,
  pageNumber,
  totalPages = 1,
  items,
  selectedItemId,
  onSelectItem,
  quickAddMode,
  onQuickAddClick,
}: ProjectViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const imageLayerRef = useRef<ImageLayer<Static> | null>(null)
  const vectorSourceRef = useRef<VectorSource | null>(null)
  const [zoom, setZoom] = useState(100)
  const [pageSize, setPageSize] = useState({ width: 612, height: 792 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Use refs to access current values in map event handlers
  const quickAddModeRef = useRef(quickAddMode)
  const onQuickAddClickRef = useRef(onQuickAddClick)
  const onSelectItemRef = useRef(onSelectItem)
  const selectedItemIdRef = useRef(selectedItemId)
  const pageSizeRef = useRef(pageSize)

  // Keep refs in sync with props
  useEffect(() => { quickAddModeRef.current = quickAddMode }, [quickAddMode])
  useEffect(() => { onQuickAddClickRef.current = onQuickAddClick }, [onQuickAddClick])
  useEffect(() => { onSelectItemRef.current = onSelectItem }, [onSelectItem])
  useEffect(() => { selectedItemIdRef.current = selectedItemId }, [selectedItemId])
  useEffect(() => { pageSizeRef.current = pageSize }, [pageSize])

  // Get page dimensions and render URL
  const pageUrl = documentId
    ? `/api/documents/${documentId}/page/${pageNumber}?dpi=150`
    : null

  // Fetch page info to get dimensions
  useEffect(() => {
    if (!documentId) return

    const fetchInfo = async () => {
      try {
        const res = await fetch(`/api/documents/${documentId}/info`)
        if (res.ok) {
          const data = await res.json()
          if (data.pages?.[pageNumber - 1]) {
            const pg = data.pages[pageNumber - 1]
            setPageSize({ width: pg.width || 612, height: pg.height || 792 })
          }
        }
      } catch (e) {
        // Use defaults
      }
    }
    fetchInfo()
  }, [documentId, pageNumber])

  // Preload adjacent pages for faster navigation
  useEffect(() => {
    if (!documentId || loading) return

    const preloadPage = (page: number) => {
      if (page < 1 || page > totalPages || page === pageNumber) return
      const img = new Image()
      img.src = `/api/documents/${documentId}/page/${page}?dpi=150`
    }

    // Preload next and previous pages after current page loads
    const timer = setTimeout(() => {
      preloadPage(pageNumber + 1)
      preloadPage(pageNumber - 1)
      // Also preload one more ahead for smooth scrolling
      preloadPage(pageNumber + 2)
    }, 100)

    return () => clearTimeout(timer)
  }, [documentId, pageNumber, totalPages, loading])

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const vectorSource = new VectorSource()
    vectorSourceRef.current = vectorSource

    const vectorLayer = new VectorLayer({
      source: vectorSource,
      style: (feature) => {
        const isSelected = feature.get("id") === selectedItemIdRef.current
        const status = feature.get("status")

        let color = "#3b82f6" // blue for pending
        if (status === "approved") color = "#22c55e" // green
        if (status === "skipped") color = "#94a3b8" // gray

        return new Style({
          image: new CircleStyle({
            radius: isSelected ? 14 : 10,
            fill: new Fill({ color: isSelected ? color : `${color}cc` }),
            stroke: new Stroke({
              color: "#ffffff",
              width: isSelected ? 3 : 2,
            }),
          }),
          text: new Text({
            text: feature.get("label") || "",
            font: "bold 11px sans-serif",
            fill: new Fill({ color: "#ffffff" }),
            offsetY: 1,
          }),
        })
      },
    })

    // Placeholder projection - will be updated when image loads
    const projection = new Projection({
      code: "PDF",
      units: "pixels",
      extent: [0, 0, pageSize.width * 2, pageSize.height * 2],
    })

    const map = new Map({
      target: containerRef.current,
      layers: [vectorLayer],
      view: new View({
        projection,
        center: [pageSize.width, pageSize.height],
        resolution: 1,
        minResolution: 0.1,
        maxResolution: 20,  // Allow zooming out far enough for large drawings
      }),
      controls: defaultControls({ zoom: false, rotate: false, attribution: false }),
      interactions: defaultInteractions({
        doubleClickZoom: true,
        mouseWheelZoom: true,
        pinchZoom: true,
        pinchRotate: false,
      }),
    })

    // Track zoom
    map.getView().on("change:resolution", () => {
      const res = map.getView().getResolution()
      if (res) {
        setZoom(Math.round((1 / res) * 100))
      }
    })

    // Click handler
    map.on("click", (e) => {
      const features = map.getFeaturesAtPixel(e.pixel)
      if (features && features.length > 0) {
        const id = features[0].get("id")
        if (id) {
          onSelectItemRef.current(id)
          return
        }
      }

      if (quickAddModeRef.current) {
        const coord = e.coordinate
        // Calculate extent for normalization
        const dpi = 150
        const scale = dpi / 72
        const currentPageSize = pageSizeRef.current
        const extentWidth = currentPageSize.width * scale
        const extentHeight = currentPageSize.height * scale

        // Normalize to 0-1 range
        const pdfX = Math.max(0, Math.min(1, coord[0] / extentWidth))
        const pdfY = Math.max(0, Math.min(1, 1 - (coord[1] / extentHeight))) // Flip Y

        onQuickAddClickRef.current({
          screenX: e.pixel[0] + (containerRef.current?.getBoundingClientRect().left || 0),
          screenY: e.pixel[1] + (containerRef.current?.getBoundingClientRect().top || 0),
          pdfX,
          pdfY,
        })
      } else {
        onSelectItemRef.current(null)
      }
    })

    // Cursor
    map.on("pointermove", (e) => {
      const hit = map.hasFeatureAtPixel(e.pixel)
      const target = map.getTargetElement()
      if (target) {
        if (quickAddModeRef.current) {
          target.style.cursor = "crosshair"
        } else {
          target.style.cursor = hit ? "pointer" : "grab"
        }
      }
    })

    mapRef.current = map

    // ResizeObserver to handle container size changes and initial layout
    let isFirstResize = true
    const resizeObserver = new ResizeObserver(() => {
      if (mapRef.current) {
        mapRef.current.updateSize()
        // On first resize (initial layout), fit the view to extent
        if (isFirstResize) {
          isFirstResize = false
          const view = mapRef.current.getView()
          const extent = view.getProjection().getExtent()
          if (extent && extent[2] > 0 && extent[3] > 0) {
            view.fit(extent, { padding: [20, 20, 20, 20], duration: 0 })
          }
        }
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      map.setTarget(undefined)
      mapRef.current = null
    }
  }, [])

  // Update image when document/page changes
  useEffect(() => {
    if (!mapRef.current || !pageUrl) return

    setLoading(true)
    setError(null)

    const map = mapRef.current
    const oldImageLayer = imageLayerRef.current

    // Calculate extent based on page size (at 150 DPI)
    const dpi = 150
    const scale = dpi / 72
    const extent: [number, number, number, number] = [0, 0, pageSize.width * scale, pageSize.height * scale]

    const projection = new Projection({
      code: "PDF",
      units: "pixels",
      extent,
    })

    const imageSource = new Static({
      url: pageUrl,
      projection,
      imageExtent: extent,
    })

    // Create new view with correct projection for this image
    const newView = new View({
      projection,
      center: [extent[2] / 2, extent[3] / 2],
      resolution: 1,
      minResolution: 0.1,
      maxResolution: 20,  // Allow zooming out far enough for large drawings
    })

    // Track zoom on new view
    newView.on("change:resolution", () => {
      const res = newView.getResolution()
      if (res) {
        setZoom(Math.round((1 / res) * 100))
      }
    })

    map.setView(newView)

    const imageLayer = new ImageLayer({ source: imageSource })

    imageSource.on("imageloadend", () => {
      setLoading(false)
      // Remove old layer AFTER new one is ready (prevents flash)
      if (oldImageLayer) {
        map.removeLayer(oldImageLayer)
      }
      // Fit view after image loads - use multiple attempts to ensure DOM is ready
      const fitToView = () => {
        if (mapRef.current) {
          mapRef.current.updateSize()
          mapRef.current.getView().fit(extent, {
            padding: [20, 20, 20, 20],
            duration: 0
          })
        }
      }
      // Try immediately, then again after layout settles
      fitToView()
      setTimeout(fitToView, 100)
    })

    imageSource.on("imageloaderror", () => {
      setLoading(false)
      setError("Failed to load page")
      // Remove old layer on error too
      if (oldImageLayer) {
        map.removeLayer(oldImageLayer)
      }
    })

    // Add new layer on top, will remove old one when loaded
    imageLayerRef.current = imageLayer
    map.getLayers().insertAt(0, imageLayer)

    // Initial fit attempt - will be refined by imageloadend and ResizeObserver
    map.updateSize()
    newView.fit(extent, { padding: [20, 20, 20, 20] })
  }, [pageUrl, pageSize])

  // Update markers when items change
  useEffect(() => {
    if (!vectorSourceRef.current) return

    vectorSourceRef.current.clear()

    // Calculate extent for coordinate conversion
    const dpi = 150
    const scale = dpi / 72
    const extentWidth = pageSize.width * scale
    const extentHeight = pageSize.height * scale

    // Track items without coordinates for fallback grid layout
    let gridIndex = 0

    items.forEach((item) => {
      let x: number
      let y: number

      if (item.pageX !== null && item.pageY !== null) {
        // Use real coordinates (normalized 0-1, convert to pixel coordinates)
        x = item.pageX * extentWidth
        y = (1 - item.pageY) * extentHeight // Flip Y axis (PDF Y is top-down)
      } else {
        // Fallback: distribute markers in grid pattern
        x = 100 + (gridIndex % 4) * 150
        y = 100 + Math.floor(gridIndex / 4) * 150
        gridIndex++
      }

      const feature = new Feature({
        geometry: new Point([x, y]),
        id: item.id,
        status: item.status,
        label: item.symbolCode || String(gridIndex || items.indexOf(item) + 1),
      })

      vectorSourceRef.current?.addFeature(feature)
    })
  }, [items, pageSize])

  // Update styles when selection changes
  useEffect(() => {
    vectorSourceRef.current?.changed()
  }, [selectedItemId])

  // Zoom controls
  const handleZoomIn = () => {
    if (!mapRef.current) return
    const view = mapRef.current.getView()
    const res = view.getResolution()
    if (res) view.animate({ resolution: res / 1.5, duration: 200 })
  }

  const handleZoomOut = () => {
    if (!mapRef.current) return
    const view = mapRef.current.getView()
    const res = view.getResolution()
    if (res) view.animate({ resolution: res * 1.5, duration: 200 })
  }

  const handleFit = () => {
    if (!mapRef.current) return
    const view = mapRef.current.getView()
    const extent = view.getProjection().getExtent()
    if (extent) view.fit(extent, { padding: [20, 20, 20, 20], duration: 200 })
  }

  return (
    <div className="relative h-full w-full">
      {/* Map container */}
      <div
        ref={containerRef}
        className={cn(
          "h-full w-full bg-muted",
          quickAddMode && "cursor-crosshair"
        )}
      />

      {/* Loading indicator - subtle spinner in corner, not a full overlay */}
      {loading && (
        <div className="absolute top-4 left-4 flex items-center gap-2 bg-background/80 backdrop-blur-sm rounded px-3 py-1.5 shadow-sm">
          <div className="h-3 w-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-muted-foreground">Loading...</span>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50">
          <div className="text-sm text-destructive">{error}</div>
        </div>
      )}

      {/* Quick add mode indicator */}
      {quickAddMode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground px-3 py-1 rounded text-sm">
          Click on the page to add an item
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 bg-background/90 backdrop-blur rounded-lg shadow-lg border px-2 py-1">
        <button
          onClick={handleZoomIn}
          className="px-3 py-1 hover:bg-secondary rounded text-sm font-medium"
        >
          +
        </button>
        <span className="text-xs text-muted-foreground min-w-[3rem] text-center">
          {zoom}%
        </span>
        <button
          onClick={handleZoomOut}
          className="px-3 py-1 hover:bg-secondary rounded text-sm font-medium"
        >
          −
        </button>
        <div className="w-px h-4 bg-border mx-1" />
        <button
          onClick={handleFit}
          className="px-2 py-1 hover:bg-secondary rounded text-xs"
        >
          Fit
        </button>
      </div>
    </div>
  )
}
