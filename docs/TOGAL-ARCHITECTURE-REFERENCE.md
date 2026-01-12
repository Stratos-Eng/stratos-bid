# Togal.AI Architecture Reference

Reverse-engineered analysis of Togal.AI's construction takeoff platform.

---

## Executive Summary

| Aspect | Togal.AI | ibeam.ai |
|--------|----------|----------|
| **PDF Rendering** | MuPDF (WebAssembly) | OpenLayers Tiles |
| **3D Support** | Yes (Three.js) | No |
| **State Management** | Redux + MobX + React Query | React Query |
| **Real-time** | WebSocket | Firebase |
| **Bundle Size** | 3.6MB (single bundle) | ~2MB (chunked) |
| **Business Model** | SaaS (subscription) | Service + Credits |

---

## 1. Tech Stack

### Frontend Framework

```
React 18 + React Router 6
├── Styled Components (CSS-in-JS)
├── Redux (global state)
├── MobX (reactive state)
└── React Query / TanStack Query (server state)
```

**Evidence:**
- `__reactRouterVersion: "6"` in window
- Styled-components class hashes (`dzaobX`, `cdvhuQ`)
- Redux + MobX + ReactQuery patterns in bundle

### PDF Rendering: MuPDF WebAssembly

Unlike ibeam.ai (which uses tile-based OpenLayers), Togal uses **MuPDF compiled to WebAssembly** for direct PDF rendering.

**MuPDF Functions Exposed:**
```javascript
window.$libmupdf_stm_close    // Close stream
window.$libmupdf_stm_seek     // Seek in stream
window.$libmupdf_stm_read     // Read from stream
window.$libmupdf_load_font_file  // Load fonts
window.$libmupdf_path_walk    // Walk PDF paths (for vectors)
window.$libmupdf_text_walk    // Walk text elements
window.$libmupdf_device       // MuPDF device context
```

**Implications:**
- Full PDF fidelity (vector graphics, fonts, all content)
- Higher memory usage but better quality
- No server-side tile generation needed
- Can extract vector paths directly from PDF

### 3D Visualization: Three.js

**Version:** 134

**3D Models for MEP (Plumbing/HVAC):**
```
/3d_models/3_Way_Joint.obj
/3d_models/4_Way_Joint.obj
/3d_models/Coupling.obj
/3d_models/Cross_Joint.obj
/3d_models/Elbow_Joint_45deg.obj
/3d_models/Elbow_Joint_90deg.obj
/3d_models/Tee_Joint_90deg.obj
/3d_models/Wye_Joint_45deg.obj
/3d_models/Wye_Joint_90deg.obj
```

This suggests Togal has **3D piping/ductwork visualization** - a feature ibeam.ai doesn't have.

### UI Framework

- **Styled Components** (CSS-in-JS with hash classes)
- **Theme Support:** `lightTheme`, `darkTheme` objects in window
- No Ant Design or Material UI detected

### Analytics & Monitoring

- **Sentry** - Error tracking
- **Segment** - Analytics
- **Appcues** - User onboarding
- **HubSpot** - Chat/CRM
- **rrweb** - Session recording

---

## 2. Architecture Comparison

### PDF Rendering Approaches

**Togal (MuPDF WebAssembly):**
```
PDF File → Browser Downloads Full PDF → MuPDF WASM renders to Canvas
                                            ↓
                                    Vector paths extracted
                                            ↓
                                    Annotations overlay on canvas
```

**ibeam (OpenLayers Tiles):**
```
PDF File → Server generates tiles at multiple zoom levels → GCS Storage
                                                               ↓
                                            OpenLayers loads tiles on demand
                                                               ↓
                                            Vector layer for annotations (GeoJSON)
```

**Trade-offs:**

| Aspect | MuPDF (Togal) | Tiles (ibeam) |
|--------|---------------|---------------|
| Initial load | Slower (full PDF) | Faster (progressive) |
| Memory | Higher | Lower |
| Quality | Perfect fidelity | Good (rasterized) |
| Vector extraction | Native | Not possible |
| Server cost | Lower | Higher (tile generation) |
| Offline support | Easier | Harder |

