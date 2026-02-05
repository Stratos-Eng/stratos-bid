-- Takeoff runs + findings + items (estimator workspace)

CREATE TABLE IF NOT EXISTS takeoff_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES takeoff_jobs(id) ON DELETE CASCADE,
  bid_id uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  status text NOT NULL DEFAULT 'running', -- running | succeeded | failed
  worker_id text,
  extractor_version text,
  model text,
  started_at timestamp NOT NULL DEFAULT now(),
  finished_at timestamp,
  summary jsonb,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS takeoff_runs_job_idx ON takeoff_runs(job_id);
CREATE INDEX IF NOT EXISTS takeoff_runs_bid_idx ON takeoff_runs(bid_id);
CREATE INDEX IF NOT EXISTS takeoff_runs_user_idx ON takeoff_runs(user_id);
CREATE INDEX IF NOT EXISTS takeoff_runs_status_idx ON takeoff_runs(status);

CREATE TABLE IF NOT EXISTS takeoff_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE CASCADE,
  bid_id uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number integer,
  method text,
  raw_text text,
  meta jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS takeoff_artifacts_run_idx ON takeoff_artifacts(run_id);
CREATE INDEX IF NOT EXISTS takeoff_artifacts_doc_idx ON takeoff_artifacts(document_id);

CREATE TABLE IF NOT EXISTS takeoff_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE CASCADE,
  bid_id uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number integer,
  type text NOT NULL, -- snippet | schedule_row | callout | header | note | etc.
  confidence real,
  data jsonb,
  evidence_text text,
  evidence jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS takeoff_findings_run_idx ON takeoff_findings(run_id);
CREATE INDEX IF NOT EXISTS takeoff_findings_doc_page_idx ON takeoff_findings(document_id, page_number);
CREATE INDEX IF NOT EXISTS takeoff_findings_type_idx ON takeoff_findings(type);

CREATE TABLE IF NOT EXISTS takeoff_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE CASCADE,
  bid_id uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  trade_code text NOT NULL,
  item_key text NOT NULL,
  code text,
  category text NOT NULL,
  description text NOT NULL,
  qty_number real,
  qty_text text,
  unit text,
  confidence real,
  status text NOT NULL DEFAULT 'draft', -- draft | needs_review | approved | rejected | modified
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS takeoff_items_run_idx ON takeoff_items(run_id);
CREATE INDEX IF NOT EXISTS takeoff_items_bid_idx ON takeoff_items(bid_id);
CREATE INDEX IF NOT EXISTS takeoff_items_user_idx ON takeoff_items(user_id);
CREATE INDEX IF NOT EXISTS takeoff_items_trade_idx ON takeoff_items(trade_code);
CREATE UNIQUE INDEX IF NOT EXISTS takeoff_items_run_key_unique ON takeoff_items(run_id, item_key);

CREATE TABLE IF NOT EXISTS takeoff_item_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES takeoff_items(id) ON DELETE CASCADE,
  finding_id uuid NOT NULL REFERENCES takeoff_findings(id) ON DELETE CASCADE,
  weight real,
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS takeoff_item_evidence_unique ON takeoff_item_evidence(item_id, finding_id);
CREATE INDEX IF NOT EXISTS takeoff_item_evidence_item_idx ON takeoff_item_evidence(item_id);
CREATE INDEX IF NOT EXISTS takeoff_item_evidence_finding_idx ON takeoff_item_evidence(finding_id);

CREATE TABLE IF NOT EXISTS takeoff_item_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES takeoff_items(id) ON DELETE CASCADE,
  edited_by text NOT NULL,
  edit_type text NOT NULL,
  before jsonb,
  after jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS takeoff_item_edits_item_idx ON takeoff_item_edits(item_id);
