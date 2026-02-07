-- Takeoff instances + dedupe groups (placement takeoff)

CREATE TABLE IF NOT EXISTS takeoff_dedupe_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE CASCADE,
  bid_id uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  canonical_instance_id uuid,
  reason text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS takeoff_dedupe_groups_run_idx ON takeoff_dedupe_groups(run_id);

CREATE TABLE IF NOT EXISTS takeoff_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE CASCADE,
  bid_id uuid NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  type_item_id uuid REFERENCES takeoff_items(id) ON DELETE SET NULL,
  source_kind text NOT NULL DEFAULT 'evidence', -- evidence | inferred
  status text NOT NULL DEFAULT 'needs_review', -- counted | needs_review | excluded | duplicate
  confidence real,
  dedupe_group_id uuid REFERENCES takeoff_dedupe_groups(id) ON DELETE SET NULL,
  dedupe_role text, -- canonical | supporting | duplicate_candidate
  meta jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS takeoff_instances_run_idx ON takeoff_instances(run_id);
CREATE INDEX IF NOT EXISTS takeoff_instances_type_idx ON takeoff_instances(type_item_id);
CREATE INDEX IF NOT EXISTS takeoff_instances_status_idx ON takeoff_instances(status);
CREATE INDEX IF NOT EXISTS takeoff_instances_source_kind_idx ON takeoff_instances(source_kind);

CREATE TABLE IF NOT EXISTS takeoff_instance_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES takeoff_instances(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number integer,
  evidence_text text,
  evidence jsonb,
  weight real,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS takeoff_instance_evidence_instance_idx ON takeoff_instance_evidence(instance_id);
CREATE INDEX IF NOT EXISTS takeoff_instance_evidence_doc_page_idx ON takeoff_instance_evidence(document_id, page_number);
