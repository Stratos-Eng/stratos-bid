# ibeam.ai Deep Technical Reference

This document covers the deep technical investigation of ibeam.ai's implementation details for scale/measurement, export, real-time collaboration, and drawing tools.

---

## 1. Scale & Measurement System

### The Formula (Verified ✓)

```javascript
real_feet = (pixel_distance / dpi) × scale
```

**Example verification:**
```javascript
// Curtain Wall LineString coordinates
const coords = [[5679.50, -2805.55], [5679.50, -2659.73]];

// Pixel distance (vertical line)
const pixelDistance = 145.83; // pixels

// Sheet parameters
const dpi = 636.36;        // PDF rendering DPI
const scale = 26.19529;    // 1 inch = 26.2 feet on this sheet

// Calculation
const feetDistance = (pixelDistance / dpi) * scale;
// Result: 6.003 feet ✓ (matches API response)
```

### Scale Data Structure

Each sheet stores its own scale:

```json
{
  "name": "A2.1",
  "scale": 26.19529,     // 1 inch = 26.2 feet
  "dpi": 636.36,         // Consistent across sheets
  "width": 8640,         // Tile dimensions
  "height": 5616
}
```

**Scale values observed:**
| Sheet | Scale | Meaning |
|-------|-------|---------|
| A2.1 | 26.19529 | 1" = 26.2' (1/4" = 1'-0" architectural) |
| A3.0, A3.1 | 17.48923 | 1" = 17.5' (approx 3/16" = 1'-0") |
| A5.0 | 4.0 | 1" = 4' (3" = 1'-0" detail) |
| A5.2 | 13.08072 | 1" = 13' (approx 1/8" = 1'-0") |

### Coordinate System

- **Origin**: Top-left of PDF
- **Y-axis**: Negative (goes down)
- **Units**: PDF pixels (pre-scaled to tile DPI)
- **Storage**: GeoJSON coordinates in pixel space

```json
{
  "geometry": {
    "type": "Point",
    "coordinates": [3811.25, -2244.31]
  }
}
```

### Measurement Properties by Geometry Type

**Point (Count):**
```json
{
  "properties": {
    "count": 1,
    "total_measurement": 3  // Sum of all points in feature
  }
}
```

**LineString (Linear):**
```json
{
  "properties": {
    "length": 6.003,           // Individual line segment (feet)
    "total_measurement": 11.979 // Sum of all segments
  }
}
```

**Polygon (Area):**
```json
{
  "properties": {
    "area": 125.5,             // Square feet
    "perimeter": 45.2,         // Linear feet
    "total_measurement": 125.5
  }
}
```

### Scale Calibration

The `scale` value is determined by:
1. **Manual calibration**: User draws a known distance
2. **Auto-detection**: OCR reads scale bar from drawing
3. **Inference**: From PDF metadata or common architectural scales

---

## 2. Export Generation

### Client-Side Libraries

```javascript
// Detected in bundles:
hasFileSaver: true,    // FileSaver.js for downloads
hasXLSX: false,        // Not client-side Excel
hasPDFMake: false,     // Not client-side PDF
hasJsPDF: false,       // Not client-side PDF
```

### Export Architecture

**Client-Side:**
- `FileSaver.js` - Triggers download of server-generated files
- `html2canvas` - Screenshot capture for reports

**Server-Side (Inferred):**
- Excel generation happens on backend (faster, richer formatting)
- PDF reports rendered server-side
- Export endpoints: `/api/user-requests/{id}/export/`

### AG Grid Export

```javascript
// vendor-ag-grid includes:
- Export to CSV
- Export to Excel (client-side basic)
- Copy to clipboard
- Undo/redo for grid operations
```

### Export Data Structure

Based on the API, exports likely include:
```
├── Summary Sheet
│   ├── Project name
│   ├── Total counts by feature type
│   └── Cost estimates (if pricing enabled)
├── Detail Sheets (per floor/area)
│   ├── Feature name
│   ├── Count/Length/Area
│   ├── Unit price
│   └── Extended price
└── Takeoff Sheet (all items)
```

