"use client"

import { useEffect, useRef, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from "react"
import Map from "ol/Map"
import View from "ol/View"
import TileLayer from "ol/layer/Tile"
import VectorLayer from "ol/layer/Vector"
import VectorSource from "ol/source/Vector"
import XYZ from "ol/source/XYZ"
import Projection from "ol/proj/Projection"
import { defaults as defaultControls } from "ol/control"
import { defaults as defaultInteractions } from "ol/interaction"
import Feature from "ol/Feature"
import { Polygon, Point, LineString } from "ol/geom"
import { Style, Fill, Stroke, Circle as CircleStyle, Text } from "ol/style"
import type { FeatureLike } from "ol/Feature"
import "ol/ol.css"

// Annotation interface for simple usage
export interface Annotation {
  id: string
  type: "highlight" | "measurement" | "note"
  coordinates: number[][] // [[x1, y1], [x2, y2], ...]
  label?: string
  color?: string
}

// GeoJSON types for ibeam-style integration
// Reference: ibeam uses standard GeoJSON with custom properties
export interface GeoJSONFeature {
  id: string
  type: "Feature"
  geometry: {
    type: "Point" | "LineString" | "Polygon"
    coordinates: number[] | number[][] | number[][][]
  }
  properties: {
    vector_layer_id?: string
    count?: number
    measurement?: number
    unit?: string
    color?: string
    label?: string
    tags_info?: Record<string, unknown>
    zone_id?: string[]
  }
}

export interface GeoJSONFeatureCollection {
  type: "FeatureCollection"
  features: GeoJSONFeature[]
  properties?: {
    count?: number
    edit_count?: number
    total_measurement?: number
  }
}

interface OpenLayersTileViewerProps {
  documentId: string
  pageNumber: number
  pageWidth: number
  pageHeight: number
  maxZoom: number
  annotations?: Annotation[]
  geoJsonFeatures?: GeoJSONFeatureCollection
  onAnnotationClick?: (annotation: Annotation) => void
  onFeatureClick?: (feature: GeoJSONFeature) => void
  highlightedItemId?: string | null
}

const TILE_SIZE = 256

// Style cache for performance (keyed by featureId-highlighted-resolution)
// Using Object instead of Map to avoid collision with OpenLayers Map import
const styleCacheStore: Record<string, Style | Style[]> = {}
const styleCache = {
  get: (key: string) => styleCacheStore[key],
  set: (key: string, value: Style | Style[]) => { styleCacheStore[key] = value },
  clear: () => { Object.keys(styleCacheStore).forEach(key => delete styleCacheStore[key]) }
}

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
  geoJsonFeatures,
  onAnnotationClick,
  onFeatureClick,
  highlightedItemId
}, ref) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const tileLayerRef = useRef<TileLayer<XYZ> | null>(null)
  const vectorSourceRef = useRef<VectorSource | null>(null)
  const [currentZoom, setCurrentZoom] = useState(100)
  const initialResolutionRef = useRef<number>(1)

  // Store highlightedItemId in ref to avoid stale closure in style function
  const highlightedItemIdRef = useRef<string | null>(null)
  highlightedItemIdRef.current = highlightedItemId ?? null

  // Store current resolution in ref for style cache key
  const currentResolutionRef = useRef<number>(1)

  // Custom PDF projection - extent is [minX, minY, maxX, maxY]
  // PDF coordinates: origin at top-left, Y grows downward (so we use negative Y)
  // Following ibeam reference: extent = [0, -pdfHeight, pdfWidth, 0]
  const pdfProjection = useMemo(() => {
    return new Projection({
      code: "PDF",
      units: "pixels",
      extent: [0, -pageHeight, pageWidth, 0]
    })
  }, [pageWidth, pageHeight])

  // Calculate the extent for view constraints
  const extent = useMemo<[number, number, number, number]>(
    () => [0, -pageHeight, pageWidth, 0],
    [pageWidth, pageHeight]
  )

  // Style function with caching for performance
  // Reference: ibeam uses style caching keyed by featureId + state + resolution
  const createStyleFunction = useCallback(() => {
    return (feature: FeatureLike) => {
      const props = feature.getProperties()
      const featureId = props.id || feature.getId() || ""
      const isHighlighted = featureId === highlightedItemIdRef.current
      const annotationType = props.type as string
      const color = props.color || "#3b82f6"
      const geometry = feature.getGeometry()

      // Cache key includes feature id, highlight state, and resolution bucket
      const resBucket = Math.floor(Math.log2(currentResolutionRef.current + 1))
      const cacheKey = `${featureId}-${annotationType}-${isHighlighted}-${resBucket}`

      // Check cache first
      const cached = styleCache.get(cacheKey)
      if (cached) return cached

      let styles: Style | Style[]

      switch (annotationType) {
        case "highlight":
        case "polygon":
          styles = new Style({
            fill: new Fill({
              color: isHighlighted ? "rgba(59, 130, 246, 0.4)" : "rgba(59, 130, 246, 0.2)"
            }),
            stroke: new Stroke({
              color: isHighlighted ? "#1d4ed8" : color,
              width: isHighlighted ? 3 : 2
            })
          })
          break

        case "measurement":
        case "linestring": {
          // Build styles array with line + endpoint markers (per reference architecture)
          const lineStyles: Style[] = [
            new Style({
              stroke: new Stroke({
                color: isHighlighted ? "#dc2626" : "#ef4444",
                width: isHighlighted ? 3 : 2,
                lineDash: [8, 4]
              })
            })
          ]

          // Add endpoint markers (circles at line ends) - reference architecture pattern
          if (geometry && geometry.getType() === "LineString") {
            const lineGeom = geometry as LineString
            const coords = lineGeom.getCoordinates()
            if (coords.length >= 2) {
              // Start point marker
              lineStyles.push(new Style({
                geometry: new Point(coords[0]),
                image: new CircleStyle({
                  radius: isHighlighted ? 6 : 5,
                  fill: new Fill({ color: isHighlighted ? "#dc2626" : "#ef4444" }),
                  stroke: new Stroke({ color: "#ffffff", width: 2 })
                })
              }))
              // End point marker
              lineStyles.push(new Style({
                geometry: new Point(coords[coords.length - 1]),
                image: new CircleStyle({
                  radius: isHighlighted ? 6 : 5,
                  fill: new Fill({ color: isHighlighted ? "#dc2626" : "#ef4444" }),
                  stroke: new Stroke({ color: "#ffffff", width: 2 })
                })
              }))
            }
          }

          // Add label if present
          if (props.label) {
            lineStyles.push(new Style({
              text: new Text({
                text: props.label,
                font: "12px sans-serif",
                fill: new Fill({ color: "#1f2937" }),
                stroke: new Stroke({ color: "#ffffff", width: 3 }),
                offsetY: -10
              })
            }))
          }

          styles = lineStyles
          break
        }

        case "note":
        case "point":
          styles = new Style({
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
          break

        default:
          styles = new Style({
            stroke: new Stroke({ color, width: 2 }),
            fill: new Fill({ color: `${color}33` })
          })
      }

      // Cache the style
      styleCache.set(cacheKey, styles)
      return styles
    }
  }, [])

  // Initialize map once
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return
    if (pageWidth <= 0 || pageHeight <= 0) return // Guard against invalid dimensions

    // Clear style cache on new map initialization
    styleCache.clear()

    // Vector source for annotations
    const vectorSource = new VectorSource()
    vectorSourceRef.current = vectorSource

    // Vector layer with style function
    const vectorLayer = new VectorLayer({
      source: vectorSource,
      style: createStyleFunction()
    })

    // Tile source - using custom PDF projection
    // Reference: ibeam stores tiles at GCS and serves via CDN with proper caching
    const tileSource = new XYZ({
      url: `/api/tiles/${documentId}/${pageNumber}/{z}/{x}/{y}.png`,
      tileSize: TILE_SIZE,
      maxZoom: maxZoom,
      minZoom: 0,
      projection: pdfProjection
    })

    const tileLayer = new TileLayer({
      source: tileSource,
      preload: 2 // Progressive loading - load 2 zoom levels ahead
    })
    tileLayerRef.current = tileLayer

    // Calculate initial resolution to fit page in container
    const containerWidth = mapContainerRef.current.clientWidth || 800
    const containerHeight = mapContainerRef.current.clientHeight || 600
    const initialResolution = Math.max(
      pageWidth / containerWidth,
      pageHeight / containerHeight
    ) * 1.1 // 10% padding
    initialResolutionRef.current = initialResolution
    currentResolutionRef.current = initialResolution

    // Create map with custom PDF projection
    // Reference: ibeam uses extent [0, -pdfHeight, pdfWidth, 0] with center at [width/2, -height/2]
    const map = new Map({
      target: mapContainerRef.current,
      layers: [tileLayer, vectorLayer],
      view: new View({
        projection: pdfProjection,
        extent: extent,
        center: [pageWidth / 2, -pageHeight / 2], // Center of PDF
        resolution: initialResolution,
        minResolution: 0.125,
        maxResolution: initialResolution * 4,
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

    // Track zoom/resolution changes for style caching and UI
    map.getView().on("change:resolution", () => {
      const resolution = map.getView().getResolution()
      if (resolution && initialResolutionRef.current) {
        currentResolutionRef.current = resolution
        const zoom = Math.round((initialResolutionRef.current / resolution) * 100)
        setCurrentZoom(zoom)
      }
    })

    // Handle annotation clicks
    map.on("click", (e) => {
      const features = map.getFeaturesAtPixel(e.pixel)
      if (features && features.length > 0 && onAnnotationClick) {
        const feature = features[0]
        const props = feature.getProperties()
        if (props.id) {
          onAnnotationClick({
            id: props.id,
            type: props.type,
            coordinates: props.coordinates,
            label: props.label,
            color: props.color
          })
        }
      }
    })

    // Pointer cursor on annotations
    map.on("pointermove", (e) => {
      const hit = map.hasFeatureAtPixel(e.pixel)
      const target = map.getTargetElement()
      if (target) {
        target.style.cursor = hit ? "pointer" : "grab"
      }
    })

    mapRef.current = map

    return () => {
      map.setTarget(undefined)
      mapRef.current = null
      tileLayerRef.current = null
      vectorSourceRef.current = null
    }
  // Only run on mount - we update tile source separately
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update tile source when document or page changes
  useEffect(() => {
    if (!tileLayerRef.current || !mapRef.current) return
    if (pageWidth <= 0 || pageHeight <= 0) return

    // Clear style cache when page changes
    styleCache.clear()

    const newTileSource = new XYZ({
      url: `/api/tiles/${documentId}/${pageNumber}/{z}/{x}/{y}.png`,
      tileSize: TILE_SIZE,
      maxZoom: maxZoom,
      minZoom: 0,
      projection: pdfProjection
    })

    tileLayerRef.current.setSource(newTileSource)

    // Calculate new resolution to fit
    const container = mapContainerRef.current
    if (container) {
      const containerWidth = container.clientWidth || 800
      const containerHeight = container.clientHeight || 600
      const newResolution = Math.max(
        pageWidth / containerWidth,
        pageHeight / containerHeight
      ) * 1.1
      initialResolutionRef.current = newResolution
      currentResolutionRef.current = newResolution

      // Animate to new view - center at middle of page
      const view = mapRef.current.getView()
      view.animate({
        center: [pageWidth / 2, -pageHeight / 2],
        resolution: newResolution,
        duration: 200
      })
    }
  }, [documentId, pageNumber, pageWidth, pageHeight, maxZoom, pdfProjection])

  // Update annotations when they change (supports both Annotation[] and GeoJSONFeatureCollection)
  useEffect(() => {
    if (!vectorSourceRef.current) return

    vectorSourceRef.current.clear()

    // Process simple Annotation[] format
    annotations.forEach((annotation) => {
      let geometry

      if (annotation.type === "note" && annotation.coordinates.length === 1) {
        // Single point for notes
        geometry = new Point(annotation.coordinates[0])
      } else if (annotation.coordinates.length === 2) {
        // Line for measurements
        geometry = new LineString(annotation.coordinates)
      } else if (annotation.coordinates.length >= 3) {
        // Polygon for highlights and closed shapes
        geometry = new Polygon([annotation.coordinates])
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

    // Process GeoJSON FeatureCollection format (ibeam-style)
    if (geoJsonFeatures?.features) {
      geoJsonFeatures.features.forEach((geoFeature) => {
        let geometry

        const geomType = geoFeature.geometry.type
        const coords = geoFeature.geometry.coordinates

        if (geomType === "Point") {
          geometry = new Point(coords as number[])
        } else if (geomType === "LineString") {
          geometry = new LineString(coords as number[][])
        } else if (geomType === "Polygon") {
          geometry = new Polygon(coords as number[][][])
        } else {
          return // Skip unknown geometry types
        }

        // Map GeoJSON geometry type to annotation type for styling
        const annotationType = geomType.toLowerCase()

        const feature = new Feature({
          geometry,
          id: geoFeature.id,
          type: annotationType,
          vector_layer_id: geoFeature.properties.vector_layer_id,
          count: geoFeature.properties.count,
          measurement: geoFeature.properties.measurement,
          unit: geoFeature.properties.unit,
          label: geoFeature.properties.label ||
            (geoFeature.properties.measurement
              ? `${geoFeature.properties.measurement.toFixed(2)} ${geoFeature.properties.unit || ""}`.trim()
              : undefined),
          color: geoFeature.properties.color
        })

        vectorSourceRef.current?.addFeature(feature)
      })
    }
  }, [annotations, geoJsonFeatures])

  // Trigger style re-render when highlightedItemId changes
  useEffect(() => {
    if (!vectorSourceRef.current) return
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

  // Navigate to specific coordinates (PDF pixel coordinates with Y-inverted)
  // Reference: ibeam coordinates are [x, -y] where x is from left, y is from top going down
  const navigateTo = useCallback((x: number, y: number, zoom?: number) => {
    if (!mapRef.current) return
    const view = mapRef.current.getView()

    const animationOptions: { center: [number, number]; duration: number; resolution?: number } = {
      center: [x, -y], // PDF coordinates: positive X from left, negative Y from top
      duration: 300
    }

    if (zoom && initialResolutionRef.current) {
      animationOptions.resolution = initialResolutionRef.current / (zoom / 100)
    }

    view.animate(animationOptions)
  }, [])

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    navigateTo,
    fitToPage: handleFitToPage
  }), [navigateTo, handleFitToPage])

  // Show error state if dimensions are invalid
  if (pageWidth <= 0 || pageHeight <= 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted">
        <div className="text-sm text-muted-foreground">Invalid page dimensions</div>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      {/* Map container */}
      <div
        ref={mapContainerRef}
        className="h-full w-full bg-muted"
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
