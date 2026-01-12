# PDF Rendering & Real-Time Collaboration Deep Dive

A technical comparison of how ibeam.ai and Togal.AI handle PDF rendering and real-time collaboration.

---

## Part 1: PDF Rendering Architectures

### ibeam.ai: Tile-Based Rendering (OpenLayers)

#### How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SERVER SIDE                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. PDF Upload                                                               │
│     └──► beam-filestore/prod/blueprint_files/2026/1/1/Arch_xxx.pdf          │
│                                                                              │
│  2. Thumbnail Generation (PDFToImageConversionBatch)                         │
│     └──► autofx-outputs/PDFToImageConversionBatch/2025/12/{uuid}/4.jpeg     │
│                                                                              │
│  3. Tile Generation (PDFToTilesConversion)                                   │
│     └──► autofx-outputs/PDFToTilesConversion/{date}/{uuid}/{z}/{x}/{y}.png  │
│                                                                              │
│         z = zoom level (0-5 typically)                                       │
│         x = column index                                                     │
│         y = row index                                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT SIDE                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OpenLayers Map Component                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                      │    │
│  │   ┌─────────────────────────────────────────────────────────────┐   │    │
│  │   │  TileLayer (PDF Background)                                  │   │    │
│  │   │  - Loads tiles on demand based on viewport                   │   │    │
│  │   │  - Progressive loading (low-res first, then high-res)        │   │    │
│  │   │  - Cached in browser for fast re-render                      │   │    │
│  │   └─────────────────────────────────────────────────────────────┘   │    │
│  │                         ▲                                           │    │
│  │   ┌─────────────────────────────────────────────────────────────┐   │    │
│  │   │  VectorLayer (Annotations)                                   │   │    │
│  │   │  - GeoJSON FeatureCollections                                │   │    │
│  │   │  - Points, Lines, Polygons                                   │   │    │
│  │   │  - Styled per feature type                                   │   │    │
│  │   └─────────────────────────────────────────────────────────────┘   │    │
│  │                                                                      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Tile URL Structure

```
https://storage.googleapis.com/autofx-outputs/PDFToTilesConversion/
  └── {date}/              # e.g., 2025/12/31
      └── {sheet-uuid}/    # Unique ID per sheet
          └── {z}/         # Zoom level (0 = most zoomed out)
              └── {x}/     # Column
                  └── {y}.png  # Row
```

**Example:**
```
/PDFToTilesConversion/2025/12/31/f924bcf8-5003-43df-9903-add33ca1516a/3/2/1.png
```

#### OpenLayers Configuration (Inferred)

```javascript
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';

// PDF coordinate system (pixels, Y-inverted)
const extent = [0, -sheetHeight, sheetWidth, 0];

const map = new Map({
  target: 'map-container',
  layers: [
    // PDF Tile Layer
    new TileLayer({
      source: new XYZ({
        url: `https://storage.googleapis.com/autofx-outputs/PDFToTilesConversion/${date}/${sheetId}/{z}/{x}/{y}.png`,
        tileSize: 256,
        maxZoom: 5,
        minZoom: 0
      })
    }),
    // Annotations Vector Layer
    new VectorLayer({
      source: new VectorSource({
        features: new GeoJSON().readFeatures(annotationsGeoJSON)
      }),
      style: featureStyleFunction
    })
  ],
  view: new View({
    projection: 'EPSG:3857',  // or custom projection
    extent: extent,
    center: [sheetWidth / 2, -sheetHeight / 2],
    zoom: 2
  })
});
```

#### Coordinate System

```javascript
// ibeam uses PDF pixel coordinates with inverted Y
{
  "geometry": {
    "type": "Point",
    "coordinates": [
      3811.25,    // X: pixels from left edge
      -2244.31    // Y: negative (from top, going down)
    ]
  }
}

// Converting to real-world measurements:
const dpi = 636.36;        // Rendering DPI
const scale = 26.19529;    // 1" = 26.2' on this sheet