### Bundle Strategy

**Togal:** Single large bundle
```
index.41cbd85d.js (3.6MB) - Contains everything
```

**ibeam:** Code-split chunks
```
vendor-ol.chunk.js (358KB)
vendor-ag-grid.chunk.js (1MB)
5336.chunk.js (1.7MB) - Main app
... many smaller chunks
```

---

## 3. AI Features

### "The Togal Button"

One-click AI takeoff that "automatically handles all the tedious clicking and counting."

**Likely Implementation:**
1. User activates AI on a sheet
2. Image sent to server (or processed with client-side ML)
3. AI detects symbols, counts, measurements
4. Results returned as annotations

### AI Search Modalities

```
┌─────────────────────────────────────────────────────┐
│                   AI Search                          │
├─────────────────┬─────────────────┬─────────────────┤
│  Image Search   │  Text Search    │  Pattern Search │
│  (Find similar  │  (OCR-based     │  (Detect        │
│   symbols)      │   search)       │   recurring)    │
└─────────────────┴─────────────────┴─────────────────┘
```

**Workflow:**
1. User draws bounding box around object
2. AI searches entire plan set for similar items
3. Results displayed with confidence scores

### Togal.CHAT

Natural language interface to interact with plans:
- "How many doors are on floor 2?"
- "Verify my electrical outlet count"
- "Generate RFP documentation"

---

## 4. Data Model (Inferred)

### Auth Context Structure

```typescript
interface AuthContext {
  // User
  user: User;
  isAuthenticated: boolean;
  sessionId: string;

  // Organization
  selectedOrg: Organization;
  selectedOrgId: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  permissions: Permission[];

  // Subscription
  subscriptionState: 'active' | 'trial' | 'expired';
  subscriptionDetails: SubscriptionDetails;
  isOnEssentialsPlan: boolean;

  // Usage
  userUsage: UsageMetrics;

  // Invites
  pendingInvites: Invite[];

  // Actions
  setUser: (user: User) => void;
  signOut: () => void;
  // ... more actions
}
```

### Likely Project Structure

```typescript
interface Project {
  id: string;
  name: string;
  organizationId: string;
  createdAt: Date;
  status: 'active' | 'archived';

  // Documents
  documents: Document[];

  // Takeoff data
  sheets: Sheet[];
  measurements: Measurement[];

  // Collaboration
  collaborators: User[];
  lastEditedBy: string;
}

interface Sheet {
  id: string;
  documentId: string;
  pageNumber: number;
  name: string;
  scale: number;

  // MuPDF specific
  pdfPageRef: any;  // MuPDF page reference
}

interface Measurement {
  id: string;
  sheetId: string;
  type: 'count' | 'linear' | 'area';
  geometry: GeoJSON.Geometry;
  value: number;
  unit: string;

  // AI metadata
  isAIGenerated: boolean;
  confidence?: number;
  sourceSearch?: string;
}
```

---

## 5. Key Features

### Drawing Tools

From bundle analysis:
- **Polygon** drawing
- **Polyline** drawing
- **Measurement** tools
- **Area** calculation
- **Length** calculation

### Export

- **XLSX** (SheetJS) for Excel export
- Likely additional formats (PDF reports, CSV)

### Real-time Collaboration

- **WebSocket** for real-time sync
- "Cloud-based collaboration allows multiple team members to work on the same takeoff, at the same time"

### Integrations

- Auto-naming tool for document management
- Export to external estimation software
- HubSpot CRM integration

---

## 6. API Structure

### Known Endpoints

```
/api/v1/external/hubspot_token  # HubSpot integration

# Inferred endpoints:
/api/v1/projects
/api/v1/projects/:id/documents
/api/v1/projects/:id/sheets
/api/v1/projects/:id/measurements
/api/v1/ai/search
/api/v1/ai/takeoff
/api/v1/export/xlsx
```

### Authentication Routes

