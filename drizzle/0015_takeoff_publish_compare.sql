-- Takeoff v2: publish a preferred run per bid/user

create table if not exists takeoff_run_publishes (
  id uuid primary key default gen_random_uuid(),
  bid_id uuid not null references bids(id) on delete cascade,
  run_id uuid not null references takeoff_runs(id) on delete cascade,
  user_id text not null,
  created_at timestamp not null default now()
);

create unique index if not exists takeoff_run_publishes_bid_user_unique
  on takeoff_run_publishes (bid_id, user_id);

create index if not exists takeoff_run_publishes_run_idx
  on takeoff_run_publishes (run_id);
