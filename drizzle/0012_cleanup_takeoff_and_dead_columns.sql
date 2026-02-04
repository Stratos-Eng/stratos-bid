-- Drop takeoff tables (order matters due to foreign keys)
DROP TABLE IF EXISTS "sheet_vectors" CASCADE;
DROP TABLE IF EXISTS "takeoff_measurements" CASCADE;
DROP TABLE IF EXISTS "takeoff_categories" CASCADE;
DROP TABLE IF EXISTS "takeoff_sheets" CASCADE;
DROP TABLE IF EXISTS "takeoff_projects" CASCADE;

-- Drop extraction_jobs table (no longer used by V3 agentic pipeline)
DROP TABLE IF EXISTS "extraction_jobs" CASCADE;

-- Remove project_id column from upload_sessions (was FK to takeoff_projects)
ALTER TABLE "upload_sessions" DROP COLUMN IF EXISTS "project_id";

-- Drop dead columns from documents
ALTER TABLE "documents" DROP COLUMN IF EXISTS "extracted_text";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "tile_config";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "thumbnails_generated";

-- Drop dead columns from line_items
ALTER TABLE "line_items" DROP COLUMN IF EXISTS "pdf_file_path";
ALTER TABLE "line_items" DROP COLUMN IF EXISTS "specifications";

-- Add missing indexes
CREATE INDEX IF NOT EXISTS "sync_jobs_user_idx" ON "sync_jobs" ("user_id");
CREATE INDEX IF NOT EXISTS "sync_jobs_status_idx" ON "sync_jobs" ("status");
CREATE INDEX IF NOT EXISTS "upload_sessions_expires_at_idx" ON "upload_sessions" ("expires_at");
