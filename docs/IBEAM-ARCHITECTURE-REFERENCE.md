# ibeam.ai Architecture Reference

> **Context**: This document was created from a deep reverse-engineering session of ibeam.ai (Beam AI), a construction takeoff software. The goal was to understand how to build a similar PDF blueprint viewer with annotation and measurement capabilities for the Stratos project.
>
> **Date**: January 7, 2026
>
> **Source URL analyzed**: `https://app.ibeam.ai/blueprint/shared-view?fid=all_pdf&id=ce4cc515-a229-448b-b518-23ce95ef46bd&selected_sheet=f924bcf8-5003-43df-9903-add33ca1516a&tab=all_features&wspc=false`

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Tech Stack Discovery](#tech-stack-discovery)
3. [PDF Rendering Architecture](#pdf-rendering-architecture)
4. [Tile Generation Backend](#tile-generation-backend)
5. [OpenLayers Vector Layer Styling](#openlayers-vector-layer-styling)
6. [Drawing Tools Implementation](#drawing-tools-implementation)
7. [Data Model and API Design](#data-model-and-api-design)
8. [API Endpoints Reference](#api-endpoints-reference)
9. [Complete Code Examples](#complete-code-examples)

---

## Executive Summary

### What is ibeam.ai?

ibeam.ai (Beam AI) is a construction takeoff software that:
- Reads PDF blueprints and extracts material quantities
- Allows annotations/measurements on PDFs
- Exports to Excel/PDF formats
- Has collaborative cloud-based viewing
- Uses AI to auto-detect and count items

### Key Architectural Insight

**They don't use PDF.js!** Instead, they pre-render PDFs as map tiles and use OpenLayers to display them. This is a brilliant approach that provides:
- Instant loading (no client-side PDF parsing)
- Infinite zoom without quality loss
- Memory efficiency (only visible tiles loaded)
- Easy annotation overlays using standard map layer system

---

## Tech Stack Discovery

### Actual Tech Stack (Reverse-Engineered)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ibeam.ai TECH STACK (ACTUAL)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  FRAMEWORK         │  React 18.3.1 (SPA, NOT Next.js)                       │
│  ROUTING           │  React Router v6 (@remix-run/router)                   │
│  STATE             │  React Query (@tanstack/query-core 4.41)               │
│  UI COMPONENTS     │  Material UI (MUI) + Ant Design 4.20                   │
│  STYLING           │  CSS Modules (style-module_xxx__hash)                  │
│  MAP/CANVAS        │  OpenLayers (ol) - for PDF viewing!                    │
│  DATA GRID         │  AG Grid (for takeoff tables)                          │
│  RICH TEXT         │  Quill Editor                                          │
│  HTTP              │  Axios 1.13.2                                          │
│  UTILITIES         │  Lodash, date-fns, Turf.js (geo)                       │
│  ANALYTICS         │  PostHog, Sentry, Google Ads, HubSpot                  │
│  REAL-TIME         │  Firebase Database                                     │
│  BUILD TOOL        │  Webpack (chunked bundles)                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### JavaScript Bundles Discovered

```
https://app.ibeam.ai/assets/js/runtime.6cdcb445.js
https://app.ibeam.ai/assets/js/vendor-react.04d764a1.js
https://app.ibeam.ai/assets/js/vendor-ol.32b0d348.chunk.js          # OpenLayers
https://app.ibeam.ai/assets/js/vendor-ag-grid.37ac6237.chunk.js     # AG Grid
https://app.ibeam.ai/assets/js/vendor-quill.b1b71ce9.chunk.js       # Quill
https://app.ibeam.ai/assets/js/antdVendor...js                      # Ant Design
https://app.ibeam.ai/assets/js/vendors.tanstack+query-core...js     # React Query
https://app.ibeam.ai/assets/js/vendors.turf+isobands...js           # Turf.js
https://app.ibeam.ai/assets/js/vendors.firebase+database...js       # Firebase
```

### CSS Architecture

- **CSS Modules**: `style-module_{componentName}__{hash}` pattern
- **MUI Components**: 65+ MUI classes detected
- **BEM for custom components**: `feat-panel__feature-content`

---

## PDF Rendering Architecture

### The Innovation: PDF as Map Tiles

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PDF AS MAP TILES ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. BACKEND: PDFs are converted to image tiles                              │
│      └── Storage: Google Cloud Storage (GCS)                                │
│      └── Path: /autofx-outputs/PDFToTilesConversion/{date}/{uuid}/{z}/{x}/{y}│
│      └── Format: PNG tiles at multiple zoom levels                          │
│                                                                              │
│   2. FRONTEND: OpenLayers renders tiles like a map                          │
│      └── TileLayer loads tiles on demand                                    │
│      └── Supports zoom/pan like Google Maps                                 │
│      └── Vector features overlay on top (GeoJSON)                           │
│                                                                              │
│   WHY THIS IS BRILLIANT:                                                     │
│   • No client-side PDF parsing (fast!)                                      │
│   • Infinite zoom without quality loss                                      │
│   • Only loads visible tiles (memory efficient)                             │
│   • Uses battle-tested map rendering engine                                 │
│   • Easy to add vector overlays for annotations                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Tile URL Structure (Actual)

```
https://storage.googleapis.com/autofx-outputs/PDFToTilesConversion/
  └── 2025/12/                          # Date prefix
      └── 8e4ef859-9369-4f5f-aeff-1b4e34a79c1a/   # Document UUID
          └── 6/                         # Zoom level (0-6)
              └── 0/                     # X coordinate
                  └── 0.png              # Y coordinate
```

### Layer Stack

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      OPENLAYERS LAYER STACK                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Layer 5: INTERACTION LAYER (Draw, Modify, Select)          [invisible]     │
│  Layer 4: HIGHLIGHT LAYER (selected/hovered features)       [top]           │
│  Layer 3: LABELS LAYER (measurement text, count badges)                     │
│  Layer 2: FEATURES LAYER (Points, Lines, Polygons)          [vector]        │
│  Layer 1: TILE LAYER (PDF rendered as tiles)                [bottom]        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### PDF.js vs Tile-Based Comparison

| PDF.js (Client-side) | Tile-Based (Server-side) |
|---------------------|-------------------------|
| ✗ Parses PDF on every load | ✓ Parse once, serve forever |
| ✗ Memory-heavy for large PDFs | ✓ Only load visible tiles |
| ✗ Slow initial render | ✓ Instant tile loading |
| ✗ Complex font/vector handling | ✓ Pre-rendered = perfect quality |
| ✗ Zoom requires re-render | ✓ Pre-computed zoom levels |
| ✗ Hard to overlay annotations | ✓ Standard map layer system |

---

## Tile Generation Backend

### Complete Python Implementation

```python
# tile_generator.py
import os
import math
from dataclasses import dataclass
from typing import Optional

import fitz  # PyMuPDF - fastest PDF library
from PIL import Image
import boto3
from celery import Celery

TILE_SIZE = 256
MAX_ZOOM = 6
DPI_BASE = 72
DPI_MAX = 300

celery = Celery('tiles', broker='redis://localhost:6379/0')
s3 = boto3.client('s3')


@dataclass
class TileConfig:
    tile_size: int = 256
    max_zoom: int = 6
    format: str = 'png'
    quality: int = 90
    background: str = 'white'


@dataclass
class PageInfo:
    page_number: int
    width_pixels: int
    height_pixels: int
    width_points: float
    height_points: float
    rotation: int


class PDFTileGenerator:
    """
    Converts PDF pages to map tiles for use with OpenLayers/Leaflet.

    Tile coordinate system follows WMTS pattern:
    - Origin at top-left
    - Z = zoom level (0 = most zoomed out)
    - X = column (left to right)
    - Y = row (top to bottom)
    """

    def __init__(self, config: Optional[TileConfig] = None):
        self.config = config or TileConfig()

    def get_page_info(self, pdf_path: str, page_number: int) -> PageInfo:
        """Extract page dimensions and metadata"""
        doc = fitz.open(pdf_path)
        page = doc[page_number]
        rect = page.rect

        scale = DPI_MAX / DPI_BASE
        width_pixels = int(rect.width * scale)
        height_pixels = int(rect.height * scale)

        doc.close()

        return PageInfo(
            page_number=page_number,
            width_pixels=width_pixels,
            height_pixels=height_pixels,
            width_points=rect.width,
            height_points=rect.height,
            rotation=page.rotation
        )

    def calculate_zoom_levels(self, page_info: PageInfo) -> list[dict]:
        """Calculate tile grid for each zoom level"""
        zoom_levels = []
        max_dim = max(page_info.width_pixels, page_info.height_pixels)

        natural_max_zoom = math.ceil(math.log2(max_dim / self.config.tile_size))
        actual_max_zoom = min(natural_max_zoom, self.config.max_zoom)

        for zoom in range(actual_max_zoom + 1):
            scale = 2 ** (zoom - actual_max_zoom)
            scaled_width = int(page_info.width_pixels * scale)
            scaled_height = int(page_info.height_pixels * scale)
            tiles_x = math.ceil(scaled_width / self.config.tile_size)
            tiles_y = math.ceil(scaled_height / self.config.tile_size)

            zoom_levels.append({
                'zoom': zoom,
                'scale': scale,
                'width': scaled_width,
                'height': scaled_height,
                'tiles_x': tiles_x,
                'tiles_y': tiles_y,
                'total_tiles': tiles_x * tiles_y
            })

        return zoom_levels

    def render_page_at_scale(self, pdf_path: str, page_number: int, scale: float) -> Image.Image:
        """Render a PDF page at a specific scale"""
        doc = fitz.open(pdf_path)
        page = doc[page_number]

        dpi_scale = DPI_MAX / DPI_BASE
        matrix = fitz.Matrix(dpi_scale * scale, dpi_scale * scale)
        pixmap = page.get_pixmap(matrix=matrix, alpha=False, colorspace=fitz.csRGB)

        img = Image.frombytes("RGB", [pixmap.width, pixmap.height], pixmap.samples)
        doc.close()
        return img

    def generate_tiles_for_zoom(self, page_image: Image.Image, zoom_info: dict, output_dir: str) -> list[str]:
        """Generate all tiles for a specific zoom level"""
        tile_paths = []
        zoom = zoom_info['zoom']

        if page_image.size != (zoom_info['width'], zoom_info['height']):
            resized = page_image.resize(
                (zoom_info['width'], zoom_info['height']),
                Image.Resampling.LANCZOS
            )
        else:
            resized = page_image

        for y in range(zoom_info['tiles_y']):
            for x in range(zoom_info['tiles_x']):
                left = x * self.config.tile_size
                top = y * self.config.tile_size
                right = min(left + self.config.tile_size, zoom_info['width'])
                bottom = min(top + self.config.tile_size, zoom_info['height'])

                tile = resized.crop((left, top, right, bottom))

                # Pad edge tiles
                if tile.size != (self.config.tile_size, self.config.tile_size):
                    padded = Image.new('RGB', (self.config.tile_size, self.config.tile_size), self.config.background)
                    padded.paste(tile, (0, 0))
                    tile = padded

                tile_path = os.path.join(output_dir, str(zoom), str(x), f"{y}.{self.config.format}")
                os.makedirs(os.path.dirname(tile_path), exist_ok=True)
                tile.save(tile_path, 'PNG', optimize=True)
                tile_paths.append(tile_path)

        return tile_paths

    def generate_all_tiles(self, pdf_path: str, page_number: int, output_dir: str) -> dict:
        """Generate all tiles for a PDF page"""
        page_info = self.get_page_info(pdf_path, page_number)
        zoom_levels = self.calculate_zoom_levels(page_info)

        max_zoom = zoom_levels[-1]
        full_res_image = self.render_page_at_scale(pdf_path, page_number, 1.0)

        all_tiles = []
        for zoom_info in zoom_levels:
            tiles = self.generate_tiles_for_zoom(full_res_image, zoom_info, output_dir)
            all_tiles.extend(tiles)

        return {
            'page_info': page_info.__dict__,
            'zoom_levels': zoom_levels,
            'total_tiles': len(all_tiles),
            'tile_paths': all_tiles
        }


@celery.task(bind=True)
def process_pdf_to_tiles(self, pdf_path: str, document_id: str, bucket: str):
    """Async task to convert PDF to tiles and upload to S3"""
    generator = PDFTileGenerator()
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    doc.close()

    results = []

    for page_num in range(total_pages):
        self.update_state(state='PROGRESS', meta={'current': page_num, 'total': total_pages})

        temp_dir = f"/tmp/tiles/{document_id}/{page_num}"
        result = generator.generate_all_tiles(pdf_path, page_num, temp_dir)

        s3_prefix = f"PDFToTilesConversion/{document_id}/{page_num}"
        for tile_path in result['tile_paths']:
            relative_path = os.path.relpath(tile_path, temp_dir)
            s3_key = f"{s3_prefix}/{relative_path}"
            s3.upload_file(
                tile_path, bucket, s3_key,
                ExtraArgs={'ContentType': 'image/png', 'CacheControl': 'max-age=31536000'}
            )

        results.append({
            'page_number': page_num,
            'page_info': result['page_info'],
            'tile_url': f"https://storage.googleapis.com/{bucket}/{s3_prefix}",
            'zoom_levels': result['zoom_levels']
        })

        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)

    return results
```

---

## OpenLayers Vector Layer Styling

### Complete Styling System

```typescript
// styles/featureStyles.ts
import { Style, Fill, Stroke, Circle, RegularShape, Text } from 'ol/style';
import { Feature } from 'ol';
import { Geometry, Point, LineString, Polygon } from 'ol/geom';

interface FeatureStyleConfig {
  color: string;
  fillOpacity: number;
  strokeWidth: number;
  strokeOpacity: number;
  pointRadius: number;
  pointShape: 'circle' | 'square' | 'diamond' | 'triangle' | 'star';
  showLabel: boolean;
  labelField: string;
}

const DEFAULT_STYLES: Record<string, FeatureStyleConfig> = {
  point: {
    color: '#E53935',      // Red for count markers
    fillOpacity: 0.9,
    strokeWidth: 2,
    strokeOpacity: 1,
    pointRadius: 10,
    pointShape: 'diamond',
    showLabel: true,
    labelField: 'count'
  },
  linestring: {
    color: '#1E88E5',      // Blue for linear measurements
    fillOpacity: 0,
    strokeWidth: 3,
    strokeOpacity: 1,
    pointRadius: 6,
    pointShape: 'circle',
    showLabel: true,
    labelField: 'measurement'
  },
  polygon: {
    color: '#43A047',      // Green for area measurements
    fillOpacity: 0.2,
    strokeWidth: 2,
    strokeOpacity: 1,
    pointRadius: 6,
    pointShape: 'circle',
    showLabel: true,
    labelField: 'area'
  }
};

function createPointShape(config: FeatureStyleConfig): Circle | RegularShape {
  const fill = new Fill({ color: hexToRgba(config.color, config.fillOpacity) });
  const stroke = new Stroke({ color: hexToRgba('#FFFFFF', config.strokeOpacity), width: config.strokeWidth });

  switch (config.pointShape) {
    case 'circle':
      return new Circle({ radius: config.pointRadius, fill, stroke });
    case 'diamond':
      return new RegularShape({ points: 4, radius: config.pointRadius, angle: 0, fill, stroke });
    case 'square':
      return new RegularShape({ points: 4, radius: config.pointRadius, angle: Math.PI / 4, fill, stroke });
    default:
      return new Circle({ radius: config.pointRadius, fill, stroke });
  }
}

export function createFeatureStyleFunction(customStyles?: Record<string, Partial<FeatureStyleConfig>>) {
  const styleCache = new Map<string, Style | Style[]>();

  return function styleFunction(feature: Feature<Geometry>, resolution: number): Style | Style[] {
    const geometry = feature.getGeometry();
    if (!geometry) return new Style();

    const geometryType = geometry.getType().toLowerCase();
    const featureId = feature.get('vector_layer_id') || feature.getId();
    const isSelected = feature.get('selected') === true;

    const cacheKey = `${featureId}-${geometryType}-${isSelected}-${resolution}`;
    if (styleCache.has(cacheKey)) return styleCache.get(cacheKey)!;

    const baseConfig = DEFAULT_STYLES[geometryType] || DEFAULT_STYLES.point;
    const customConfig = customStyles?.[featureId] || {};
    const config: FeatureStyleConfig = { ...baseConfig, ...customConfig };

    if (isSelected) {
      config.strokeWidth *= 1.5;
      config.pointRadius *= 1.2;
    }

    let styles: Style[];

    switch (geometryType) {
      case 'point':
        styles = createPointStyles(feature, config, resolution);
        break;
      case 'linestring':
        styles = createLineStyles(feature, config, resolution);
        break;
      case 'polygon':
        styles = createPolygonStyles(feature, config, resolution);
        break;
      default:
        styles = [new Style()];
    }

    styleCache.set(cacheKey, styles);
    return styles;
  };
}

function createPointStyles(feature: Feature<Geometry>, config: FeatureStyleConfig, resolution: number): Style[] {
  const styles: Style[] = [];
  const properties = feature.getProperties();

  styles.push(new Style({
    image: createPointShape(config),
    zIndex: 100
  }));

  const count = properties.count || 1;
  if (config.showLabel && count > 1) {
    styles.push(new Style({
      text: new Text({
        text: count.toString(),
        font: 'bold 11px Arial',
        fill: new Fill({ color: '#FFFFFF' }),
        stroke: new Stroke({ color: config.color, width: 3 }),
      }),
      zIndex: 101
    }));
  }

  return styles;
}

function createLineStyles(feature: Feature<Geometry>, config: FeatureStyleConfig, resolution: number): Style[] {
  const styles: Style[] = [];
  const geometry = feature.getGeometry() as LineString;

  styles.push(new Style({
    stroke: new Stroke({
      color: hexToRgba(config.color, config.strokeOpacity),
      width: config.strokeWidth,
      lineCap: 'round',
    }),
    zIndex: 50
  }));

  // Endpoint markers
  const coordinates = geometry.getCoordinates();
  if (coordinates.length >= 2) {
    [coordinates[0], coordinates[coordinates.length - 1]].forEach(coord => {
      styles.push(new Style({
        geometry: new Point(coord),
        image: new Circle({
          radius: config.pointRadius,
          fill: new Fill({ color: config.color }),
          stroke: new Stroke({ color: '#FFFFFF', width: 2 })
        }),
        zIndex: 51
      }));
    });
  }

  return styles;
}

function createPolygonStyles(feature: Feature<Geometry>, config: FeatureStyleConfig, resolution: number): Style[] {
  const styles: Style[] = [];

  styles.push(new Style({
    fill: new Fill({ color: hexToRgba(config.color, config.fillOpacity) }),
    stroke: new Stroke({
      color: hexToRgba(config.color, config.strokeOpacity),
      width: config.strokeWidth,
      lineDash: [5, 5]
    }),
    zIndex: 30
  }));

  return styles;
}

function hexToRgba(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export function createSelectionStyle(): Style {
  return new Style({
    fill: new Fill({ color: 'rgba(255, 255, 0, 0.3)' }),
    stroke: new Stroke({ color: '#FFD600', width: 3 }),
    image: new Circle({
      radius: 12,
      fill: new Fill({ color: 'rgba(255, 214, 0, 0.5)' }),
      stroke: new Stroke({ color: '#FFD600', width: 3 })
    }),
    zIndex: 200
  });
}
```

---

## Drawing Tools Implementation

### Complete Drawing Tools Hook

```typescript
// tools/useDrawingTools.ts
import { useEffect, useRef, useCallback } from 'react';
import Map from 'ol/Map';
import Draw, { createBox, DrawEvent } from 'ol/interaction/Draw';
import Modify from 'ol/interaction/Modify';
import Snap from 'ol/interaction/Snap';
import Select from 'ol/interaction/Select';
import { Vector as VectorSource } from 'ol/source';
import { Style, Stroke, Fill, Circle } from 'ol/style';
import { LineString, Polygon, Point } from 'ol/geom';
import { Feature } from 'ol';
import Overlay from 'ol/Overlay';

export type DrawingTool = 'select' | 'pan' | 'point' | 'line' | 'polygon' | 'rectangle' | 'circle' | 'edit' | 'delete';

interface MeasurementScale {
  pixelsPerUnit: number;
  unit: 'feet' | 'inches' | 'meters';
  name: string;
}

interface DrawingToolsProps {
  map: Map;
  vectorSource: VectorSource;
  activeTool: DrawingTool;
  scale: MeasurementScale;
  onFeatureCreated: (feature: Feature, measurement: number) => void;
  onFeatureModified: (feature: Feature, measurement: number) => void;
  onFeatureDeleted: (featureId: string) => void;
}

const DRAWING_STYLE = new Style({
  fill: new Fill({ color: 'rgba(66, 165, 245, 0.2)' }),
  stroke: new Stroke({ color: '#2196F3', width: 2, lineDash: [10, 10] }),
  image: new Circle({
    radius: 6,
    fill: new Fill({ color: '#2196F3' }),
    stroke: new Stroke({ color: '#FFFFFF', width: 2 })
  })
});

export function useDrawingTools({
  map,
  vectorSource,
  activeTool,
  scale,
  onFeatureCreated,
  onFeatureModified,
  onFeatureDeleted
}: DrawingToolsProps) {
  const drawInteraction = useRef<Draw | null>(null);
  const modifyInteraction = useRef<Modify | null>(null);
  const selectInteraction = useRef<Select | null>(null);
  const snapInteraction = useRef<Snap | null>(null);
  const measureTooltip = useRef<Overlay | null>(null);
  const measureTooltipElement = useRef<HTMLDivElement | null>(null);

  const calculateMeasurement = useCallback((geometry: any): number => {
    if (geometry instanceof Point) return 1;

    if (geometry instanceof LineString) {
      const coordinates = geometry.getCoordinates();
      let totalLength = 0;
      for (let i = 1; i < coordinates.length; i++) {
        const dx = coordinates[i][0] - coordinates[i - 1][0];
        const dy = coordinates[i][1] - coordinates[i - 1][1];
        totalLength += Math.sqrt(dx * dx + dy * dy);
      }
      return totalLength / scale.pixelsPerUnit;
    }

    if (geometry instanceof Polygon) {
      const coordinates = geometry.getCoordinates()[0];
      let area = 0;
      for (let i = 0; i < coordinates.length - 1; i++) {
        area += coordinates[i][0] * coordinates[i + 1][1];
        area -= coordinates[i + 1][0] * coordinates[i][1];
      }
      area = Math.abs(area) / 2;
      return area / (scale.pixelsPerUnit * scale.pixelsPerUnit);
    }

    return 0;
  }, [scale]);

  const formatMeasurement = useCallback((value: number, geometryType: string): string => {
    if (geometryType === 'Point') return `Count: ${value}`;
    if (geometryType === 'LineString') {
      if (scale.unit === 'feet') {
        const feet = Math.floor(value);
        const inches = Math.round((value - feet) * 12);
        return `${feet}' ${inches}"`;
      }
      return `${value.toFixed(2)} ${scale.unit}`;
    }
    if (geometryType === 'Polygon') return `${value.toFixed(2)} sq ${scale.unit}`;
    return value.toString();
  }, [scale]);

  const clearInteractions = useCallback(() => {
    [drawInteraction, modifyInteraction, selectInteraction, snapInteraction].forEach(ref => {
      if (ref.current) {
        map.removeInteraction(ref.current);
        ref.current = null;
      }
    });
    if (measureTooltip.current) {
      map.removeOverlay(measureTooltip.current);
      measureTooltip.current = null;
    }
  }, [map]);

  const setupDrawInteraction = useCallback((geometryType: 'Point' | 'LineString' | 'Polygon' | 'Circle') => {
    // Create tooltip element
    measureTooltipElement.current = document.createElement('div');
    measureTooltipElement.current.className = 'measure-tooltip';
    measureTooltip.current = new Overlay({
      element: measureTooltipElement.current,
      offset: [0, -15],
      positioning: 'bottom-center',
    });
    map.addOverlay(measureTooltip.current);

    const drawOptions: any = {
      source: vectorSource,
      type: geometryType,
      style: DRAWING_STYLE
    };

    if (geometryType === 'Circle' && activeTool === 'rectangle') {
      drawOptions.geometryFunction = createBox();
    }

    const draw = new Draw(drawOptions);

    draw.on('drawstart', (event: DrawEvent) => {
      const geometry = event.feature.getGeometry()!;
      geometry.on('change', () => {
        const measurement = calculateMeasurement(geometry);
        if (measureTooltipElement.current) {
          measureTooltipElement.current.innerHTML = formatMeasurement(measurement, geometry.getType());
        }
      });
    });

    draw.on('drawend', (event: DrawEvent) => {
      const feature = event.feature;
      const geometry = feature.getGeometry()!;
      const measurement = calculateMeasurement(geometry);

      feature.setId(crypto.randomUUID());
      feature.set('measurement', measurement);
      feature.set('unit', scale.unit);

      onFeatureCreated(feature, measurement);
    });

    drawInteraction.current = draw;
    map.addInteraction(draw);

    snapInteraction.current = new Snap({ source: vectorSource });
    map.addInteraction(snapInteraction.current);
  }, [map, vectorSource, activeTool, scale, calculateMeasurement, formatMeasurement, onFeatureCreated]);

  useEffect(() => {
    clearInteractions();

    const mapElement = map.getTargetElement();
    if (mapElement) {
      const cursors: Record<DrawingTool, string> = {
        select: 'default', pan: 'grab', point: 'crosshair',
        line: 'crosshair', polygon: 'crosshair', rectangle: 'crosshair',
        circle: 'crosshair', edit: 'move', delete: 'not-allowed'
      };
      mapElement.style.cursor = cursors[activeTool];
    }

    switch (activeTool) {
      case 'point': setupDrawInteraction('Point'); break;
      case 'line': setupDrawInteraction('LineString'); break;
      case 'polygon': setupDrawInteraction('Polygon'); break;
      case 'rectangle': setupDrawInteraction('Circle'); break;
      case 'circle': setupDrawInteraction('Circle'); break;
    }

    return clearInteractions;
  }, [activeTool, clearInteractions, setupDrawInteraction]);
}
```

---

## Data Model and API Design

### Entity Relationship

```
Organization ─────────< User
     │
     └─────────────< Project (UserRequest)
                          │
                          ├─────< BlueprintFile (PDF)
                          │           │
                          │           └─────< UserSheet (Page)
                          │
                          ├─────< UserFeature (Takeoff Item Type)
                          │           │
                          │           └─────< UserOutput (Annotations)
                          │                       │
                          │                       └───< GeoJSON Features
                          │
                          └─────< SharedView (Public Links)
```

### Core TypeScript Types

```typescript
// types/models.ts

interface Project {
  id: string;
  name: string;
  organizationId: string;
  status: 1 | 2 | 3 | 4 | 5;  // draft, processing, review, completed, archived
  measurementSystem: 'imperial' | 'metric';
  createdAt: string;
  completedAt: string | null;
  shareableLink: string | null;
}

interface BlueprintFile {
  id: string;
  projectId: string;
  name: string;
  fileUrl: string;
  totalPages: number;
  workableSheets: number;
  completedSheets: number;
  createdAt: string;
}

interface UserSheet {
  id: string;
  projectId: string;
  blueprintFileId: string;
  name: string;               // "A1.03"
  pageNumber: number;
  sheetStatus: 1 | 2 | 3;     // pending, processing, completed
  thumbnailUrl: string;
  tileUrl: string;
  tileConfig: {
    maxZoom: number;
    tileSize: number;
    width: number;
    height: number;
  };
}

interface UserFeature {
  id: string;
  projectId: string;
  name: string;               // "WINDOW TYPE - B1_9'-8 3/8\" W X 9'-0\" HT"
  description: string;        // HTML
  geometryType: 1 | 2 | 3;    // Point, Line, Polygon
  color: string;
  defaultTags: Record<string, TagAssignment>;
}

interface UserOutput {
  outputId: string;
  featureId: string;
  sheetId: string;
  outputGeojson: OutputGeoJSON;
  isAiCreated: boolean;
  isHidden: boolean;
}

interface OutputGeoJSON {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
  properties: {
    count: number;
    editCount: number;
    totalMeasurement: number;
  };
}

interface GeoJSONFeature {
  id: string;
  type: 'Feature';
  geometry: {
    type: 'Point' | 'LineString' | 'Polygon';
    coordinates: number[] | number[][] | number[][][];
  };
  properties: {
    vectorLayerId: string;
    count?: number;
    measurement?: number;
    unit?: string;
    zoneId: string[];
    tagsInfo: Record<string, any>;
  };
}
```

---

## API Endpoints Reference

### Actual ibeam.ai API (Reverse-Engineered)

```
Base URL: https://feathers.ibeam.ai/api/

PROJECTS
────────
GET  /user-requests/{id}/                    → Project details
GET  /user-requests/{id}/info/               → Minimal info (shared views)
GET  /user-requests/{id}/blueprint_files/    → List PDFs
GET  /user-requests/{id}/tag_library/        → MasterFormat tags
GET  /user-requests/{id}/notes/              → User notes

SHEETS (PDF Pages)
──────────────────
GET  /user-sheets/?request_id={projectId}    → List all sheets
GET  /user-sheets/{id}/                      → Single sheet
GET  /user-sheets/{id}/status/               → Processing status
GET  /user-sheets/categories/                → Sheet categories

FEATURES (Takeoff Item Types)
─────────────────────────────
GET  /user-features/?request_id={id}         → All features
POST /user-features/worksheets/              → Features by worksheet

OUTPUTS (Annotations)
─────────────────────
GET  /user-outputs/?worksheet_id={id}&attach_geojson=true
POST /user-outputs/                          → Create annotation
PATCH /user-outputs/{id}/                    → Update annotation
DELETE /user-outputs/{id}/                   → Delete annotation

SHARED VIEWS
────────────
GET  /shared-view/user-requests/{sharedId}/info/
```

### Sample API Responses

**GET /user-outputs/?worksheet_id=...&attach_geojson=true**
```json
{
  "sheet_id": "f924bcf8-5003-43df-9903-add33ca1516a",
  "is_typical": false,
  "blueprint_file_id": "8e4ef859-9369-4f5f-aeff-1b4e34a79c1a",
  "image": "84a82c3c-ba94-40c2-9617-8ec3ca30c82f",
  "outputs": [
    {
      "output_id": "8ba882af-ed12-4bbc-a901-a1a57b62f93a",
      "auto_count_job_id": null,
      "auto_count_process_status": 1,
      "output_geojson": {
        "type": "FeatureCollection",
        "features": [
          {
            "id": "id-mjwyb0kq0.17tda683vyw",
            "type": "Feature",
            "geometry": {
              "type": "Point",
              "coordinates": [1136.89, -2175.79]
            },
            "properties": {
              "count": 1,
              "zone_id": [],
              "tags_info": {},
              "vector_layer_id": "886d2497-c4ee-46d5-93d1-389ca0fe251c"
            }
          }
        ],
        "properties": {
          "count": 3,
          "edit_count": 3,
          "total_measurement": 3
        }
      },
      "feature": {
        "id": "cee1d6ec-3ae2-4576-848d-49f9c3fa5969",
        "name": "SIGNAGE_INTERIOR STAIR EXIT SIGN",
        "geometry_type": 1,
        "default_tags": {}
      },
      "is_ai_created": false,
      "is_hidden": false
    }
  ]
}
```

---

## Complete Code Examples

### React Query Hooks

```typescript
// hooks/useApi.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';

const api = axios.create({ baseURL: 'https://feathers.ibeam.ai/api' });

export function useProject(projectId: string) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const { data } = await api.get(`/user-requests/${projectId}/`);
      return data;
    },
  });
}