function pixelsToFeet(pixelDistance) {
  return (pixelDistance / dpi) * scale;
}
```

---

### Togal.AI: MuPDF WebAssembly (Direct Rendering)

#### How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLIENT SIDE ONLY                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. PDF Download                                                             │
│     └──► Full PDF file downloaded to browser                                 │
│                                                                              │
│  2. MuPDF WASM Initialization                                                │
│     └──► libmupdf.wasm loaded (~5MB)                                         │
│                                                                              │
│  3. Document Parsing                                                         │
│     └──► mupdf.Document.openDocument(pdfBuffer)                              │
│                                                                              │
│  4. Page Rendering                                                           │
│     ┌──────────────────────────────────────────────────────────────────┐    │
│     │  For each visible page:                                           │    │
│     │                                                                   │    │
│     │  page = doc.loadPage(pageNum)                                     │    │
│     │                                                                   │    │
│     │  // Render to pixmap (bitmap)                                     │    │
│     │  pixmap = page.toPixmap(transformMatrix, colorSpace)              │    │
│     │                                                                   │    │
│     │  // Draw to canvas                                                │    │
│     │  ctx.putImageData(pixmapToImageData(pixmap), 0, 0)                │    │
│     │                                                                   │    │
│     │  // Extract vectors (for snapping/measurements)                   │    │
│     │  page.runPageContents({                                           │    │
│     │    fillPath: (path, ...) => paths.push(path),                     │    │
│     │    strokePath: (path, ...) => paths.push(path),                   │    │
│     │    fillText: (text, ...) => texts.push(text)                      │    │
│     │  })                                                               │    │
│     └──────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  5. Annotation Overlay                                                       │
│     └──► Canvas or SVG layer on top of rendered PDF                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### MuPDF API (Exposed in Window)

```javascript
// Stream operations (reading PDF data)
window.$libmupdf_stm_close     // Close a stream
window.$libmupdf_stm_seek      // Seek to position in stream
window.$libmupdf_stm_read      // Read bytes from stream

// Content extraction
window.$libmupdf_path_walk     // Walk vector paths in PDF
window.$libmupdf_text_walk     // Walk text elements
window.$libmupdf_load_font_file // Load embedded fonts

// Rendering
window.$libmupdf_device        // MuPDF device for rendering
```

#### Vector Path Extraction (Key Advantage)

```javascript
// MuPDF can extract the actual vector paths from the PDF
// This is HUGE for construction drawings - you can snap to lines!

function extractVectorPaths(page) {
  const paths = [];

  page.runPageContents({
    // Called for filled shapes (walls, rooms, etc.)
    fillPath: (path, evenOdd, ctm, colorspace, color, alpha) => {
      paths.push({
        type: 'fill',
        path: pathToCoordinates(path),
        transform: ctm,
        color: colorToHex(colorspace, color),
        alpha
      });
    },

    // Called for stroked lines (dimension lines, symbols, etc.)
    strokePath: (path, stroke, ctm, colorspace, color, alpha) => {
      paths.push({
        type: 'stroke',
        path: pathToCoordinates(path),
        lineWidth: stroke.lineWidth,
        transform: ctm,
        color: colorToHex(colorspace, color)
      });
    },

    // Called for text (labels, dimensions, notes)
    fillText: (text, ctm, colorspace, color, alpha) => {
      paths.push({
        type: 'text',
        content: text.toString(),
        transform: ctm
      });
    }
  });

  return paths;
}
```

---

### Comparison: Tiles vs MuPDF

| Aspect | Tiles (ibeam) | MuPDF (Togal) |
|--------|---------------|---------------|
| **Initial Load** | Fast (progressive) | Slow (full PDF + WASM) |
| **Memory Usage** | Low (~50MB) | High (~200MB+) |
| **Zoom Quality** | May pixelate | Perfect at any zoom |
| **Vector Access** | ❌ None | ✅ Full access |
| **Text Selection** | ❌ Not possible | ✅ Native support |
| **Server Cost** | High (tile generation) | Low (just storage) |
| **Offline Support** | ❌ Needs tiles | ✅ Once loaded |
| **Large PDFs** | ✅ Handles well | ⚠️ Memory issues |

---

## Part 2: Annotation/Editing Layer

### ibeam.ai: GeoJSON + OpenLayers Vector Layer

#### Data Structure

```javascript
// Each "output" is a feature type with its annotations
{
  "output_id": "uuid",
  "feature": {
    "id": "a08d2569-eafb-4ec4-b1a1-84d67d4e1b87",
    "name": "STOREFRONT TYPE-M_3'-0\"W X 4'-0\"H",
    "geometry_type": 1,  // 1=Point, 2=Line, 3=Polygon
    "style": {
      "json_style": {
        "color": "#d2b55b",
        "width": 2,
        "opacity": 1,
        "pattern": 1
      }
    }
  },
  "output_geojson": {
    "type": "FeatureCollection",
    "properties": {
      "count": 3,
      "edit_count": 3,
      "total_measurement": 3
    },
    "features": [
      {
        "id": "id-mjwonuow0.mtl37tn1ejf",
        "type": "Feature",
        "geometry": {
          "type": "Point",
          "coordinates": [3811.25, -2244.31]
        },
        "properties": {
          "count": 1,
          "vector_layer_id": "746fab0b-2279-4853-8bbf-ea145a55ec2a",
          "tags_info": { ... }
        }
      }
    ]
  }
}
```

#### Drawing Implementation

```javascript
import Draw from 'ol/interaction/Draw';
import Modify from 'ol/interaction/Modify';
import Snap from 'ol/interaction/Snap';

