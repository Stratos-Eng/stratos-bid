-- Enable pgvector extension for similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Symbol regions for visual similarity search
CREATE TABLE symbol_regions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,

  -- Region coordinates (normalized 0-1)
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,

  -- CLIP embedding for visual similarity (512 dimensions for clip-ViT-B-32)
  embedding vector(512),

  -- OCR text if detected
  ocr_text TEXT,
  ocr_confidence REAL,

  -- Metadata
  source TEXT DEFAULT 'user_click', -- 'user_click' | 'auto_detected' | 'sliding_window'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for vector similarity search (using IVFFlat for faster approximate search)
-- This requires at least 100 rows to work, so we create it but it activates later
CREATE INDEX IF NOT EXISTS symbol_regions_embedding_idx
  ON symbol_regions
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Index for document lookups
CREATE INDEX IF NOT EXISTS symbol_regions_document_idx ON symbol_regions(document_id);
CREATE INDEX IF NOT EXISTS symbol_regions_page_idx ON symbol_regions(document_id, page_number);