export function useSheets(projectId: string) {
  return useQuery({
    queryKey: ['sheets', projectId],
    queryFn: async () => {
      const { data } = await api.get('/user-sheets/', { params: { request_id: projectId } });
      return data;
    },
  });
}

export function useSheetOutputs(sheetId: string) {
  return useQuery({
    queryKey: ['outputs', sheetId],
    queryFn: async () => {
      const { data } = await api.get('/user-outputs/', {
        params: { worksheet_id: sheetId, attach_geojson: true }
      });
      return data;
    },
    enabled: !!sheetId,
  });
}

export function useFeatures(projectId: string) {
  return useQuery({
    queryKey: ['features', projectId],
    queryFn: async () => {
      const { data } = await api.get('/user-features/', {
        params: { request_id: projectId, is_paginated: 0 }
      });
      return data.results;
    },
  });
}

export function useCreateOutput() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: { featureId: string; sheetId: string; outputGeojson: any }) => {
      const { data } = await api.post('/user-outputs/', request);
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['outputs', variables.sheetId] });
    },
  });
}
```

### OpenLayers Map Component

```typescript
// components/BlueprintViewer.tsx
import React, { useEffect, useRef } from 'react';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import XYZ from 'ol/source/XYZ';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import Projection from 'ol/proj/Projection';
import { createFeatureStyleFunction } from './featureStyles';