class DrawingManager {
  constructor(map, vectorSource) {
    this.map = map;
    this.source = vectorSource;
    this.currentTool = null;
  }

  setTool(toolType) {
    // Remove previous interaction
    if (this.currentTool) {
      this.map.removeInteraction(this.currentTool);
    }

    switch (toolType) {
      case 'point':
        this.currentTool = new Draw({
          source: this.source,
          type: 'Point'
        });
        break;

      case 'line':
        this.currentTool = new Draw({
          source: this.source,
          type: 'LineString'
        });
        break;

      case 'polygon':
        this.currentTool = new Draw({
          source: this.source,
          type: 'Polygon'
        });
        break;

      case 'rectangle':
        this.currentTool = new Draw({
          source: this.source,
          type: 'Circle',
          geometryFunction: createBox()
        });
        break;
    }

    if (this.currentTool) {
      this.map.addInteraction(this.currentTool);

      // Add snap interaction
      const snap = new Snap({ source: this.source });
      this.map.addInteraction(snap);

      // Handle draw end
      this.currentTool.on('drawend', (event) => {
        this.onFeatureCreated(event.feature);
      });
    }
  }

  onFeatureCreated(feature) {
    // Generate unique ID
    const id = `id-${Date.now().toString(36)}.${Math.random().toString(36).substr(2)}`;
    feature.setId(id);

    // Calculate measurements
    const geometry = feature.getGeometry();
    const measurement = this.calculateMeasurement(geometry);

    // Save to API
    this.saveFeature(feature, measurement);
  }

  calculateMeasurement(geometry) {
    const type = geometry.getType();

    if (type === 'Point') {
      return { count: 1 };
    }

    if (type === 'LineString') {
      const coords = geometry.getCoordinates();
      let totalPixels = 0;
      for (let i = 1; i < coords.length; i++) {
        const dx = coords[i][0] - coords[i-1][0];
        const dy = coords[i][1] - coords[i-1][1];
        totalPixels += Math.sqrt(dx*dx + dy*dy);
      }
      const feet = (totalPixels / this.dpi) * this.scale;
      return { length: feet };
    }

    if (type === 'Polygon') {
      const area = geometry.getArea();  // In pixel²
      const sqFeet = (area / (this.dpi * this.dpi)) * (this.scale * this.scale);
      return { area: sqFeet };
    }
  }
}
```

---

### Togal.AI: Canvas/WebGL + Three.js

#### Annotation Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Togal Rendering Stack                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │  Three.js 3D Scene (for MEP visualization)                │  │
│   │  - Pipe/duct 3D models                                    │  │
│   │  - WebGL rendering                                        │  │
│   └──────────────────────────────────────────────────────────┘  │
│                           ▲                                      │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │  2D Annotation Canvas                                     │  │
│   │  - Drawing tools (point, line, polygon)                   │  │
│   │  - AI-generated annotations                               │  │
│   │  - User edits                                             │  │
│   └──────────────────────────────────────────────────────────┘  │
│                           ▲                                      │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │  MuPDF Rendered Canvas                                    │  │
│   │  - PDF page bitmap                                        │  │
│   │  - Vector paths (for snapping)                            │  │
│   └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### Vector Snapping (Togal Advantage)

```javascript
// Because Togal extracts vectors from PDF, it can snap to existing lines!

class VectorSnapManager {
  constructor(pdfPaths) {
    this.paths = pdfPaths;  // Extracted from MuPDF
    this.snapTolerance = 10; // pixels
  }