---

## 3. Real-Time Collaboration

### Technology Stack

```javascript
// Firebase Realtime Database
vendors.firebase+database@1.0.8.b95a593e.chunk.js (132KB)

// Patterns found:
- Firebase Auth
- Firebase Realtime DB
- WebSocket transport
```

### Collaboration Model

**Edit Locking (Optimistic):**
```json
{
  "editing_status": true,
  "editing_user": "user-uuid",
  "active_tab_id": "tab-uuid"
}
```

- Only one user can edit a project at a time
- Lock is at project level, not sheet level
- `editing_status: false` = available for editing

### Presence Indicators

Based on the data model:
- No real-time cursor sharing
- No live co-editing
- Single-user-at-a-time model
- Changes sync on save, not real-time

### Firebase Usage

```javascript
// Likely uses:
firebase.database().ref(`/projects/${projectId}/lock`).on('value', ...)
firebase.database().ref(`/projects/${projectId}/status`).set(...)
```

### Access Control

```json
{
  "request_access": [
    {
      "id": "user-uuid",
      "email": "user@company.com",
      "access_type": 1  // 1=owner, 2=editor, 3=viewer
    }
  ]
}
```

---

## 4. Drawing Tool Interactions

### OpenLayers Interactions

From `vendor-ol.32b0d348.chunk.js`:

```javascript
// Available interactions:
ol.interaction.Draw        // Create new geometries
ol.interaction.Modify      // Edit existing geometries
ol.interaction.Select      // Select features
ol.interaction.Snap        // Snap to existing features
ol.interaction.Translate   // Move features
ol.interaction.Scale       // Resize features
ol.interaction.Rotate      // Rotate features
```

### Drawing Implementation

From `5336.9952d52e.chunk.js` (main app chunk):

```javascript
// All patterns found:
✓ drawInteraction
✓ modifyInteraction
✓ selectInteraction
✓ snapInteraction
✓ undoRedo
✓ calibration
```

### Snap Behavior

```javascript
// Snap to:
- Existing feature vertices
- Existing feature edges
- Grid (if enabled)
- Endpoint to endpoint

// From turf-jsts bundle:
- Point-on-line calculations
- Intersection detection
- Distance calculations
```

### Undo/Redo System

```javascript
// From vendor-quill (Quill editor):
- Rich text undo/redo for notes

// From AG Grid:
- Table operation undo/redo

// Custom implementation (inferred):
- Feature state stack
- Action-based (add, modify, delete)
- Per-feature-type grouping
```

### Geometry Operations (Turf.js + JSTS)

```javascript
// vendors.turf-jsts1.2.3 provides:
- Area calculations
- Length calculations
- Buffer operations
- Union/intersection
- Point-in-polygon
- Nearest point on line
- Simplification
```

### Drawing Tool States

```javascript
// Inferred from UI patterns:
const TOOL_MODES = {
  SELECT: 'select',      // Default, click to select
  PAN: 'pan',            // Hand tool, drag to pan
  POINT: 'point',        // Click to add point
  LINE: 'line',          // Click-click to draw line
  POLYGON: 'polygon',    // Click-click-dblclick for polygon
  RECTANGLE: 'rectangle', // Click-drag for rectangle
  CIRCLE: 'circle',      // Click-drag for circle
  MEASURE: 'measure'     // Click-click to measure distance
};
```

### Feature ID Generation

```javascript
// Observed pattern:
"id": "id-mjwonuow0.mtl37tn1ejf"
//     ^prefix   ^timestamp.random

// Likely implementation:
const generateId = () => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substr(2, 11);
  return `id-${timestamp}.${random}`;
};
```

---

## Key Libraries Summary

