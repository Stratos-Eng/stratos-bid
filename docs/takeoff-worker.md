# Takeoff Worker (Droplet)

Stratos takeoffs are long-running jobs. DigitalOcean App Platform requests must return quickly; the actual extraction work runs on a droplet worker.

## Architecture

- **App Platform**: enqueue a job + show status/results.
- **Postgres**: source of truth for jobs + document statuses + extracted line items.
- **Droplet worker**: claims queued jobs, downloads PDFs from Spaces, runs extraction (fast-path or agentic loop), writes results back.
- **OpenClaw**: inference backend used by the agentic extraction loop.

## DB migration

Apply:

- `drizzle/0013_takeoff_jobs.sql`

This creates:
- `takeoff_jobs`
- `takeoff_job_documents`

## Enqueue API

- `POST /api/takeoff/enqueue`
  - `{ bidId }` → primary workflow (1 job per bid)
  - `{ bidId, documentIds }` → supported for targeted runs

Compat:
- `POST /api/extraction-v3` now enqueues takeoff jobs too.

## Worker

Entry point:
- `worker/takeoff-worker.ts`

Run locally:

```bash
npm run worker
```

## systemd service (droplet)

1) Copy unit file:

```bash
sudo cp /home/openclaw/stratos-bid/worker/stratos-takeoff-worker.service /etc/systemd/system/stratos-takeoff-worker.service
sudo systemctl daemon-reload
```

2) Create `/home/openclaw/stratos-bid/.env.worker` with at least:

```bash
DATABASE_URL=...
SPACES_ACCESS_KEY_ID=...
SPACES_SECRET_ACCESS_KEY=...
SPACES_BUCKET=stratos-bid-files
SPACES_REGION=sfo3

# Inference used by runExtractionLoop (see src/lib/inference)
INFERENCE_BASE_URL=https://openclaw.stratos.to/v1
INFERENCE_API_KEY=... 
```

3) Enable + start:

```bash
sudo systemctl enable --now stratos-takeoff-worker
sudo journalctl -u stratos-takeoff-worker -f
```

## Notes

- The UI continues to poll document-level `extractionStatus` via `/api/projects/:id`.
- Bucket CORS is still recommended so the browser fast-path upload works, but server-side upload fallback exists.