interface Props {
  tileUrl: string;
  pdfWidth: number;
  pdfHeight: number;
  features?: GeoJSON.FeatureCollection;
  onFeatureSelect?: (featureId: string | null) => void;
}

export function BlueprintViewer({ tileUrl, pdfWidth, pdfHeight, features, onFeatureSelect }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Map | null>(null);
  const vectorLayerRef = useRef<VectorLayer | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;

    // Custom projection for PDF coordinates
    const pdfProjection = new Projection({
      code: 'PDF',
      units: 'pixels',
      extent: [0, -pdfHeight, pdfWidth, 0],
    });

    // Tile layer (PDF)
    const tileLayer = new TileLayer({
      source: new XYZ({
        url: `${tileUrl}/{z}/{x}/{y}.png`,
        tileSize: 256,
        maxZoom: 6,
        projection: pdfProjection,
      }),
    });

    // Vector layer (annotations)
    const vectorSource = new VectorSource();
    const vectorLayer = new VectorLayer({
      source: vectorSource,
      style: createFeatureStyleFunction(),
    });
    vectorLayerRef.current = vectorLayer;

    // Create map
    const map = new Map({
      target: mapRef.current,
      layers: [tileLayer, vectorLayer],
      view: new View({
        projection: pdfProjection,
        center: [pdfWidth / 2, -pdfHeight / 2],
        zoom: 2,
        maxZoom: 6,
      }),
    });

    mapInstance.current = map;
    return () => map.setTarget(undefined);
  }, [tileUrl, pdfWidth, pdfHeight]);

  // Update features
  useEffect(() => {
    if (!vectorLayerRef.current || !features) return;
    const source = vectorLayerRef.current.getSource()!;
    source.clear();
    source.addFeatures(new GeoJSON().readFeatures(features));
  }, [features]);

  return <div ref={mapRef} style={{ width: '100%', height: '100%' }} />;
}
```

---

## UI Layout Reference

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Header (style-module_sharedViewHeader)                                       │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ Logo │ Project Name │                                    │ Show Notes   │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
├─────────────┬───────────────────────────────────────────────┬───────────────┤
│ Left Panel  │              Main Canvas                      │  Right Panel  │
│ (Features)  │         (OpenLayers Map)                      │   (Plans)     │
│             │                                               │               │
│ ┌─────────┐ │  ┌─────────────────────────────────────────┐ │ ┌───────────┐ │
│ │Takeoff  │ │  │                                         │ │ │Total: 51  │ │
│ │aggregate│ │  │      PDF rendered as tile layer         │ │ │sheets     │ │
│ └─────────┘ │  │                                         │ │ └───────────┘ │
│             │  │      GeoJSON features overlaid          │ │               │
│ Features:   │  │      (red diamonds = Point features)    │ │ ┌───────────┐ │
│ ┌─────────┐ │  │                                         │ │ │ A1.01     │ │
│ │WINDOW   │ │  │                                         │ │ │ A1.02     │ │
│ │TYPE-B1  │ │  │                                         │ │ │ A1.03 ◄── │ │
│ │ 1 ea    │ │  │                                         │ │ │ A1.04     │ │
│ └─────────┘ │  │                                         │ │ └───────────┘ │
│ ┌─────────┐ │  └─────────────────────────────────────────┘ │               │
│ │SIGNAGE  │ │                                               │               │
│ │10 ea    │ │  ┌─────────────────────────────────────────┐ │               │
│ └─────────┘ │  │ Ask BeamGPT (AI chat button)            │ │               │
│             │  └─────────────────────────────────────────┘ │               │
└─────────────┴───────────────────────────────────────────────┴───────────────┘
```

---

## Key Takeaways

1. **PDF as Map Tiles** - The key architectural decision. Much more performant than client-side PDF rendering.

2. **OpenLayers** - Battle-tested foundation for pan/zoom/overlay functionality.

3. **GeoJSON** - Standard format for all annotations/measurements.

4. **React Query** - Handles data fetching and caching elegantly.

5. **CSS Modules** - Keeps styles scoped and maintainable.

6. **Coordinates** - GeoJSON coordinates are in PDF pixel space (not geographic). Y-axis is inverted (negative values).

7. **Feature vs Output** - Features are "types" of things to count/measure. Outputs are actual instances with geometry.

---

## Files Generated During Analysis

These files were created in `/Users/hamza/stratos/` during the reverse-engineering session:

- `inspect-ibeam.mjs` - Initial inspection script
- `deep-inspect.mjs` - Comprehensive DOM/API analysis
- `inspect-openlayers.mjs` - OpenLayers-specific analysis
- `ibeam-screenshot.png` - Screenshot of the application
- `ibeam-analysis.json` - Full JSON dump of analysis results

---

*Generated from reverse-engineering session on January 7, 2026*
