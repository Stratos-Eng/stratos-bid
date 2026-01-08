# ibeam.ai Operational Flow Analysis

> **Context**: Deep analysis of how ibeam.ai actually operates - what's automated, what's AI, and what requires human intervention. Based on reverse-engineering their API responses and data structures.
>
> **Date**: January 7, 2026

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [The Complete Pipeline](#the-complete-pipeline)
3. [AI vs Human Responsibilities](#ai-vs-human-responsibilities)
4. [Data Evidence](#data-evidence)
5. [Key Metrics Observed](#key-metrics-observed)
6. [Business Model Insights](#business-model-insights)
7. [Technical Implementation Details](#technical-implementation-details)

---

## Executive Summary

### The Core Business Model

ibeam.ai operates as a **hybrid AI + Human QA** takeoff service:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      ibeam.ai BUSINESS MODEL                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   User uploads PDFs → AI processes → Human QA reviews → Delivered to user   │
│                                                                              │
│   KEY INSIGHT: They are NOT a pure SaaS tool.                               │
│   They are a SERVICE that uses AI + humans to deliver takeoffs.             │
│                                                                              │
│   Evidence:                                                                  │
│   • "Delivered in 1hrs" - processing_time_remaining                         │
│   • "ace_review_step" - internal QA workflow                                │
│   • "account_executive", "sales_engineer" fields                            │
│   • Users at @attentive.ai domain (their parent company)                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### What This Means

They're not selling software - they're selling a **done-for-you takeoff service** that happens to have a nice viewer interface. The AI does 80% of the work, humans QA the remaining 20%, and customers get a finished product.

---

## The Complete Pipeline

### Phase 1: Upload & Ingestion

```
USER ACTION                              SYSTEM RESPONSE
────────────                             ───────────────
Upload PDF(s)                    →       Store in GCS (beam-filestore)
                                         Create "user_request" record
                                         Status = 1 (draft)
```

**API Evidence:**
```json
{
  "inputs_link": "https://storage.googleapis.com/beam-filestore/prod/constructions_zip/EXTRA_SPACE__SELF_STORAGE__LOS_ANGELES_1767213220211328855.zip"
}
```

The system accepts ZIP files containing multiple PDFs.

---

### Phase 2: PDF Processing (Automated)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PDF PROCESSING PIPELINE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   1. PDF SPLITTING                                                          │
│      └── Multi-page PDF → Individual sheet records (user_sheets)            │
│      └── Evidence: 51 sheets from 2 PDF files                               │
│                                                                              │
│   2. THUMBNAIL GENERATION                                                    │
│      └── Low-res JPEG for sheet picker                                      │
│      └── Path: /PDFToImageConversionBatch/{date}/{uuid}/{page}.jpeg         │
│                                                                              │
│   3. TILE GENERATION                                                         │
│      └── High-res PNG tiles for viewer                                      │
│      └── Path: /PDFToTilesConversion/{date}/{uuid}/{z}/{x}/{y}.png          │
│      └── Job ID tracked: fxs_tile_job_id                                    │
│                                                                              │
│   4. SHEET CLASSIFICATION                                                    │
│      └── AI determines: workable vs non-workable                            │
│      └── Workable = actual drawings (floor plans, details)                  │
│      └── Non-workable = cover pages, schedules, notes                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Actual Numbers from Sample Project:**
- Total Sheets: 51
- Workable: 5 (10%)
- Non-Workable: 46 (90%)

This is typical - most blueprint pages are NOT actual drawings.

---

### Phase 3: AI Feature Detection (ATS - Auto Takeoff System)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AI DETECTION SYSTEM (ATS)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   WHAT AI DETECTS:                                                          │
│   ─────────────────                                                          │
│   • Doors (with dimensions, types, materials)                               │
│   • Windows (with dimensions, types)                                        │
│   • Signage (with dimensions)                                               │
│   • Fixtures                                                                │
│   • Equipment                                                               │
│                                                                              │
│   HOW IT WORKS:                                                              │
│   ─────────���───                                                              │
│   1. Computer vision scans each workable sheet                              │
│   2. Detects symbols/objects using trained model                            │
│   3. OCR extracts text labels and dimensions                                │
│   4. Creates "user_feature" records with standardized names                 │
│   5. Places GeoJSON points at detected locations                            │
│                                                                              │
│   EVIDENCE:                                                                  │
│   ──────────                                                                 │
│   • total_ats_processed_sheets: 51 (all sheets processed)                   │
│   • auto_count_process_status: 1 (completed)                                │
│   • Feature names follow pattern: TYPE_DETAILS_DIMENSIONS                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Sample AI-Generated Feature Names:**
```
120-DOUBLE PANEL DOOR_6'-0"WX7'-0"H_DOOR TYPE - FG2_DOOR MATERIAL-AL/GL_FRAME TYPE-PER MFR
SIGNAGE_EXTRA SPACE STORAGE_34'-9"W X 3'-9" H
WINDOW TYPE - C1_3'-4" W X 8'-0" HT
SIGNAGE_24HR OFFICE_7'-8"W X 1'-0" H
110-FOUR PANEL SLIDER DOOR_12'-0"WX8'-8"H_DOOR TYPE - S1_DOOR MATERIAL-AL/GL
```

The naming pattern is clearly automated:
- UPPERCASE
- Underscore-separated
- Includes extracted dimensions
- Includes extracted specifications from door/window schedules

---

### Phase 4: Human QA Review (The Secret Sauce)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HUMAN QA WORKFLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ROLE: "ACE" (Attentive Certified Expert?)                                 │
│   ──────────────────────────────────────────                                │
│                                                                              │
│   Fields tracking QA:                                                        │
│   • ace_review_step - Current step in review process                        │
│   • editing_status - Is someone currently editing?                          │
│   • editing_user - Who is editing?                                          │
│   • is_manual_measurement - Was this manually measured?                     │
│   • edit_count - Number of human edits to AI results                        │
│                                                                              │
│   QA TASKS:                                                                  │
│   ──────────                                                                 │
│   1. Verify AI detections are correct                                       │
│   2. Hide incorrect detections (is_hidden = true)                           │
│   3. Add missed items manually                                              │
│   4. Correct counts/measurements                                            │
│   5. Apply proper MasterFormat tags                                         │
│   6. Merge duplicate features                                               │
│                                                                              │
│   TURNAROUND:                                                                │
│   ────────────                                                               │
│   • processing_time_remaining: "Delivered in 1hrs"                          │
│   • Website claims: 24-72 hours for full takeoff                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Evidence from Data:**
```json
{
  "editing_status": false,      // Not currently being edited
  "editing_user": null,         // No one assigned
  "ace_review_step": null,      // Review completed
  "is_manual_measurement": false,
  "status": 5                   // Archived (complete)
}
```

---

### Phase 5: Delivery & Sharing

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DELIVERY SYSTEM                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   SHARING:                                                                   │
│   ─────────                                                                  │
│   • Shareable link generated: shareable_link                                │
│   • Shared views can hide measurements: hide_measurements                   │
│   • Access control: request_access array                                    │
│                                                                              │
│   EXPORT:                                                                    │
│   ────────                                                                   │
│   • Excel export (primary)                                                  │
│   • PDF export (with annotations)                                           │
│   • can_export permission flag                                              │
│                                                                              │
│   STATUS FLOW:                                                               │
│   ─────────────                                                              │
│   1 (draft) → 2 (processing) → 3 (review) → 4 (completed) → 5 (archived)   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## AI vs Human Responsibilities

### Summary Matrix

| Task | AI | Human | Notes |
|------|:--:|:-----:|-------|
| PDF Upload | | ✓ | User action |
| PDF Splitting | ✓ | | Automated |
| Thumbnail Generation | ✓ | | Automated |
| Tile Generation | ✓ | | Automated |
| Sheet Classification (workable/non) | ✓ | | Likely ML model |
| Symbol Detection | ✓ | | Computer vision |
| OCR Text Extraction | ✓ | | Tesseract or similar |
| Feature Naming | ✓ | | Template-based from OCR |
| Initial Count Placement | ✓ | | auto_count system |
| QA Verification | | ✓ | ACE reviewers |
| Error Correction | | ✓ | Hide/edit features |
| Tag Application | ✓ | ✓ | AI suggests, human confirms |
| Export Generation | ✓ | | Automated |
| Customer Support | | ✓ | "Ask BeamGPT" + humans |

### What "is_ai_created" Really Means

Interestingly, in the sample project:
- **AI-Created Outputs: 0**
- **Human-Created Outputs: 2**

This suggests that even though AI detects features, the actual annotations might be placed/confirmed by humans, OR the `is_ai_created` flag is only set for fully automated outputs without human review.

---

## Data Evidence

### Project Status Codes

```javascript
const STATUS = {
  1: 'draft',       // Just uploaded
  2: 'processing',  // AI processing
  3: 'review',      // Human QA
  4: 'completed',   // Ready for customer
  5: 'archived'     // Done
};
```

### Sheet Status Codes

```javascript
const SHEET_STATUS = {
  1: 'pending',     // Not processed
  2: 'processing',  // Being worked on
  3: 'completed'    // Done
};
```

### auto_count_process_status

```javascript
const AUTO_COUNT_STATUS = {
  1: 'completed',   // AI finished
  2: 'processing',  // AI working
  3: 'failed'       // AI couldn't process
};
```

### Geometry Types

```javascript
const GEOMETRY_TYPE = {
  1: 'Point',       // Count items (doors, windows, fixtures)
  2: 'LineString',  // Linear measurements (walls, pipes)
  3: 'Polygon'      // Area measurements (rooms, flooring)
};
```

---

## Key Metrics Observed

### From the Sample Project

| Metric | Value | Insight |
|--------|-------|---------|
| Total Sheets | 51 | Typical mid-size project |
| Workable Sheets | 5 (10%) | Most pages are non-drawing |
| AI-Processed | 51 (100%) | All sheets scanned |
| Features Detected | 17 | All Point type (counts) |
| Point Features | 17 (100%) | No linear/area in this project |
| Line Features | 0 | Project focused on openings |
| Polygon Features | 0 | No area takeoffs |
| Outputs on Sample Sheet | 2 | Sparse - signage only |
| GeoJSON Features | 6 | 3 per output |
| Processing Time | "1hr" | Fast turnaround |
| Tag Types | 2 | MasterFormat + Trades |

### Feature Naming Analysis

All 17 features follow AI-generated patterns:
- Start with item type (DOOR, WINDOW, SIGNAGE)
- Include dimensions extracted via OCR
- Include specifications from schedules
- Use UPPERCASE_WITH_UNDERSCORES format

---

## Business Model Insights

### Revenue Model (Inferred)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BUSINESS MODEL INFERENCE                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   PRICING: Credit-based system                                              │
│   ─────────────────────────────                                              │
│   • Credits tied to "workable sheets"                                       │
│   • Non-workable sheets likely free/cheap                                   │
│   • This explains the classification step                                   │
│                                                                              │
│   COST STRUCTURE:                                                            │
│   ────────────────                                                           │
│   Fixed costs:                                                               │
│   • Cloud infrastructure (GCS, compute)                                     │
│   • AI model training/hosting                                               │
│                                                                              │
│   Variable costs:                                                            │
│   • Human QA time (main cost driver)                                        │
│   • This is why 24-72hr turnaround - batching QA work                      │
│                                                                              │
│   EFFICIENCY GAINS:                                                          │
│   ─────────────────                                                          │
│   • AI handles 80%+ of detection                                            │
│   • Humans just verify/correct                                              │
│   • One QA person can handle many projects                                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Customer Segments (Inferred from Fields)

1. **Regular Users** - Standard workflow
2. **Pilot Users** (`is_pilot`) - Trial/evaluation
3. **Accelerate Users** (`is_accelerate_user`) - Priority/premium tier
4. **Prospects** (`prospect_company_name`) - Sales pipeline

### Sales Process (Inferred)

```
account_executive → sales_engineer → pilot project → conversion
```

Fields suggest an enterprise sales motion with demos and pilots.

---

## Technical Implementation Details

### Backend Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BACKEND SYSTEMS                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   API: "Feathers" (feathers.ibeam.ai)                                       │
│   ─────────────────────────────────────                                      │
│   • Likely FeathersJS (Node.js framework)                                   │
│   • REST API with consistent patterns                                       │
│   • PostgreSQL backend (UUID primary keys)                                  │
│                                                                              │
│   STORAGE: Google Cloud Storage                                             │
│   ─────────────────────────────────                                          │
│   • beam-filestore: Original PDFs                                           │
│   • autofx-outputs: Generated tiles/images                                  │
│   • falcon-shared-images-front-end: Static assets                           │
│                                                                              │
│   PROCESSING: Job Queue System                                              │
│   ─────────────────────────────────                                          │
│   • fxs_job_id: Main processing job                                         │
│   • fxs_tile_job_id: Tile generation job                                    │
│   • auto_count_job_id: AI detection job                                     │
│   • Likely Celery or Bull queue                                             │
│                                                                              │
│   AI: "ATS" (Auto Takeoff System)                                           │
│   ─────────────────────────────────                                          │
│   • total_ats_processed_sheets                                              │
│   • auto_count_* fields                                                     │
│   • Likely custom trained models                                            │
│   • Parent company: Attentive AI                                            │
│                                                                              │
│   REAL-TIME: Firebase                                                        │
│   ──────────────────────                                                     │
│   • Collaboration features                                                  │
│   • Live updates                                                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### The "FXS" System

Multiple references to `fxs_*` fields:
- `fxs_job_id`
- `fxs_tile_job_id`

"FXS" is likely their internal codename for the processing pipeline. Possibly "Feature Extraction System" or similar.

### The "ACE" Role

`ace_review_step` suggests:
- "ACE" = Attentive Certified Expert (or similar)
- Internal QA team designation
- Multi-step review process

---

## Implications for Stratos

### What to Copy

1. **Tile-based PDF rendering** - Proven scalable approach
2. **Workable/Non-workable classification** - Reduces scope intelligently
3. **GeoJSON for annotations** - Standard, flexible
4. **OpenLayers for viewer** - Battle-tested
5. **Credit-based pricing** - Aligned with value delivery

### What to Differentiate

1. **More automation** - Reduce human QA dependency
2. **Real-time collaboration** - Not just view-only sharing
3. **Self-service** - Let users do their own takeoffs
4. **Trade-specific AI** - Specialized models per trade
5. **Integration focus** - Connect to estimating software

### Key Insight

ibeam.ai has built a **service business** disguised as a **software product**. The AI is impressive but not fully autonomous - humans are essential to their delivery.

For Stratos, the choice is:
1. **Copy their model** - AI + human QA service
2. **Pure software** - Self-service tool with AI assistance
3. **Hybrid** - AI-first with optional human review add-on

---

## Appendix: Raw Field Analysis

### user_request Fields (60+ fields)

```
Core:
- id, name, status, user, created_at, completed_at

AI/Processing:
- ai_run_status, gpt_processing_status
- fxs_job_id, fxs_tile_job_id
- processing_time_remaining

Human Workflow:
- editing_status, editing_user
- ace_review_step
- is_manual_measurement
- is_feedback, is_rfi_raised

Business:
- is_pilot, is_accelerate_user
- account_executive, sales_engineer
- prospect_company_name

Chat:
- chat_session_id
- is_chat_positive
- user_chat_feedback
- gpt_processing_status

Settings:
- measurement_system
- is_measurement_system_enabled
- hide_measurements

Access:
- request_access
- can_export
- shareable_link
```

### user_output Fields

```
- output_id
- feature (nested feature object)
- output_geojson (FeatureCollection)
- is_ai_created
- is_hidden
- auto_count_job_id
- auto_count_process_status
```

### GeoJSON Feature Properties

```
- count
- zone_id
- tags_info
- vector_layer_id
- measurement (for linear/area)
- unit
```

---

*Analysis completed January 7, 2026*
