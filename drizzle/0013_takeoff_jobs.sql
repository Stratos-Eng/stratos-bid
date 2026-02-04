-- Takeoff job queue (droplet worker)

CREATE TABLE IF NOT EXISTS takeoff_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued', -- queued | running | succeeded | failed
  requested_document_ids jsonb,
  bid_folder text,
  lock_id text,
  locked_at timestamp,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  started_at timestamp,
  finished_at timestamp
);

CREATE INDEX IF NOT EXISTS takeoff_jobs_status_idx ON takeoff_jobs(status);
CREATE INDEX IF NOT EXISTS takeoff_jobs_bid_idx ON takeoff_jobs(bid_id);
CREATE INDEX IF NOT EXISTS takeoff_jobs_user_idx ON takeoff_jobs(user_id);

CREATE TABLE IF NOT EXISTS takeoff_job_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES takeoff_jobs(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS takeoff_job_documents_unique ON takeoff_job_documents(job_id, document_id);
CREATE INDEX IF NOT EXISTS takeoff_job_documents_job_idx ON takeoff_job_documents(job_id);
CREATE INDEX IF NOT EXISTS takeoff_job_documents_doc_idx ON takeoff_job_documents(document_id);