  findNearestSnapPoint(mouseX, mouseY) {
    let nearest = null;
    let minDist = this.snapTolerance;

    for (const path of this.paths) {
      if (path.type === 'stroke') {
        // Check endpoints
        for (const point of path.endpoints) {
          const dist = this.distance(mouseX, mouseY, point.x, point.y);
          if (dist < minDist) {
            minDist = dist;
            nearest = { type: 'endpoint', point };
          }
        }

        // Check point-on-line
        const onLine = this.nearestPointOnLine(mouseX, mouseY, path);
        if (onLine && onLine.dist < minDist) {
          minDist = onLine.dist;
          nearest = { type: 'on-line', point: onLine.point };
        }

        // Check intersections
        for (const other of this.paths) {
          if (other !== path) {
            const intersection = this.lineIntersection(path, other);
            if (intersection) {
              const dist = this.distance(mouseX, mouseY, intersection.x, intersection.y);
              if (dist < minDist) {
                minDist = dist;
                nearest = { type: 'intersection', point: intersection };
              }
            }
          }
        }
      }
    }

    return nearest;
  }
}
```

---

## Part 3: Real-Time Collaboration

### ibeam.ai: Firebase + Lock-Based

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   ibeam Real-Time Architecture                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User A                              User B                      │
│    │                                    │                        │
│    ▼                                    ▼                        │
│  ┌────────────────┐              ┌────────────────┐              │
│  │ React App      │              │ React App      │              │
│  │                │              │                │              │
│  │ editing_status │◄────────────►│ editing_status │              │
│  │ = true         │    Firebase  │ = false        │              │
│  │ editing_user   │    Realtime  │ (locked out)   │              │
│  │ = "User A"     │      DB      │                │              │
│  └────────────────┘              └────────────────┘              │
│         │                                                        │
│         ▼                                                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Firebase Realtime DB                     │ │
│  │                                                             │ │
│  │  /projects/{projectId}/                                     │ │
│  │    ├── editing_status: true                                 │ │
│  │    ├── editing_user: "user-uuid-a"                          │ │
│  │    ├── active_tab_id: "tab-uuid"                            │ │
│  │    └── last_updated: timestamp                              │ │
│  │                                                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### Lock Implementation

```javascript
// Firebase lock manager
import { getDatabase, ref, set, onValue, serverTimestamp } from 'firebase/database';

class EditLockManager {
  constructor(projectId, userId) {
    this.db = getDatabase();
    this.projectRef = ref(this.db, `projects/${projectId}`);
    this.userId = userId;
    this.hasLock = false;
  }

  async acquireLock() {
    const lockRef = ref(this.db, `projects/${this.projectId}/lock`);

    // Try to acquire lock atomically
    try {
      await set(lockRef, {
        editing_status: true,
        editing_user: this.userId,
        acquired_at: serverTimestamp(),
        heartbeat: serverTimestamp()
      });
      this.hasLock = true;
      this.startHeartbeat();
      return true;
    } catch (error) {
      return false;
    }
  }

  startHeartbeat() {
    // Keep lock alive with heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(async () => {
      if (this.hasLock) {
        await set(ref(this.db, `projects/${this.projectId}/lock/heartbeat`), serverTimestamp());
      }
    }, 30000);
  }

  releaseLock() {
    if (this.hasLock) {
      set(ref(this.db, `projects/${this.projectId}/lock`), {
        editing_status: false,
        editing_user: null
      });
      this.hasLock = false;
      clearInterval(this.heartbeatInterval);
    }
  }

  onLockChange(callback) {
    // Listen for lock changes
    onValue(ref(this.db, `projects/${this.projectId}/lock`), (snapshot) => {
      const lock = snapshot.val();
      callback({
        isLocked: lock?.editing_status || false,
        lockedBy: lock?.editing_user,
        isMine: lock?.editing_user === this.userId
      });
    });
  }
}
```

#### Data Sync (Not Real-Time Edits)

```javascript
// ibeam syncs data on save, not real-time
class DataSyncManager {
  constructor(projectId) {
    this.projectId = projectId;
    this.pendingChanges = [];
  }

  // Queue local changes
  addChange(change) {
    this.pendingChanges.push({
      ...change,
      timestamp: Date.now()
    });
  }

  // Sync to server on save
  async save() {
    const response = await fetch(`/api/user-outputs/`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: this.projectId,
        changes: this.pendingChanges
      })
    });

    if (response.ok) {
      this.pendingChanges = [];
    }
  }
}
```

---

### Togal.AI: WebSocket Real-Time

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                  Togal Real-Time Architecture                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User A                              User B                      │
│    │                                    │                        │
│    ▼                                    ▼                        │
│  ┌────────────────┐              ┌────────────────┐              │
│  │ React App      │              │ React App      │              │
│  │                │              │                │              │
│  │ WebSocket      │◄────────────►│ WebSocket      │              │
│  │ Client         │              │ Client         │              │
│  └────────────────┘              └────────────────┘              │
│         │                               │                        │
│         └───────────────┬───────────────┘                        │
│                         ▼                                        │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    WebSocket Server                         │ │
│  │                                                             │ │
│  │  Rooms:                                                     │ │
│  │    project:{projectId} - All users on same project          │ │
│  │    sheet:{sheetId} - Users on same sheet                    │ │
│  │                                                             │ │
│  │  Events:                                                    │ │
│  │    feature:create - New annotation created                  │ │
│  │    feature:update - Annotation modified                     │ │
│  │    feature:delete - Annotation removed                      │ │
│  │    cursor:move - User cursor position                       │ │
│  │    presence:join/leave - User entered/left                  │ │
│  │                                                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### Real-Time Sync Implementation

```javascript
// WebSocket client for real-time collaboration
class RealtimeSync {
  constructor(projectId, userId) {
    this.projectId = projectId;
    this.userId = userId;
    this.ws = null;
    this.handlers = new Map();
  }

