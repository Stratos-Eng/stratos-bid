-- Page text table for full-text search across PDF documents
CREATE TABLE IF NOT EXISTS "page_text" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "page_number" integer NOT NULL,
  "raw_text" text,
  "text_search" tsvector,
  "extraction_method" text DEFAULT 'pymupdf',
  "needs_ocr" boolean DEFAULT false,
  "created_at" timestamp DEFAULT now() NOT NULL,
  UNIQUE("document_id", "page_number")
);

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS "page_text_search_idx" ON "page_text" USING GIN("text_search");

-- Indexes for queries
CREATE INDEX IF NOT EXISTS "page_text_document_page_idx" ON "page_text" ("document_id", "page_number");
CREATE INDEX IF NOT EXISTS "page_text_needs_ocr_idx" ON "page_text" ("needs_ocr") WHERE "needs_ocr" = true;

-- Trigger to auto-update tsvector when raw_text changes
CREATE OR REPLACE FUNCTION page_text_search_update() RETURNS trigger AS $$
BEGIN
  NEW.text_search := to_tsvector('english', COALESCE(NEW.raw_text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS page_text_search_trigger ON page_text;
CREATE TRIGGER page_text_search_trigger
  BEFORE INSERT OR UPDATE OF raw_text ON page_text
  FOR EACH ROW EXECUTE FUNCTION page_text_search_update();

-- Add text extraction status to documents table
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "text_extraction_status" text DEFAULT 'not_started';
-- 'not_started' | 'extracting' | 'completed' | 'failed'
