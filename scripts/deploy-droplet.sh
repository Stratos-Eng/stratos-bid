#!/usr/bin/env bash
set -euo pipefail

# Ensure Homebrew (linuxbrew) Node is available in non-interactive shells
export PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH"

# Deploy Stratos worker/runtime on the OpenClaw droplet.
# This script is designed to be run over SSH by GitHub Actions.

APP_DIR=${APP_DIR:-/home/openclaw/stratos-bid}
REPO_URL=${REPO_URL:-https://github.com/Stratos-Eng/stratos-bid.git}
BRANCH=${BRANCH:-main}

echo "[deploy] host=$(hostname) user=$(whoami)"
echo "[deploy] APP_DIR=${APP_DIR} BRANCH=${BRANCH}"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "[deploy] cloning repo into ${APP_DIR}"
  mkdir -p "${APP_DIR}"
  git clone "${REPO_URL}" "${APP_DIR}"
fi

cd "${APP_DIR}"

echo "[deploy] fetching + checkout"
git fetch --all --prune
# reset hard to match origin to avoid drift
git checkout "${BRANCH}"
git reset --hard "origin/${BRANCH}"

echo "[deploy] install deps"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

echo "[deploy] build"
# NOTE: This droplet deploy is intended for the long-running worker.
# Building the full Next.js app requires many runtime env vars (DATABASE_URL, Spaces creds, etc.)
# which we do not want to store on the droplet deploy user.
#
# Once the worker is implemented as its own package (e.g. ./worker), we will build only that.
# For now, we skip `next build` here.
echo "[deploy] skipping next build (worker not yet implemented)"

echo "[deploy] write worker env file (if secrets provided)"
# These env vars should be provided via GitHub Actions Environment secrets.
# We only write keys that are present to avoid clobbering manual edits.
ENV_FILE="${APP_DIR}/.env.worker"
mkdir -p "${APP_DIR}"

write_kv () {
  local key="$1"
  local val="$2"
  if [[ -n "${val}" ]]; then
    echo "${key}=${val}" >> "${ENV_FILE}.tmp"
  fi
}

# If *any* worker secret is present, rewrite the env file atomically.
if [[ -n "${DATABASE_URL:-}" || -n "${DO_SPACES_BUCKET:-}" || -n "${DO_SPACES_KEY:-}" || -n "${OPENCLAW_INFERENCE_URL:-}" || -n "${OPENCLAW_API_KEY:-}" ]]; then
  echo "[deploy] updating ${ENV_FILE}"
  : > "${ENV_FILE}.tmp"
  write_kv "NODE_ENV" "production"
  write_kv "DATABASE_URL" "${DATABASE_URL:-}"
  write_kv "DO_SPACES_BUCKET" "${DO_SPACES_BUCKET:-}"
  write_kv "DO_SPACES_REGION" "${DO_SPACES_REGION:-}"
  write_kv "DO_SPACES_ENDPOINT" "${DO_SPACES_ENDPOINT:-}"
  write_kv "DO_SPACES_KEY" "${DO_SPACES_KEY:-}"
  write_kv "DO_SPACES_SECRET" "${DO_SPACES_SECRET:-}"
  write_kv "OPENCLAW_INFERENCE_URL" "${OPENCLAW_INFERENCE_URL:-}"
  write_kv "OPENCLAW_API_KEY" "${OPENCLAW_API_KEY:-}"
  write_kv "OPENCLAW_AGENT_MODEL" "${OPENCLAW_AGENT_MODEL:-}"
  write_kv "TAKEOFF_WORKER_POLL_MS" "${TAKEOFF_WORKER_POLL_MS:-}"
  write_kv "TAKEOFF_WORKER_CLAIM_TIMEOUT_MS" "${TAKEOFF_WORKER_CLAIM_TIMEOUT_MS:-}"
  mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}" || true
else
  echo "[deploy] no worker secrets provided; leaving ${ENV_FILE} unchanged"
fi

echo "[deploy] restart worker service (if present)"
if systemctl list-unit-files | grep -q '^stratos-takeoff-worker\.service'; then
  sudo systemctl restart stratos-takeoff-worker
  sudo systemctl --no-pager --full status stratos-takeoff-worker | sed -n '1,30p'
else
  echo "[deploy] NOTE: stratos-takeoff-worker.service not installed yet; skipping restart"
fi

echo "[deploy] done"