  connect() {
    this.ws = new WebSocket(`wss://api.togal.ai/ws/project/${this.projectId}`);

    this.ws.onopen = () => {
      // Join project room
      this.send('join', { projectId: this.projectId, userId: this.userId });
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };
  }

  send(type, payload) {
    this.ws.send(JSON.stringify({ type, payload, userId: this.userId }));
  }

  handleMessage(message) {
    switch (message.type) {
      case 'feature:create':
        // Another user created a feature
        this.handlers.get('featureCreated')?.(message.payload);
        break;

      case 'feature:update':
        // Another user modified a feature
        this.handlers.get('featureUpdated')?.(message.payload);
        break;

      case 'feature:delete':
        this.handlers.get('featureDeleted')?.(message.payload);
        break;

      case 'cursor:move':
        // Show other user's cursor
        this.handlers.get('cursorMoved')?.(message.payload);
        break;

      case 'presence:update':
        // User list changed
        this.handlers.get('presenceChanged')?.(message.payload);
        break;
    }
  }

  // Broadcast local changes
  createFeature(feature) {
    this.send('feature:create', feature);
  }

  updateFeature(featureId, changes) {
    this.send('feature:update', { featureId, changes });
  }

  deleteFeature(featureId) {
    this.send('feature:delete', { featureId });
  }

  moveCursor(x, y) {
    // Throttled cursor updates
    this.send('cursor:move', { x, y });
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }
}
```

#### Conflict Resolution

```javascript
// Operational Transformation (OT) or CRDT for conflict resolution
class ConflictResolver {
  constructor() {
    this.version = 0;
    this.pendingOps = [];
  }

  // Transform incoming operation against pending local ops
  transform(remoteOp) {
    let transformed = remoteOp;

    for (const localOp of this.pendingOps) {
      transformed = this.transformPair(localOp, transformed);
    }

    return transformed;
  }

  transformPair(op1, op2) {
    // If both operations affect same feature
    if (op1.featureId === op2.featureId) {
      // Last-write-wins for properties
      if (op1.type === 'update' && op2.type === 'update') {
        // Merge non-conflicting properties
        return {
          ...op2,
          changes: { ...op2.changes, ...op1.changes }
        };
      }

      // Delete wins over update
      if (op1.type === 'delete' || op2.type === 'delete') {
        return { type: 'delete', featureId: op1.featureId };
      }
    }

    return op2;
  }
}
```

---

## Part 4: Comparison Summary

| Feature | ibeam.ai | Togal.AI |
|---------|----------|----------|
| **PDF Rendering** | Server-side tiles | Client-side MuPDF WASM |
| **Vector Access** | ❌ No | ✅ Yes (snap to PDF lines) |
| **Annotation Storage** | GeoJSON | Likely similar |
| **Real-Time Model** | Lock-based (one editor) | Multi-user (WebSocket) |
| **Conflict Resolution** | Not needed (locks) | OT/CRDT required |
| **Offline Support** | Limited | Better (local PDF) |
| **3D Support** | ❌ No | ✅ Yes (Three.js) |
| **Server Load** | Higher (tile gen) | Lower |
| **Client Load** | Lower | Higher (WASM) |

---

## Implementation Recommendations

### For Tile-Based (like ibeam)
- Use **pdf-lib** or **pdf.js** server-side for tile generation
- Consider **Sharp** for high-performance image processing
- Cache tiles in CDN (GCS/S3 + CloudFront)
- Use **OpenLayers** or **Leaflet** for map display

### For MuPDF-Based (like Togal)
- Use **mupdf.js** WASM build
- Consider **OffscreenCanvas** for background rendering
- Implement progressive loading (render visible pages first)
- Cache rendered pages in IndexedDB

### For Real-Time
- **Simple (Lock-based)**: Firebase Realtime DB or Supabase Realtime
- **Complex (Multi-user)**: Custom WebSocket server + Redis pub/sub
- Consider **Yjs** or **Automerge** for CRDT-based collaboration

---

*Generated from reverse-engineering analysis*
*Analysis date: January 2026*