```
/auth/login
/auth/logout
/auth/forgot-password
/auth/reset-password
/auth/verify-email
/invite
/register
/accept_invite/*
```

---

## 7. Business Model

### Subscription Tiers

From auth context:
- **Essentials Plan** (`isOnEssentialsPlan`)
- Likely Pro/Enterprise tiers

### Pricing Model

- Subscription-based (not credit-based like ibeam)
- Organization-level billing
- User-based seats

---

## 8. Comparison: Togal vs ibeam

| Feature | Togal.AI | ibeam.ai |
|---------|----------|----------|
| **PDF Rendering** | MuPDF WASM (client) | Tile-based (server) |
| **3D Visualization** | Yes (Three.js) | No |
| **AI Approach** | Client-triggered search | Server-side ATS |
| **Collaboration** | Real-time (WebSocket) | Lock-based (Firebase) |
| **Business Model** | SaaS subscription | Service + credits |
| **Target User** | Self-service estimators | Managed service |
| **Bundle Size** | 3.6MB (single) | ~5MB (chunked) |
| **UI Framework** | Styled Components | CSS Modules + MUI |

---

## 9. Technical Advantages

### Togal Advantages
1. **Vector Extraction** - Can pull paths directly from PDF
2. **3D Visualization** - MEP modeling with Three.js
3. **Client-side AI** - Faster iterations, lower server cost
4. **Real-time Collab** - True multi-user editing
5. **Self-service** - User does the work (vs managed service)

### ibeam Advantages
1. **Progressive Loading** - Faster initial render for large PDFs
2. **Lower Memory** - Tile-based uses less RAM
3. **Human QA** - Professional review of all takeoffs
4. **Proven Stack** - OpenLayers is battle-tested for maps
5. **Chunked Bundles** - Better caching, smaller updates

---

## 10. Implementation Insights

### For MuPDF Integration

```javascript
// MuPDF.js initialization (conceptual)
import mupdf from 'mupdf-wasm';

async function loadPDF(arrayBuffer) {
  const doc = mupdf.Document.openDocument(arrayBuffer, 'application/pdf');
  const page = doc.loadPage(0);

  // Render to canvas
  const pixmap = page.toPixmap(
    mupdf.Matrix.scale(2, 2), // 2x scale for HiDPI
    mupdf.ColorSpace.DeviceRGB
  );

  // Extract vectors for measurements
  const paths = [];
  page.runPageContents({
    fillPath: (path, evenOdd, ctm, colorspace, color, alpha) => {
      paths.push({ type: 'fill', path, ctm });
    },
    strokePath: (path, stroke, ctm, colorspace, color, alpha) => {
      paths.push({ type: 'stroke', path, ctm });
    }
  });

  return { pixmap, paths };
}
```

### For 3D Piping Visualization

```javascript
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader';

const loader = new OBJLoader();

async function loadPipeFitting(type) {
  const modelPath = `/3d_models/${type}.obj`;
  const obj = await loader.loadAsync(modelPath);
  return obj;
}

// Build 3D pipe network from 2D takeoff
function buildPipeNetwork(measurements) {
  const scene = new THREE.Scene();

  measurements.forEach(m => {
    if (m.type === 'pipe') {
      // Create pipe segment
      const geometry = new THREE.CylinderGeometry(m.diameter/2, m.diameter/2, m.length);
      const mesh = new THREE.Mesh(geometry, pipeMaterial);
      mesh.position.set(m.x, m.y, m.z);
      scene.add(mesh);
    }

    if (m.type === 'fitting') {
      // Load fitting model
      const fitting = await loadPipeFitting(m.fittingType);
      fitting.position.set(m.x, m.y, m.z);
      scene.add(fitting);
    }
  });

  return scene;
}
```

---

## Sources

- Direct analysis of https://www-prod.togal.ai/
- JS bundle pattern analysis
- [Togal.AI - How it Works](https://www.togal.ai/how-it-works)
- [Togal.AI vs ibeam Comparison](https://www.ibeam.ai/blog/togal-vs-beamai-comparison)

*Analysis date: January 2026*
