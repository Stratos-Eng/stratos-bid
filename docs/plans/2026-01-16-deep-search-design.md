# Deep Search Feature Design

## Overview

Full-text search within a project across all PDF documents. Users press `Cmd+F`, type a query, see results with snippets, and click to jump to that page with the match highlighted.

## Goals

- Search for any text across all PDFs in a project (sign codes, room names, spec references)
- Fast results with relevance ranking
- Seamless navigation between matches without closing search
- Handle both embedded text and scanned PDFs (via OCR)

## Non-Goals (v1)

- Visual symbol search (stretch goal for future)
- Cross-project search
- Semantic/AI-powered search

---

## User Experience

### Flow

1. User presses `Cmd+F` or clicks search icon
2. Search panel slides in from left, replacing filmstrip
3. User types query, results appear as they type (debounced)
4. Results show: document name, page number, snippet with highlighted match
5. User clicks result → PDF viewer jumps to that page, search panel stays open
6. User navigates with `↑/↓` arrows between matches
7. `Escape` closes search, returns to filmstrip view

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Cmd+F` / `Ctrl+F` | Open search, focus input |
| `Enter` | Jump to first/next result |
| `↑` / `↓` | Navigate results list |
| `Escape` | Close search panel |

---

## Technical Design

### Data Model

New table for page-level text content:

```sql
CREATE TABLE page_text (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  raw_text TEXT,
  text_search TSVECTOR,
  extraction_method TEXT DEFAULT 'pymupdf',
  needs_ocr BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(document_id, page_number)
);

CREATE INDEX page_text_search_idx ON page_text USING GIN(text_search);

CREATE TRIGGER page_text_search_update
  BEFORE INSERT OR UPDATE ON page_text
  FOR EACH ROW EXECUTE FUNCTION
  tsvector_update_trigger(text_search, 'pg_catalog.english', raw_text);
```

### Text Extraction Pipeline

**Phase 1: At Upload (PyMuPDF)**

```
Upload Complete → Inngest: "document/extract-text"
                         ↓
              Python service extracts text per page
                         ↓
              Insert into page_text table
                         ↓
              If page has <50 chars → set needs_ocr=true
```

Python service endpoint:

```python
@app.post("/text")
def extract_text(pdf_bytes: bytes) -> list[PageText]:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    for i, page in enumerate(doc):
        text = page.get_text()
        pages.append({
            "page": i + 1,
            "text": text,
            "needs_ocr": len(text.strip()) < 50
        })
    return pages
```

**Phase 2: Background OCR (Tesseract) - Future**

```
Background job → Find pages where needs_ocr=true
                        ↓
              Render page to image
                        ↓
              Run Tesseract OCR
                        ↓
              Update raw_text, set needs_ocr=false
```

### Search API

**Endpoint:** `GET /api/projects/[id]/search?q=<query>`

**Response:**

```typescript
{
  query: string,
  total: number,
  results: [
    {
      documentId: string,
      documentName: string,
      pageNumber: number,
      snippet: string,
      rank: number
    }
  ]
}
```

**Query:**

```sql
SELECT
  pt.document_id,
  d.filename as document_name,
  pt.page_number,
  ts_headline('english', pt.raw_text, query,
    'StartSel=<mark>, StopSel=</mark>, MaxWords=20, MinWords=10'
  ) as snippet,
  ts_rank(pt.text_search, query) as rank
FROM page_text pt
JOIN documents d ON d.id = pt.document_id
WHERE d.bid_id = $projectId
  AND pt.text_search @@ plainto_tsquery('english', $query)
ORDER BY rank DESC
LIMIT 50
```

### UI Components

**SearchPanel** (`/src/components/projects/search-panel.tsx`)

```
┌─────────────────────────────────────────────────────────┐
│ [🔍 Search...________________________] [×]              │
├─────────────────────────────────────────────────────────┤
│ 12 results for "ada signage"                            │
├─────────────────────────────────────────────────────────┤
│ 📄 A1.1 - Floor Plan                          Page 3    │
│ "...room shall have <mark>ADA signage</mark> per..."    │
├─────────────────────────────────────────────────────────┤
│ 📄 A1.1 - Floor Plan                          Page 7    │
│ "...<mark>ADA signage</mark> type S-102..."             │
└─────────────────────────────────────────────────────────┘
```

**State additions to project-store.ts:**

```typescript
searchQuery: string
searchResults: SearchResult[]
activeResultIndex: number
isSearchOpen: boolean
```

---

## Implementation Phases

### Phase 1: Text Extraction (Backend)
- Add `page_text` table with Drizzle migration
- Extend Python service with `/text` endpoint
- Add Inngest job `document/extract-text` triggered after upload
- Flag low-text pages for OCR

### Phase 2: Search API
- Create `GET /api/projects/[id]/search` endpoint
- Implement PostgreSQL full-text query with snippets
- Add debounced search hook on frontend

### Phase 3: Search UI
- Build `SearchPanel` component
- Add search state to project store
- Wire up `Cmd+F` keyboard shortcut
- Implement result navigation (↑/↓/Enter)

### Phase 4: Polish
- Add search icon to header as alternative trigger
- Show "indexing..." indicator if text extraction still running
- Handle empty states (no results, no indexed pages)

### Phase 5 (Future): OCR
- Add Tesseract to Python service
- Create background job for OCR on flagged pages
- Re-index after OCR completes

---

## Files to Create/Modify

**New files:**
- `src/components/projects/search-panel.tsx`
- `src/app/api/projects/[id]/search/route.ts`
- `drizzle/0009_*.sql` (page_text table migration)

**Modified files:**
- `services/vector-extractor/src/main.py` (add /text endpoint)
- `src/inngest/functions.ts` (add extract-text job)
- `src/lib/stores/project-store.ts` (add search state)
- `src/app/(dashboard)/projects/[id]/page.tsx` (integrate search panel)
- `src/app/api/upload/complete/route.ts` (trigger text extraction)

---

## Decisions

1. **Show indicator on non-OCR'd pages** - Yes. Display a subtle warning in search results if some pages haven't been indexed yet.
2. **Support phrase search** - Yes. Wrap query in quotes for exact phrase matching using `phraseto_tsquery`.
3. **Persist search state** - Yes. Keep search query and results in zustand store, restore when returning to project.