| Library | Version | Purpose |
|---------|---------|---------|
| OpenLayers | 7.x | Map/PDF rendering, drawing |
| Turf.js | 6.5 | Geometry calculations |
| JSTS | 1.2.3 | Advanced spatial operations |
| AG Grid | - | Data tables, export |
| Firebase | 1.0.8 | Real-time sync, auth |
| FileSaver | - | File downloads |
| html2canvas | 1.4.1 | Screenshot capture |
| Quill | - | Rich text notes |
| Pyodide | - | Python in browser (!) |

### Pyodide Finding

Interesting discovery: `pyodide.asm.js` (1.1MB) is loaded, suggesting they run Python calculations in the browser. This could be for:
- Complex geometry operations
- Legacy algorithm compatibility
- AI model inference
- Custom scripting

---

## Implementation Recommendations

### For Scale System

```javascript
class ScaleManager {
  constructor(sheet) {
    this.dpi = sheet.dpi || 636.36;
    this.scale = sheet.scale || 1;
  }

  pixelsToFeet(pixels) {
    return (pixels / this.dpi) * this.scale;
  }

  feetToPixels(feet) {
    return (feet / this.scale) * this.dpi;
  }

  measureLine(coords) {
    let totalPixels = 0;
    for (let i = 1; i < coords.length; i++) {
      const dx = coords[i][0] - coords[i-1][0];
      const dy = coords[i][1] - coords[i-1][1];
      totalPixels += Math.sqrt(dx*dx + dy*dy);
    }
    return this.pixelsToFeet(totalPixels);
  }
}
```

### For Drawing Tools

```javascript
// Use OpenLayers interactions
import Draw from 'ol/interaction/Draw';
import Modify from 'ol/interaction/Modify';
import Snap from 'ol/interaction/Snap';

const drawInteraction = new Draw({
  source: vectorSource,
  type: 'Point', // or 'LineString', 'Polygon'
  style: drawingStyle
});

const snapInteraction = new Snap({
  source: vectorSource,
  pixelTolerance: 10
});

map.addInteraction(drawInteraction);
map.addInteraction(snapInteraction);
```

### For Undo/Redo

```javascript
class UndoManager {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
  }

  execute(action) {
    action.do();
    this.undoStack.push(action);
    this.redoStack = [];
  }

  undo() {
    const action = this.undoStack.pop();
    if (action) {
      action.undo();
      this.redoStack.push(action);
    }
  }

  redo() {
    const action = this.redoStack.pop();
    if (action) {
      action.do();
      this.undoStack.push(action);
    }
  }
}
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ OpenLayers   │    │ React State  │    │ AG Grid      │      │
│  │ - Tile Layer │◄──►│ - Features   │◄──►│ - Takeoff    │      │
│  │ - Vector     │    │ - Selection  │    │   Table      │      │
│  │ - Draw/Edit  │    │ - Tool Mode  │    │ - Export     │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                   │                │
│         └───────────────────┼───────────────────┘                │
│                             │                                    │
│                    ┌────────▼────────┐                          │
│                    │ React Query     │                          │
│                    │ - Cache         │                          │
│                    │ - Sync          │                          │
│                    └────────┬────────┘                          │
│                             │                                    │
└─────────────────────────────┼────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │ Feathers API      │
                    │ /user-outputs/    │
                    │ /user-sheets/     │
                    │ /user-features/   │
                    └─────────┬─────────┘
                              │
┌─────────────────────────────┼────────────────────────────────────┐
│                     Backend │                                    │
├─────────────────────────────┼────────────────────────────────────┤
│                             │                                    │
│  ┌──────────────┐  ┌───────▼───────┐  ┌──────────────┐         │
│  │ GCS          │  │ PostgreSQL    │  │ Firebase     │         │
│  │ - PDF Tiles  │  │ - Projects    │  │ - Edit Lock  │         │
│  │ - Originals  │  │ - Features    │  │ - Presence   │         │
│  │ - Exports    │  │ - GeoJSON     │  │              │         │
│  └──────────────┘  └───────────────┘  └──────────────┘         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

*Generated from reverse-engineering analysis of app.ibeam.ai*
*Analysis date: January 2026*
