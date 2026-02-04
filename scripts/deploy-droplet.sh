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

echo "[deploy] restart worker service (if present)"
if systemctl list-unit-files | grep -q '^stratos-takeoff-worker\.service'; then
  sudo systemctl restart stratos-takeoff-worker
  sudo systemctl --no-pager --full status stratos-takeoff-worker | sed -n '1,30p'
else
  echo "[deploy] NOTE: stratos-takeoff-worker.service not installed yet; skipping restart"
fi

echo "[deploy] done"
