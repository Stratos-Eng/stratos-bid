'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Map, View, Overlay } from 'ol';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import XYZ from 'ol/source/XYZ';
import TileGrid from 'ol/tilegrid/TileGrid';
import ImageLayer from 'ol/layer/Image';
import Static from 'ol/source/ImageStatic';
import { Draw, Select, Snap } from 'ol/interaction';
import { Style, Stroke, Fill, Circle as CircleStyle, RegularShape } from 'ol/style';
import { Feature } from 'ol';
import { Point, LineString, Polygon } from 'ol/geom';
import type { Coordinate } from 'ol/coordinate';
import type { MapBrowserEvent } from 'ol';
import 'ol/ol.css';

import { useTakeoffStore, type MeasurementTool, type TakeoffMeasurement, type ScaleCalibration } from '@/lib/stores/takeoff-store';

// Types for vector data
interface SnapPoint {
  type: 'endpoint' | 'midpoint' | 'intersection';
  coords: [number, number];
}

interface LineSegment {
  start: [number, number];
  end: [number, number];
}

interface PdfViewerProps {
  sheetId: string;
  imageUrl?: string;
  tileUrlTemplate?: string;
  tilesReady?: boolean;
  width: number;
  height: number;
  onMeasurementComplete?: (measurement: Omit<TakeoffMeasurement, 'id' | 'createdAt'>) => void;
  onCalibrationChange?: (calibration: ScaleCalibration | null) => void;
}

// Format measurement for display
function formatMeasurement(value: number, type: 'count' | 'linear' | 'area', unit: string): string {
  if (type === 'count') {
    return `${Math.round(value)} EA`;
  }

  // If unit is pixels, show raw pixel value
  if (unit === 'px' || unit === 'px²') {
    return `${Math.round(value)} ${unit}`;
  }

  if (type === 'linear') {
    // Show in feet and inches for LF
    if (unit === 'LF') {
      const feet = Math.floor(value);
      const inches = Math.round((value - feet) * 12);
      if (inches === 12) {
        return `${feet + 1}' 0"`;
      }
      return feet > 0 ? `${feet}' ${inches}"` : `${inches}"`;
    }
    // For meters, show decimal
    return `${value.toFixed(2)} ${unit}`;
  }

  // Area
  return `${value.toFixed(2)} ${unit}`;
}

// Create category-colored style
function createFeatureStyle(color: string, isSelected: boolean = false): Style {
  const strokeWidth = isSelected ? 3 : 2;
  const fillOpacity = isSelected ? 0.3 : 0.15;
  const strokeColor = isSelected ? '#f59e0b' : color;

  return new Style({
    stroke: new Stroke({ color: strokeColor, width: strokeWidth }),
    fill: new Fill({ color: `${color}${Math.round(fillOpacity * 255).toString(16).padStart(2, '0')}` }),
    image: new RegularShape({
      points: 4,
      radius: isSelected ? 10 : 8,
      angle: Math.PI / 4,
      fill: new Fill({ color }),
      stroke: new Stroke({ color: '#fff', width: 2 }),
    }),
  });
}

// Drawing style (dashed)
const drawingStyle = new Style({
  stroke: new Stroke({ color: '#10b981', width: 2, lineDash: [8, 8] }),
  fill: new Fill({ color: 'rgba(16, 185, 129, 0.1)' }),
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: '#10b981' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
});

// Snap indicator styles by type
const SNAP_STYLES: Record<string, Style> = {
  endpoint: new Style({
    image: new RegularShape({
      points: 4,
      radius: 8,
      angle: Math.PI / 4,
      fill: new Fill({ color: '#ef4444' }),
      stroke: new Stroke({ color: '#fff', width: 2 }),
    }),
  }),
  midpoint: new Style({
    image: new RegularShape({
      points: 4,
      radius: 8,
      angle: 0,
      fill: new Fill({ color: '#3b82f6' }),
      stroke: new Stroke({ color: '#fff', width: 2 }),
    }),
  }),
  intersection: new Style({
    image: new RegularShape({
      points: 4,
      radius: 10,
      angle: Math.PI / 4,
      fill: new Fill({ color: '#f59e0b' }),
      stroke: new Stroke({ color: '#fff', width: 2 }),
    }),
  }),
};

// Style for highlighted snap lines
const snapLineStyle = new Style({
  stroke: new Stroke({ color: '#f59e0b', width: 2 }),
});

// Helper: distance between points
function distancePoints(p1: [number, number], p2: [number, number]): number {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// Find nearest point on line segment
function nearestPointOnLine(
  px: number,
  py: number,
  line: LineSegment
): { point: [number, number]; dist: number } | null {
  const [x1, y1] = line.start;
  const [x2, y2] = line.end;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) return null;

  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const nearX = x1 + t * dx;
  const nearY = y1 + t * dy;

  const dist = Math.sqrt((px - nearX) ** 2 + (py - nearY) ** 2);

  return { point: [nearX, nearY], dist };
}

