"use client"

import { useEffect, useRef, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from "react"
import Map from "ol/Map"
import View from "ol/View"
import TileLayer from "ol/layer/Tile"
import VectorLayer from "ol/layer/Vector"
import VectorSource from "ol/source/Vector"
import XYZ from "ol/source/XYZ"
import { defaults as defaultControls } from "ol/control"
import { defaults as defaultInteractions } from "ol/interaction"
import Feature from "ol/Feature"
import { Polygon, Point } from "ol/geom"
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style"
import "ol/ol.css"

interface Annotation {
  id: string
  type: "highlight" | "measurement" | "note"
  coordinates: number[][] // [[x1, y1], [x2, y2], ...]
  label?: string
  color?: string
}

interface OpenLayersTileViewerProps {
  documentId: string
  pageNumber: number
  pageWidth: number
  pageHeight: number
  maxZoom: number
  annotations?: Annotation[]
  onAnnotationClick?: (annotation: Annotation) => void
  highlightedItemId?: string | null
}

const TILE_SIZE = 256

export interface OpenLayersTileViewerRef {
  navigateTo: (x: number, y: number, zoom?: number) => void
  fitToPage: () => void
}

export const OpenLayersTileViewer = forwardRef<OpenLayersTileViewerRef, OpenLayersTileViewerProps>(function OpenLayersTileViewer({
  documentId,
  pageNumber,
  pageWidth,
  pageHeight,
  maxZoom,
  annotations = [],
  onAnnotationClick,
  highlightedItemId
}, ref) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const vectorSourceRef = useRef<VectorSource | null>(null)
  const [currentZoom, setCurrentZoom] = useState(0)

  // Calculate the extent (bounds) of the document in pixel coordinates
  // OpenLayers uses bottom-left origin, we'll map to top-left for PDF coordinates
  const extent = useMemo<[number, number, number, number]>(
    () => [0, -pageHeight * 2, pageWidth * 2, 0],
    [pageWidth, pageHeight]
  )

  // Create the map on mount
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return

    // Tile source for PDF tiles
    const tileSource = new XYZ({
      url: `/api/tiles/${documentId}/${pageNumber}/{z}/{x}/{y}.png`,
      tileSize: TILE_SIZE,
      maxZoom: maxZoom,
      minZoom: 0,
      // Proper tile loading strategy
      tileLoadFunction: (tile, src) => {
        const imgTile = tile as unknown as { getImage: () => HTMLImageElement }
        const img = imgTile.getImage()
        if (img instanceof HTMLImageElement) {
          img.src = src
        }
      }
    })

    // Tile layer
    const tileLayer = new TileLayer({
      source: tileSource,
      preload: 2 // Preload adjacent tiles for smoother panning
    })

    // Vector source for annotations
    const vectorSource = new VectorSource()
    vectorSourceRef.current = vectorSource

    // Vector layer for annotations with styling
    const vectorLayer = new VectorLayer({
      source: vectorSource,
      style: (feature) => {
        const props = feature.getProperties()
        const isHighlighted = props.id === highlightedItemId
        const annotationType = props.type as string
        const color = props.color || "#3b82f6"

        switch (annotationType) {
          case "highlight":
            return new Style({
              fill: new Fill({
                color: isHighlighted ? "rgba(59, 130, 246, 0.4)" : "rgba(59, 130, 246, 0.2)"
              }),
              stroke: new Stroke({
                color: isHighlighted ? "#1d4ed8" : color,
                width: isHighlighted ? 3 : 2
              })
            })

          case "measurement":
            return [
              new Style({
                stroke: new Stroke({
                  color: isHighlighted ? "#dc2626" : "#ef4444",
                  width: isHighlighted ? 3 : 2,
                  lineDash: [8, 4]
                })
              }),
              // Label for measurements
              props.label ? new Style({
                text: new Text({
                  text: props.label,
                  font: "12px sans-serif",
                  fill: new Fill({ color: "#1f2937" }),
                  stroke: new Stroke({ color: "#ffffff", width: 3 }),
                  offsetY: -10
                })
              }) : new Style({})
            ]

          case "note":
            return new Style({
              image: new CircleStyle({
                radius: isHighlighted ? 10 : 8,
                fill: new Fill({ color: isHighlighted ? "#f59e0b" : "#fbbf24" }),
                stroke: new Stroke({ color: "#92400e", width: 2 })
              }),
              text: props.label ? new Text({
                text: props.label,
                font: "11px sans-serif",
                fill: new Fill({ color: "#1f2937" }),
                stroke: new Stroke({ color: "#ffffff", width: 2 }),
                offsetY: 20
              }) : undefined
            })

          default:
            return new Style({
              stroke: new Stroke({ color, width: 2 }),
              fill: new Fill({ color: `${color}33` })
            })
        }
      }
    })

    // Calculate initial resolution to fit the document
    const containerWidth = mapContainerRef.current.clientWidth
    const containerHeight = mapContainerRef.current.clientHeight
    const initialResolution = Math.max(
      (pageWidth * 2) / containerWidth,
      (pageHeight * 2) / containerHeight
    ) * 1.1 // Slight padding

    // Create the map
    const map = new Map({
      target: mapContainerRef.current,
      layers: [tileLayer, vectorLayer],
      view: new View({
        projection: undefined, // Use pixel projection
        extent: extent,
        center: [pageWidth, -pageHeight], // Center of document
        resolution: initialResolution,
        minResolution: 0.25, // Allow 4x zoom
        maxResolution: initialResolution * 2,
        constrainOnlyCenter: false,
        smoothExtentConstraint: true,
        smoothResolutionConstraint: true
      }),
      controls: defaultControls({
        zoom: false,
        rotate: false,
        attribution: false
      }),
      interactions: defaultInteractions({
        doubleClickZoom: true,
        mouseWheelZoom: true,
        pinchZoom: true,
        pinchRotate: false,
        shiftDragZoom: true
      })
    })

    // Track zoom changes
    map.getView().on("change:resolution", () => {
      const resolution = map.getView().getResolution()
      if (resolution) {
        // Convert resolution to zoom percentage
        const zoom = Math.round((initialResolution / resolution) * 100)
        setCurrentZoom(zoom)
      }
    })

    // Handle annotation clicks
    map.on("click", (e) => {
      const features = map.getFeaturesAtPixel(e.pixel)
      if (features && features.length > 0 && onAnnotationClick) {
        const feature = features[0]
        const props = feature.getProperties()
        onAnnotationClick({
          id: props.id,
          type: props.type,
          coordinates: props.coordinates,
          label: props.label,
          color: props.color
        })
      }
    })

    // Pointer cursor on annotations
    map.on("pointermove", (e) => {
      const hit = map.hasFeatureAtPixel(e.pixel)
      map.getTargetElement().style.cursor = hit ? "pointer" : "grab"
    })

    mapRef.current = map
    setCurrentZoom(100)

    return () => {
      map.setTarget(undefined)
      mapRef.current = null
    }
  }, [documentId, pageNumber, pageWidth, pageHeight, maxZoom, extent, onAnnotationClick])

  // Update annotations when they change
  useEffect(() => {
    if (!vectorSourceRef.current) return

    vectorSourceRef.current.clear()

    annotations.forEach((annotation) => {
      let geometry

      if (annotation.type === "note" && annotation.coordinates.length === 1) {
        // Single point for notes
        geometry = new Point(annotation.coordinates[0])
      } else if (annotation.coordinates.length >= 3) {
        // Polygon for highlights and closed measurements
        geometry = new Polygon([annotation.coordinates])
      } else if (annotation.coordinates.length === 2) {
        // Line for measurements (create thin polygon)
        const [start, end] = annotation.coordinates
        geometry = new Polygon([[start, end, end, start]])
      } else {
        return // Skip invalid annotations
      }

      const feature = new Feature({
        geometry,
        id: annotation.id,
        type: annotation.type,
        coordinates: annotation.coordinates,
        label: annotation.label,
        color: annotation.color
      })

      vectorSourceRef.current?.addFeature(feature)
    })
  }, [annotations])

  // Update highlight styling when highlightedItemId changes
  useEffect(() => {
    if (!vectorSourceRef.current) return
    // Trigger re-render of features by changing the source
    vectorSourceRef.current.changed()
  }, [highlightedItemId])

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    if (!mapRef.current) return
    const view = mapRef.current.getView()
    const currentResolution = view.getResolution()
    if (currentResolution) {
      view.animate({
        resolution: currentResolution / 1.5,
        duration: 200
      })
    }
  }, [])

  const handleZoomOut = useCallback(() => {
    if (!mapRef.current) return
    const view = mapRef.current.getView()
    const currentResolution = view.getResolution()
    if (currentResolution) {
      view.animate({
        resolution: currentResolution * 1.5,
        duration: 200
      })
    }
  }, [])

  const handleFitToPage = useCallback(() => {
    if (!mapRef.current || !mapContainerRef.current) return
    const view = mapRef.current.getView()
    view.fit(extent, {
      padding: [20, 20, 20, 20],
      duration: 300
    })
  }, [extent])

  // Navigate to specific coordinates (for jumping to line items)
  const navigateTo = useCallback((x: number, y: number, zoom?: number) => {
    if (!mapRef.current) return
    const view = mapRef.current.getView()

    const animationOptions: { center: [number, number]; duration: number; resolution?: number } = {
      center: [x, -y], // Convert from PDF coords (top-left origin) to OL coords
      duration: 300
    }

    if (zoom) {
      const containerWidth = mapContainerRef.current?.clientWidth || 800
      animationOptions.resolution = (pageWidth * 2) / containerWidth / (zoom / 100)
    }

    view.animate(animationOptions)
  }, [pageWidth])

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    navigateTo,
    fitToPage: handleFitToPage
  }), [navigateTo, handleFitToPage])

  return (
    <div className="relative h-full w-full">
      {/* Map container */}
      <div
        ref={mapContainerRef}
        className="h-full w-full bg-muted"
        style={{ cursor: "grab" }}
      />

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 flex items-center gap-2 bg-background/90 backdrop-blur rounded-lg shadow-lg border px-2 py-1">
        <button
          onClick={handleZoomIn}
          className="px-3 py-1 hover:bg-secondary rounded text-sm font-medium"
          title="Zoom in"
        >
          +
        </button>
        <span className="text-xs text-muted-foreground min-w-[3rem] text-center">
          {currentZoom}%
        </span>
        <button
          onClick={handleZoomOut}
          className="px-3 py-1 hover:bg-secondary rounded text-sm font-medium"
          title="Zoom out"
        >
          −
        </button>
        <div className="w-px h-4 bg-border mx-1" />
        <button
          onClick={handleFitToPage}
          className="px-2 py-1 hover:bg-secondary rounded text-xs"
          title="Fit to page"
        >
          Fit
        </button>
      </div>

      {/* Page indicator */}
      <div className="absolute top-4 left-4 bg-background/90 backdrop-blur rounded px-2 py-1 text-xs text-muted-foreground shadow border">
        Page {pageNumber}
      </div>
    </div>
  )
})
