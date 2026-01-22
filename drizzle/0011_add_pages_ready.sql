-- Add pages_ready column to documents table for page-level architecture
-- When true, individual pages have been split and stored separately
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pages_ready boolean DEFAULT false;
