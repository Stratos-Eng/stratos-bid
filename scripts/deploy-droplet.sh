#!/usr/bin/env bash
set -euo pipefail

# Deploy Stratos worker/runtime on the OpenClaw droplet.
# This script is designed to be run over SSH by GitHub Actions.

APP_DIR=${APP_DIR:-/opt/stratos-bid}
REPO_URL=${REPO_URL:-https://github.com/Stratos-Eng/stratos-bid.git}
BRANCH=${BRANCH:-main}

echo "[deploy] host=$(hostname) user=$(whoami)"
echo "[deploy] APP_DIR=${APP_DIR} BRANCH=${BRANCH}"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "[deploy] cloning repo into ${APP_DIR}"
  sudo mkdir -p "${APP_DIR}"
  sudo chown "$(whoami)":"$(whoami)" "${APP_DIR}"
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
# If/when we add a worker package, we'll add a dedicated build step here.
# For now, ensure the repo still builds.
NODE_OPTIONS=--max-old-space-size=4096 npm run build

echo "[deploy] restart worker service (if present)"
if systemctl list-unit-files | grep -q '^stratos-takeoff-worker\.service'; then
  sudo systemctl restart stratos-takeoff-worker
  sudo systemctl --no-pager --full status stratos-takeoff-worker | sed -n '1,30p'
else
  echo "[deploy] NOTE: stratos-takeoff-worker.service not installed yet; skipping restart"
fi

echo "[deploy] done"
