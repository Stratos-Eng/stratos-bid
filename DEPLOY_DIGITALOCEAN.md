# Deploy to DigitalOcean (App Platform)

This repo is a Next.js app.

## Recommended approach

Use **DigitalOcean App Platform** with the included `Dockerfile` and `app.yaml`.

### 1) Create the app

Option A (UI):
- App Platform → Create App → GitHub → select `Stratos-Eng/stratos-bid`
- Build & deploy using the **Dockerfile** in the repo

Option B (spec):
- Use `app.yaml` as your app spec.

### 2) Configure environment variables

Set these as **Secrets** in DO (do not commit real values):

- Database:
  - `DATABASE_URL`
  - `ENCRYPTION_KEY`
- Clerk:
  - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
  - `CLERK_SECRET_KEY`
  - `CLERK_WEBHOOK_SECRET`
- DigitalOcean Spaces (S3-compatible):
  - `DO_SPACES_BUCKET`
  - `DO_SPACES_REGION`
  - `DO_SPACES_ENDPOINT`
  - `DO_SPACES_KEY`
  - `DO_SPACES_SECRET`
- Inngest:
  - `INNGEST_EVENT_KEY`
  - `INNGEST_SIGNING_KEY`
- AI:
  - `ANTHROPIC_API_KEY` (or switch to an inference proxy)

See `.env.example` for the full list.

### 3) Database

This app uses `drizzle` with `DATABASE_URL`.

You can point `DATABASE_URL` at:
- DigitalOcean Managed Postgres, or
- an existing provider (Neon, RDS, etc.)

### 4) Background jobs (Inngest)

This repo includes Inngest. Decide where the Inngest server runs:
- Managed Inngest cloud, or
- self-host Inngest on DO as a separate service.

### 5) Local Docker

```bash
docker build -t stratos-bid .
docker run --rm -p 3000:3000 --env-file .env stratos-bid
```