export function PdfViewer({
  sheetId,
  imageUrl,
  tileUrlTemplate,
  tilesReady,
  width,
  height,
  onMeasurementComplete,
  onCalibrationChange,
}: PdfViewerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Map | null>(null);
  const vectorSourceRef = useRef<VectorSource | null>(null);
  const snapSourceRef = useRef<VectorSource | null>(null);
  const snapHighlightSourceRef = useRef<VectorSource | null>(null);
  const drawInteractionRef = useRef<Draw | null>(null);
  const measureTooltipRef = useRef<Overlay | null>(null);
  const measureTooltipElementRef = useRef<HTMLDivElement | null>(null);
  const snapIndicatorRef = useRef<Overlay | null>(null);
  const snapIndicatorElementRef = useRef<HTMLDivElement | null>(null);

  const {
    activeTool,
    activeCategory,
    isDrawing,
    snapEnabled,
    measurements,
    selectedMeasurementIds,
    project,
    setIsDrawing,
    setZoom,
    setCenter,
    calibration,
    setPanToMeasurement,
  } = useTakeoffStore();

  const [currentMeasurement, setCurrentMeasurement] = useState<string>('');
  const [vectorsLoaded, setVectorsLoaded] = useState(false);
  const [vectorQuality, setVectorQuality] = useState<string | null>(null);
  const [snapPoints, setSnapPoints] = useState<SnapPoint[]>([]);
  const [snapLines, setSnapLines] = useState<LineSegment[]>([]);
  const [currentSnap, setCurrentSnap] = useState<{ type: string; coords: [number, number] } | null>(null);
  const [altPressed, setAltPressed] = useState(false);
  const [shiftPressed, setShiftPressed] = useState(false);
  const [imageLoadError, setImageLoadError] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(true);
  const [showLoadingIndicator, setShowLoadingIndicator] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionError, setExtractionError] = useState<string | null>(null);
  const [vectorsStale, setVectorsStale] = useState(false);

  // Debounce loading indicator - only show after 150ms to avoid flicker
  useEffect(() => {
    if (imageLoading) {
      const timer = setTimeout(() => setShowLoadingIndicator(true), 150);
      return () => clearTimeout(timer);
    } else {
      setShowLoadingIndicator(false);
    }
  }, [imageLoading]);

  // Get category by ID
  const getCategoryById = useCallback((categoryId: string) => {
    return project?.categories.find(c => c.id === categoryId);
  }, [project?.categories]);

  // Calculate real-world measurement from pixel geometry using calibration
  const calculateQuantity = useCallback((geometry: Point | LineString | Polygon): { quantity: number; type: 'count' | 'linear' | 'area'; unit: string } => {
    // Get scale from calibration or default to 1:1 (pixels)
    const pixelsPerUnit = calibration?.pixelsPerUnit || 0;
    const unit = calibration?.unit || 'ft';
    const hasCalibration = pixelsPerUnit > 0;

    if (geometry instanceof Point) {
      return { quantity: 1, type: 'count', unit: 'EA' };
    }

    if (geometry instanceof LineString) {
      const coords = geometry.getCoordinates();
      let totalPx = 0;
      for (let i = 1; i < coords.length; i++) {
        const dx = coords[i][0] - coords[i - 1][0];
        const dy = coords[i][1] - coords[i - 1][1];
        totalPx += Math.sqrt(dx * dx + dy * dy);
      }
      // Convert pixels to real-world units
      const quantity = hasCalibration ? totalPx / pixelsPerUnit : totalPx;
      const displayUnit = hasCalibration ? (unit === 'ft' ? 'LF' : 'm') : 'px';
      return { quantity, type: 'linear', unit: displayUnit };
    }

    if (geometry instanceof Polygon) {
      const coords = geometry.getCoordinates()[0];
      let areaPx = 0;
      for (let i = 0; i < coords.length - 1; i++) {
        areaPx += coords[i][0] * coords[i + 1][1];
        areaPx -= coords[i + 1][0] * coords[i][1];
      }
      areaPx = Math.abs(areaPx) / 2;
      // Convert square pixels to real-world square units
      const quantity = hasCalibration ? areaPx / (pixelsPerUnit * pixelsPerUnit) : areaPx;
      const displayUnit = hasCalibration ? (unit === 'ft' ? 'SF' : 'sqm') : 'px²';
      return { quantity, type: 'area', unit: displayUnit };
    }

    return { quantity: 0, type: 'count', unit: 'EA' };
  }, [calibration]);

  // Find nearest snap point to cursor
  const findNearestSnap = useCallback((
    cursorX: number,
    cursorY: number,
    tolerance: number = 15
  ): { type: string; coords: [number, number]; sourceLine?: LineSegment } | null => {
    let nearest: { type: string; coords: [number, number]; dist: number; sourceLine?: LineSegment } | null = null;

    // Check PDF snap points
    for (const point of snapPoints) {
      const dist = distancePoints([cursorX, cursorY], point.coords);
      if (dist < tolerance && (!nearest || dist < nearest.dist)) {
        nearest = { type: point.type, coords: point.coords, dist };
      }
    }

    // Check on-line snapping (perpendicular)
    for (const line of snapLines) {
      const result = nearestPointOnLine(cursorX, cursorY, line);
      if (result && result.dist < tolerance && (!nearest || result.dist < nearest.dist)) {
        nearest = { type: 'on-line', coords: result.point, dist: result.dist, sourceLine: line };
      }
    }

    // Also snap to existing annotations
    if (vectorSourceRef.current) {
      vectorSourceRef.current.getFeatures().forEach((feature) => {
        const geom = feature.getGeometry();
        if (geom instanceof Point) {
          const coords = geom.getCoordinates() as [number, number];
          const dist = distancePoints([cursorX, cursorY], coords);
          if (dist < tolerance && (!nearest || dist < nearest.dist)) {
            nearest = { type: 'annotation', coords, dist };
          }
        } else if (geom instanceof LineString) {
          const lineCoords = geom.getCoordinates();
          // Check endpoints
          for (const coord of lineCoords) {
            const dist = distancePoints([cursorX, cursorY], coord as [number, number]);
            if (dist < tolerance && (!nearest || dist < nearest.dist)) {
              nearest = { type: 'annotation', coords: coord as [number, number], dist };
            }
          }
        } else if (geom instanceof Polygon) {
          const polyCoords = geom.getCoordinates()[0];
          for (const coord of polyCoords) {
            const dist = distancePoints([cursorX, cursorY], coord as [number, number]);
            if (dist < tolerance && (!nearest || dist < nearest.dist)) {
              nearest = { type: 'annotation', coords: coord as [number, number], dist };
            }
          }
        }
      });
    }

    return nearest ? { type: nearest.type, coords: nearest.coords, sourceLine: nearest.sourceLine } : null;
  }, [snapPoints, snapLines]);

  // Load vectors for sheet
  useEffect(() => {
    async function loadVectors() {
      setExtractionError(null);

      try {
        const response = await fetch(`/api/takeoff/vectors?sheetId=${sheetId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch vectors');
        }

        const data = await response.json();

        if (data.vectorsReady && !data.vectorsStale) {
          setSnapPoints(data.snapPoints || []);
          setSnapLines(data.lines || []);
          setVectorQuality(data.quality);
          setVectorsLoaded(true);
          setVectorsStale(false);
        } else if (data.vectorsStale) {
          // Vectors exist but are stale - show warning, allow re-extract
          setSnapPoints(data.snapPoints || []);
          setSnapLines(data.lines || []);
          setVectorQuality(data.quality);
          setVectorsLoaded(true);
          setVectorsStale(true);
        } else {
          // Trigger vector extraction
          setIsExtracting(true);

          try {
            const extractResponse = await fetch('/api/takeoff/vectors', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sheetId }),
            });

            if (!extractResponse.ok) {
              const errData = await extractResponse.json();
              throw new Error(errData.error || 'Extraction failed');
            }

            const extractData = await extractResponse.json();

            // Reload vectors after extraction
            const reloadResponse = await fetch(`/api/takeoff/vectors?sheetId=${sheetId}`);
            if (reloadResponse.ok) {
              const reloadData = await reloadResponse.json();
              setSnapPoints(reloadData.snapPoints || []);
              setSnapLines(reloadData.lines || []);
              setVectorQuality(extractData.quality);
              setVectorsLoaded(true);
              setVectorsStale(false);
            }
          } finally {
            setIsExtracting(false);
          }
        }
      } catch (err) {
        console.error('Failed to load vectors:', err);
        setExtractionError(err instanceof Error ? err.message : 'Failed to load snap points');
        setIsExtracting(false);
      }
    }

    if (sheetId) {
      // Reset state when sheet changes
      setVectorsLoaded(false);
      setVectorsStale(false);
      setExtractionError(null);
      loadVectors();
    }
  }, [sheetId]);

  // Handler to re-extract vectors (for stale or error cases)
  const handleReExtract = async () => {
    setIsExtracting(true);
    setExtractionError(null);

    try {
      const extractResponse = await fetch('/api/takeoff/vectors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetId }),
      });

      if (!extractResponse.ok) {
        const errData = await extractResponse.json();
        throw new Error(errData.error || 'Extraction failed');
      }

      const extractData = await extractResponse.json();

      // Reload vectors
      const reloadResponse = await fetch(`/api/takeoff/vectors?sheetId=${sheetId}`);
      if (reloadResponse.ok) {
        const reloadData = await reloadResponse.json();
        setSnapPoints(reloadData.snapPoints || []);
        setSnapLines(reloadData.lines || []);
        setVectorQuality(extractData.quality);
        setVectorsLoaded(true);
        setVectorsStale(false);
      }
    } catch (err) {
      console.error('Re-extraction failed:', err);
      setExtractionError(err instanceof Error ? err.message : 'Re-extraction failed');
    } finally {
      setIsExtracting(false);
    }
  };

  // Keyboard modifiers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltPressed(true);
      if (e.key === 'Shift') setShiftPressed(true);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltPressed(false);
      if (e.key === 'Shift') setShiftPressed(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Initialize map
  useEffect(() => {
    if (!mapRef.current) return;

    const extent = [0, -height, width, 0];

    // Create vector sources
    const vectorSource = new VectorSource();
    vectorSourceRef.current = vectorSource;

    const snapSource = new VectorSource();
    snapSourceRef.current = snapSource;

    const snapHighlightSource = new VectorSource();
    snapHighlightSourceRef.current = snapHighlightSource;

    // Create layers
    const layers: (TileLayer<XYZ> | ImageLayer<Static> | VectorLayer<VectorSource>)[] = [];

    // Reset image state
    setImageLoadError(null);
    setImageLoading(true);

    // Background layer with error handling
    if (tilesReady && tileUrlTemplate && tileUrlTemplate.includes('{z}')) {
      // Use XYZ tiles with custom tile grid
      // Our tiles use: z=0 (1x1), z=1 (2x2), z=2 (4x4), z=3 (8x8), z=4 (16x16)
      const maxZoom = 4;
      const tileSize = 256;

      // Calculate resolutions for each zoom level
      // At z=0, one tile covers the whole page
      // Resolution = page size / (number of tiles * tile size)
      const resolutions: number[] = [];
      for (let z = 0; z <= maxZoom; z++) {
        const tilesPerSide = Math.pow(2, z);
        // Use the larger dimension to ensure full coverage
        const maxDim = Math.max(width, height);
        resolutions.push(maxDim / (tilesPerSide * tileSize));
      }

      const tileGrid = new TileGrid({
        extent: extent,
        resolutions: resolutions,
        tileSize: tileSize,
        origin: [0, 0], // Top-left origin
      });

      // Build URL with API fallback for on-demand generation
      // Template: https://blob.../tiles/{sheetId}/{z}/{x}/{y}.webp
      // We use API route which redirects to blob or generates on demand
      const apiTileUrl = `/api/tiles/${sheetId}/{z}/{x}/{y}.webp`;

      const xyzSource = new XYZ({
        url: apiTileUrl,
        tileGrid: tileGrid,
        projection: undefined, // No projection - use pixel coordinates
      });

      let tilesLoaded = 0;
      xyzSource.on('tileloadend', () => {
        tilesLoaded++;
        if (tilesLoaded >= 1) {
          setImageLoading(false);
        }
      });
      xyzSource.on('tileloaderror', (e) => {
        console.warn('Tile load error:', e);
        // Don't set error state - individual tile failures are ok
        // The on-demand generation might just be slow
      });

      layers.push(new TileLayer({ source: xyzSource }));

      // Set loading to false after a short delay if no tiles loaded
      // (handles case where all tiles are cached)
      setTimeout(() => setImageLoading(false), 500);
    } else if (tileUrlTemplate) {
      // Legacy: static image rendering
      const staticSource = new Static({
        url: tileUrlTemplate,
        imageExtent: extent,
      });
      staticSource.on('imageloadend', () => setImageLoading(false));
      staticSource.on('imageloaderror', () => {
        setImageLoading(false);
        setImageLoadError('Failed to load PDF page. The file may be corrupted or too large.');
      });
      layers.push(new ImageLayer({ source: staticSource }));
    } else if (imageUrl) {
      const staticSource = new Static({
        url: imageUrl,
        imageExtent: extent,
      });
      staticSource.on('imageloadend', () => setImageLoading(false));
      staticSource.on('imageloaderror', () => {
        setImageLoading(false);
        setImageLoadError('Failed to load image. Please try refreshing the page.');
      });
      layers.push(new ImageLayer({ source: staticSource }));
    } else {
      setImageLoading(false);
    }

    // Snap highlight layer (for line highlighting)
    layers.push(
      new VectorLayer({
        source: snapHighlightSource,
        style: snapLineStyle,
        zIndex: 5,
      })
    );

    // Snap points layer (invisible - for visual indicators via overlay)
    layers.push(
      new VectorLayer({
        source: snapSource,
        style: () => new Style({}), // Invisible - we use overlays for indicators
        zIndex: 10,
      })
    );

    // Vector layer for measurements
    layers.push(
      new VectorLayer({
        source: vectorSource,
        style: (feature) => {
          const id = feature.getId() as string;
          const measurement = feature.get('measurement') as TakeoffMeasurement | undefined;
          const isSelected = selectedMeasurementIds.includes(id);
          const category = measurement ? getCategoryById(measurement.categoryId) : null;
          const color = category?.color || '#3b82f6';
          return createFeatureStyle(color, isSelected);
        },
        zIndex: 20,
      })
    );

    // Create measurement tooltip overlay
    const tooltipElement = document.createElement('div');
    tooltipElement.className = 'bg-black/80 text-white px-3 py-1.5 rounded-lg text-sm font-mono whitespace-nowrap pointer-events-none';
    measureTooltipElementRef.current = tooltipElement;

    const tooltipOverlay = new Overlay({
      element: tooltipElement,
      offset: [15, 0],
      positioning: 'center-left',
      stopEvent: false,
    });
    measureTooltipRef.current = tooltipOverlay;

    // Create snap indicator overlay
    const snapIndicatorElement = document.createElement('div');
    snapIndicatorElement.className = 'pointer-events-none';
    snapIndicatorElementRef.current = snapIndicatorElement;

    const snapIndicatorOverlay = new Overlay({
      element: snapIndicatorElement,
      positioning: 'center-center',
      stopEvent: false,
    });
    snapIndicatorRef.current = snapIndicatorOverlay;

    // Create map
    const map = new Map({
      target: mapRef.current,
      layers,
      overlays: [tooltipOverlay, snapIndicatorOverlay],
      view: new View({
        center: [width / 2, -height / 2],
        zoom: 0,
        minZoom: -2,
        maxZoom: 6,
        extent: [-width * 0.5, -height * 1.5, width * 1.5, height * 0.5],
      }),
      controls: [],
    });

    mapInstance.current = map;

    // Track zoom/pan
    map.getView().on('change:resolution', () => {
      setZoom(map.getView().getZoom() || 1);
    });

    map.getView().on('change:center', () => {
      const center = map.getView().getCenter();
      if (center) {
        setCenter([center[0], center[1]]);
      }
    });

    // Pointer move handler for snap feedback
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pointerMoveHandler = (e: MapBrowserEvent<any>) => {
      if (!snapEnabled || altPressed) {
        setCurrentSnap(null);
        snapIndicatorOverlay.setPosition(undefined);
        snapHighlightSource.clear();
        return;
      }

      const [cursorX, cursorY] = e.coordinate;
      const snap = findNearestSnap(cursorX, cursorY);

      if (snap) {
        setCurrentSnap(snap);
        snapIndicatorOverlay.setPosition(snap.coords);

        // Update indicator style based on type
        const indicator = snapIndicatorElementRef.current;
        if (indicator) {
          const iconMap: Record<string, string> = {
            endpoint: '●',
            midpoint: '◆',
            intersection: '╳',
            'on-line': '┴',
            annotation: '○',
          };
          const colorMap: Record<string, string> = {
            endpoint: '#ef4444',
            midpoint: '#3b82f6',
            intersection: '#f59e0b',
            'on-line': '#10b981',
            annotation: '#8b5cf6',
          };
          indicator.innerHTML = `<div class="w-6 h-6 rounded-full flex items-center justify-center text-white text-sm font-bold shadow-lg" style="background: ${colorMap[snap.type] || '#3b82f6'}">${iconMap[snap.type] || '●'}</div>`;
        }

        // Highlight source line if on-line snap
        snapHighlightSource.clear();
        if (snap.sourceLine) {
          const lineFeature = new Feature({
            geometry: new LineString([snap.sourceLine.start, snap.sourceLine.end]),
          });
          snapHighlightSource.addFeature(lineFeature);
        }
      } else {
        setCurrentSnap(null);
        snapIndicatorOverlay.setPosition(undefined);
        snapHighlightSource.clear();
      }
    };

    map.on('pointermove', pointerMoveHandler);

    return () => {
      map.setTarget(undefined);
      mapInstance.current = null;
    };
  }, [sheetId, imageUrl, tileUrlTemplate, tilesReady, width, height, selectedMeasurementIds, getCategoryById, setZoom, setCenter, snapEnabled, altPressed, findNearestSnap]);

  // Sync measurements to vector source
  useEffect(() => {
    if (!vectorSourceRef.current) return;

    const source = vectorSourceRef.current;
    source.clear();

    measurements
      .filter((m) => m.sheetId === sheetId)
      .forEach((m) => {
        let geometry;
        switch (m.geometry.type) {
          case 'Point':
            geometry = new Point(m.geometry.coordinates as number[]);
            break;
          case 'LineString':
            geometry = new LineString(m.geometry.coordinates as number[][]);
            break;
          case 'Polygon':
            geometry = new Polygon(m.geometry.coordinates as number[][][]);
            break;
        }

        if (geometry) {
          const feature = new Feature({ geometry });
          feature.setId(m.id);
          feature.set('measurement', m);
          source.addFeature(feature);
        }
      });
  }, [measurements, sheetId]);

  // Populate snap source with PDF vectors
  useEffect(() => {
    if (!snapSourceRef.current) return;

    const source = snapSourceRef.current;
    source.clear();

    // Add snap points as features for snapping interaction
    for (const point of snapPoints) {
      const feature = new Feature({
        geometry: new Point(point.coords),
        snapType: point.type,
      });
      source.addFeature(feature);
    }

    // Add line endpoints for snapping
    for (const line of snapLines) {
      const startFeature = new Feature({
        geometry: new Point(line.start),
        snapType: 'endpoint',
      });
      const endFeature = new Feature({
        geometry: new Point(line.end),
        snapType: 'endpoint',
      });
      source.addFeature(startFeature);
      source.addFeature(endFeature);
    }
  }, [snapPoints, snapLines]);

  // Handle tool changes - setup drawing interactions
  useEffect(() => {
    if (!mapInstance.current || !vectorSourceRef.current) return;

    const map = mapInstance.current;

    // Remove existing draw interaction
    if (drawInteractionRef.current) {
      map.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }

    // Hide tooltip when not drawing
    if (measureTooltipRef.current) {
      measureTooltipRef.current.setPosition(undefined);
    }

    if (activeTool === 'select') {
      const select = new Select({
        style: (feature) => {
          const measurement = feature.get('measurement') as TakeoffMeasurement | undefined;
          const category = measurement ? getCategoryById(measurement.categoryId) : null;
          const color = category?.color || '#3b82f6';
          return createFeatureStyle(color, true);
        },
      });
      map.addInteraction(select);

      return () => {
        map.removeInteraction(select);
      };
    }

    // Map tools to geometry types
    const toolToType: Record<MeasurementTool, 'Point' | 'LineString' | 'Polygon' | 'Circle' | null> = {
      select: null,
      count: 'Point',
      line: 'LineString', // 2-point line
      linear: 'LineString', // Multi-point polyline
      area: 'Polygon',
      rectangle: 'Circle',
      calibrate: 'LineString', // Calibration draws a line
    };

    const drawType = toolToType[activeTool];
    if (!drawType) return;

    // For calibration, use a different handler
    if (activeTool === 'calibrate') {
      // Calibration mode - draw a line and store it
      const draw = new Draw({
        source: new VectorSource(),
        type: 'LineString',
        maxPoints: 2,
        style: new Style({
          stroke: new Stroke({
            color: '#FF6B00',
            width: 3,
            lineDash: [10, 5],
          }),
          image: new CircleStyle({
            radius: 6,
            fill: new Fill({ color: '#FF6B00' }),
          }),
        }),
      });

      draw.on('drawend', (event) => {
        const coords = (event.feature.getGeometry() as LineString).getCoordinates();
        useTakeoffStore.getState().setCalibrationLine(coords as [number, number][]);
      });

      map.addInteraction(draw);
      return () => {
        map.removeInteraction(draw);
      };
    }

    const getMeasurementType = (): 'count' | 'linear' | 'area' => {
      switch (activeTool) {
        case 'count': return 'count';
        case 'line':
        case 'linear': return 'linear';
        case 'area':
        case 'rectangle': return 'area';
        default: return 'count';
      }
    };

    // Create draw interaction
    const drawOptions: {
      source: VectorSource;
      type: 'Point' | 'LineString' | 'Polygon' | 'Circle';
      style: Style;
      maxPoints?: number;
      geometryFunction?: (coords: unknown, geom?: Polygon) => Polygon;
    } = {
      source: vectorSourceRef.current,
      type: drawType,
      style: drawingStyle,
    };

    // Line tool uses maxPoints: 2 for simple 2-point lines
    if (activeTool === 'line') {
      drawOptions.maxPoints = 2;
    }

    if (activeTool === 'rectangle') {
      drawOptions.geometryFunction = (coords: unknown, geometry?: Polygon) => {
        const coordinates = coords as Coordinate[];
        if (!geometry) {
          geometry = new Polygon([]);
        }
        const start = coordinates[0];
        const end = coordinates[1];
        if (start && end) {
          // Apply shift constraint for square
          let finalEnd = end;
          if (shiftPressed) {
            const dx = end[0] - start[0];
            const dy = end[1] - start[1];
            const size = Math.max(Math.abs(dx), Math.abs(dy));
            finalEnd = [
              start[0] + Math.sign(dx) * size,
              start[1] + Math.sign(dy) * size,
            ];
          }
          geometry.setCoordinates([
            [start, [start[0], finalEnd[1]], finalEnd, [finalEnd[0], start[1]], start],
          ]);
        }
        return geometry;
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const draw = new Draw(drawOptions as any);

    // Live measurement during drawing
    draw.on('drawstart', (event) => {
      setIsDrawing(true);
      setCurrentMeasurement('');

      const sketch = event.feature;
      const geometry = sketch.getGeometry();

      if (geometry) {
        geometry.on('change', () => {
          const geom = sketch.getGeometry();
          if (!geom) return;

          const { quantity, type, unit } = calculateQuantity(geom as Point | LineString | Polygon);
          const formatted = formatMeasurement(quantity, type, unit);
          setCurrentMeasurement(formatted);

          let tooltipCoord: Coordinate | undefined;
          if (geom instanceof Point) {
            tooltipCoord = geom.getCoordinates();
          } else if (geom instanceof LineString) {
            tooltipCoord = geom.getLastCoordinate();
          } else if (geom instanceof Polygon) {
            const coords = geom.getCoordinates()[0];
            tooltipCoord = coords[coords.length - 2];
          }

          if (tooltipCoord && measureTooltipRef.current && measureTooltipElementRef.current) {
            measureTooltipElementRef.current.textContent = formatted;
            measureTooltipRef.current.setPosition(tooltipCoord);
          }
        });
      }
    });

    draw.on('drawend', (event) => {
      setIsDrawing(false);

      if (measureTooltipRef.current) {
        measureTooltipRef.current.setPosition(undefined);
      }

      const feature = event.feature;
      const geometry = feature.getGeometry();

      if (!geometry) {
        vectorSourceRef.current?.removeFeature(feature);
        return;
      }

      // Use active category or "uncategorized" as fallback
      const categoryId = activeCategory?.id || 'uncategorized';

      const { quantity, type, unit } = calculateQuantity(geometry as Point | LineString | Polygon);

      let geometryType: 'Point' | 'LineString' | 'Polygon' = 'Point';
      let coordinates: number[] | number[][] | number[][][] = [];

      if (geometry instanceof Point) {
        geometryType = 'Point';
        coordinates = geometry.getCoordinates();
      } else if (geometry instanceof LineString) {
        geometryType = 'LineString';
        coordinates = geometry.getCoordinates();
      } else if (geometry instanceof Polygon) {
        geometryType = 'Polygon';
        coordinates = geometry.getCoordinates();
      }

      vectorSourceRef.current?.removeFeature(feature);

      if (onMeasurementComplete) {
        onMeasurementComplete({
          sheetId,
          categoryId,
          type: getMeasurementType(),
          geometry: { type: geometryType, coordinates },
          quantity,
          unit,
        });
      }
    });

    // Add snap interactions if enabled and not Alt-pressed
    const snapInteractions: Snap[] = [];
    if (snapEnabled && !altPressed) {
      // Snap to annotations
      if (vectorSourceRef.current) {
        snapInteractions.push(new Snap({ source: vectorSourceRef.current }));
      }
      // Snap to PDF vectors
      if (snapSourceRef.current) {
        snapInteractions.push(new Snap({ source: snapSourceRef.current }));
      }
      snapInteractions.forEach((s) => map.addInteraction(s));
    }

    map.addInteraction(draw);
    drawInteractionRef.current = draw;

    return () => {
      map.removeInteraction(draw);
      snapInteractions.forEach((s) => map.removeInteraction(s));
    };
  }, [activeTool, activeCategory, snapEnabled, altPressed, shiftPressed, sheetId, calculateQuantity, onMeasurementComplete, setIsDrawing, getCategoryById]);

  // Fit to view
  const fitToView = useCallback(() => {
    if (!mapInstance.current) return;
    mapInstance.current.getView().fit([0, -height, width, 0], {
      padding: [50, 50, 50, 50],
    });
  }, [width, height]);

  // Zoom controls
  const zoomIn = useCallback(() => {
    if (!mapInstance.current) return;
    const view = mapInstance.current.getView();
    view.animate({ zoom: (view.getZoom() || 0) + 1, duration: 200 });
  }, []);

  const zoomOut = useCallback(() => {
    if (!mapInstance.current) return;
    const view = mapInstance.current.getView();
    view.animate({ zoom: (view.getZoom() || 0) - 1, duration: 200 });
  }, []);

  // Pan to measurement by ID
  const panToMeasurement = useCallback((measurementId: string) => {
    if (!mapInstance.current || !vectorSourceRef.current) return;

    const feature = vectorSourceRef.current.getFeatureById(measurementId);
    if (!feature) return;

    const geometry = feature.getGeometry();
    if (!geometry) return;

    const extent = geometry.getExtent();
    const view = mapInstance.current.getView();

    // Pan and zoom to the feature with padding
    view.fit(extent, {
      padding: [100, 100, 100, 100],
      maxZoom: 3,
      duration: 300,
    });
  }, []);

  // Register panToMeasurement function with the store
  useEffect(() => {
    setPanToMeasurement(panToMeasurement);
    return () => {
      setPanToMeasurement(null);
    };
  }, [panToMeasurement, setPanToMeasurement]);

  // Get cursor class based on active tool
  const getCursorClass = () => {
    if (activeTool === 'select') return 'cursor-default';
    if (activeTool === 'count') return 'cursor-crosshair';
    if (activeTool === 'line') return 'cursor-crosshair';
    if (activeTool === 'linear') return 'cursor-crosshair';
    if (activeTool === 'area') return 'cursor-crosshair';
    if (activeTool === 'rectangle') return 'cursor-crosshair';
    if (activeTool === 'calibrate') return 'cursor-crosshair';
    return 'cursor-default';
  };

  // Get tool status message
  const getToolStatus = () => {
    // Note: We now allow measuring without a category (items go to "Uncategorized")

    switch (activeTool) {
      case 'select':
        return { message: 'Click to select measurements', type: 'info' as const };
      case 'count':
        return { message: 'Click to place count markers', type: 'info' as const };
      case 'line':
        return { message: 'Click two points to draw a line', type: 'info' as const };
      case 'linear':
        return { message: 'Click to start polyline, double-click to finish', type: 'info' as const };
      case 'area':
        return { message: 'Click to add vertices, double-click to close polygon', type: 'info' as const };
      case 'rectangle':
        return { message: 'Click and drag to draw rectangle', type: 'info' as const };
      case 'calibrate':
        return { message: 'Draw a line of known length to set scale', type: 'info' as const };
      default:
        return null;
    }
  };

  const toolStatus = getToolStatus();

  return (
    <div className="relative w-full h-full">
      {/* Map container with dynamic cursor */}
      <div ref={mapRef} className={`w-full h-full bg-gray-200 ${getCursorClass()}`} />

      {/* Tool status bar */}
      {toolStatus && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm shadow-lg bg-white/90 text-gray-700 border border-gray-200">
          {toolStatus.message}
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute top-4 right-4 flex flex-col gap-1 bg-white rounded-lg shadow-lg border">
        <button
          onClick={zoomIn}
          className="p-2 hover:bg-gray-100 rounded-t-lg text-lg font-bold w-10 h-10 flex items-center justify-center"
          title="Zoom In (+)"
        >
          +
        </button>
        <button
          onClick={fitToView}
          className="p-2 hover:bg-gray-100 border-y text-sm w-10 h-10 flex items-center justify-center"
          title="Fit to View (Home)"
        >
          ⊡
        </button>
        <button
          onClick={zoomOut}
          className="p-2 hover:bg-gray-100 rounded-b-lg text-lg font-bold w-10 h-10 flex items-center justify-center"
          title="Zoom Out (-)"
        >
          −
        </button>
      </div>

      {/* Vector quality indicator */}
      {vectorsLoaded && vectorQuality && (
        <div className="absolute top-4 right-20 bg-white rounded-lg shadow-lg border px-3 py-2 text-xs">
          <span className="text-gray-500">Snap: </span>
          <span className={
            vectorQuality === 'good' ? 'text-green-600' :
            vectorQuality === 'medium' ? 'text-yellow-600' :
            vectorQuality === 'poor' ? 'text-red-600' : 'text-gray-400'
          }>
            {vectorQuality === 'good' ? '●' : vectorQuality === 'medium' ? '◐' : vectorQuality === 'poor' ? '○' : '—'}
            {' '}{vectorQuality}
          </span>
        </div>
      )}

      {/* Current snap type indicator */}
      {currentSnap && snapEnabled && !altPressed && (
        <div className="absolute top-16 right-20 bg-white rounded-lg shadow-lg border px-3 py-2 text-xs">
          <span className="text-gray-500">Snapping to: </span>
          <span className="font-medium">{currentSnap.type}</span>
        </div>
      )}

      {/* Keyboard modifier hints */}
      {activeTool !== 'select' && (
        <div className="absolute bottom-16 right-4 bg-white/90 rounded-lg shadow border px-3 py-2 text-xs space-y-1">
          <div className={altPressed ? 'text-blue-600 font-medium' : 'text-gray-500'}>
            Alt: Disable snap
          </div>
          <div className={shiftPressed ? 'text-blue-600 font-medium' : 'text-gray-500'}>
            Shift: Constrain
          </div>
        </div>
      )}

      {/* Current measurement display */}
      {isDrawing && currentMeasurement && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/80 text-white px-4 py-2 rounded-lg font-mono text-lg shadow-lg">
          {currentMeasurement}
        </div>
      )}

      {/* Category and scale indicator - consolidated at bottom left */}
      {activeTool !== 'select' && activeTool !== 'calibrate' && activeTool !== null && (
        <div className="absolute bottom-4 left-4 flex items-center gap-2">
          {/* Category badge */}
          <div
            className="px-3 py-2 rounded-lg text-sm font-medium text-white shadow-lg"
            style={{ backgroundColor: activeCategory?.color || '#9ca3af' }}
          >
            {activeCategory?.name || 'Uncategorized'}
          </div>
          {/* Scale indicator (subtle when calibrated, prominent when not) */}
          {!calibration ? (
            <div className="px-2 py-1 rounded bg-yellow-100 text-yellow-700 text-xs shadow-lg">
              px only (K to set scale)
            </div>
          ) : (
            <div className="px-2 py-1 rounded bg-green-100 text-green-700 text-xs shadow-lg">
              {calibration.unit === 'ft' ? 'LF/SF' : 'm/sqm'}
            </div>
          )}
        </div>
      )}

      {/* Unified Loading Indicator - Shows progressive steps (debounced to avoid flicker) */}
      {(showLoadingIndicator || isExtracting) && (imageUrl || tileUrlTemplate) && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100/90 z-30">
          <div className="text-center max-w-sm px-6">
            {/* Animated spinner */}
            <div className="relative w-16 h-16 mx-auto mb-4">
              <div className="absolute inset-0 rounded-full border-4 border-gray-200" />
              <div className="absolute inset-0 rounded-full border-4 border-blue-600 border-t-transparent animate-spin" />
              {/* Inner icon */}
              <div className="absolute inset-0 flex items-center justify-center text-2xl">
                {imageLoading ? '📄' : '🔍'}
              </div>
            </div>

            {/* Step indicator */}
            <div className="space-y-3">
              {/* Step 1: Rendering PDF */}
              <div className={`flex items-center gap-3 justify-center ${imageLoading ? 'text-blue-600' : 'text-green-600'}`}>
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                  imageLoading ? 'bg-blue-600 text-white' : 'bg-green-600 text-white'
                }`}>
                  {imageLoading ? '1' : '✓'}
                </div>
                <span className={`font-medium ${imageLoading ? 'text-gray-700' : 'text-green-600'}`}>
                  {imageLoading ? 'Rendering PDF page...' : 'PDF rendered'}
                </span>
              </div>

              {/* Step 2: Extracting vectors */}
              <div className={`flex items-center gap-3 justify-center ${
                isExtracting ? 'text-blue-600' : imageLoading ? 'text-gray-400' : 'text-green-600'
              }`}>
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${
                  isExtracting ? 'bg-blue-600 text-white' : imageLoading ? 'bg-gray-300 text-gray-500' : 'bg-green-600 text-white'
                }`}>
                  {!imageLoading && !isExtracting ? '✓' : '2'}
                </div>
                <span className={`font-medium ${
                  isExtracting ? 'text-gray-700' : imageLoading ? 'text-gray-400' : 'text-green-600'
                }`}>
                  {isExtracting ? 'Analyzing drawing vectors...' : imageLoading ? 'Extract snap points' : 'Snap points ready'}
                </span>
              </div>
            </div>

            {/* Helpful context */}
            <div className="mt-4 pt-4 border-t border-gray-200">
              <p className="text-gray-500 text-sm">
                {imageLoading
                  ? 'Converting PDF to high-resolution image for precise measurements'
                  : 'Finding lines and intersections for accurate snapping'}
              </p>
              {isExtracting && (
                <p className="text-gray-400 text-xs mt-2">
                  Large drawings may take 10-30 seconds
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Vector extraction error */}
      {extractionError && !isExtracting && (
        <div className="absolute top-4 right-20 bg-red-50 border border-red-200 rounded-lg shadow-lg px-4 py-3 z-20 max-w-xs">
          <div className="flex items-start gap-2">
            <span className="text-red-500 text-lg">⚠️</span>
            <div>
              <p className="text-red-700 font-medium text-sm">Snap points unavailable</p>
              <p className="text-red-600 text-xs mt-1">{extractionError}</p>
              <button
                onClick={handleReExtract}
                className="mt-2 text-xs text-red-700 hover:text-red-800 underline"
              >
                Retry extraction
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stale vectors warning */}
      {vectorsStale && !isExtracting && !extractionError && (
        <div className="absolute top-4 right-20 bg-yellow-50 border border-yellow-200 rounded-lg shadow-lg px-4 py-3 z-20 max-w-xs">
          <div className="flex items-start gap-2">
            <span className="text-yellow-500 text-lg">⏰</span>
            <div>
              <p className="text-yellow-700 font-medium text-sm">Snap points may be outdated</p>
              <p className="text-yellow-600 text-xs mt-1">Sheet was updated after extraction</p>
              <button
                onClick={handleReExtract}
                className="mt-2 text-xs text-yellow-700 hover:text-yellow-800 underline"
              >
                Re-extract snap points
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error state */}
      {imageLoadError && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-50 z-30">
          <div className="text-center max-w-md p-6">
            <div className="text-5xl mb-4">⚠️</div>
            <p className="text-lg font-medium text-red-700 mb-2">PDF Load Failed</p>
            <p className="text-sm text-red-600 mb-4">{imageLoadError}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
            >
              Refresh Page
            </button>
          </div>
        </div>
      )}

      {/* No image placeholder */}
      {!imageUrl && !tileUrlTemplate && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-200">
          <div className="text-center text-gray-500">
            <div className="text-5xl mb-4">📄</div>
            <p className="text-lg font-medium">No PDF loaded</p>
            <p className="text-sm mt-1">Upload a PDF to start takeoff</p>
          </div>
        </div>
      )}
    </div>
  );
}
