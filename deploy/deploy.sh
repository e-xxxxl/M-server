#!/usr/bin/env bash
# Deploys a new release of the NMREP API and rolls back by itself if the new one does not start.
#
# Run as root (or with sudo) on the VPS:
#   sudo nmrep-deploy /tmp/nmrep-backend.tar.gz
#
# What it does:
#   1. Unpacks the upload into /opt/nmrep/releases/<time>/
#   2. Links the shared .env into it (the settings are kept in one place, outside every release)
#   3. Installs the dependencies (production ones only)
#   4. Points /opt/nmrep/current at the new release and restarts the service
#   5. Checks /api/health. If it fails, goes back to the previous release.
#   6. Keeps the 5 newest releases.
set -euo pipefail

APP_DIR=/opt/nmrep
SERVICE=nmrep-api
KEEP=5
TARBALL="${1:-}"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
if [[ -z "$TARBALL" || ! -f "$TARBALL" ]]; then echo "Usage: sudo nmrep-deploy /path/to/nmrep-backend.tar.gz"; exit 1; fi
if [[ ! -f "$APP_DIR/shared/.env" ]]; then echo "Missing $APP_DIR/shared/.env. Create it first (see DEPLOY-VPS.md, step 6)."; exit 1; fi

STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE="$APP_DIR/releases/$STAMP"
PREVIOUS="$(readlink -f "$APP_DIR/current" 2>/dev/null || true)"

echo "==> Unpacking into $RELEASE"
mkdir -p "$RELEASE"
tar -xzf "$TARBALL" -C "$RELEASE"
if [[ ! -f "$RELEASE/backend/package.json" ]]; then
  echo "The upload does not contain backend/package.json. Rebuild the tarball from the project folder."
  rm -rf "$RELEASE"; exit 1
fi

ln -s "$APP_DIR/shared/.env" "$RELEASE/backend/.env"
chown -R nmrep:nmrep "$RELEASE"

echo "==> Installing dependencies"
sudo -u nmrep bash -c "cd '$RELEASE/backend' && npm ci --omit=dev --no-audit --no-fund"

echo "==> Switching to the new release"
ln -sfn "$RELEASE" "$APP_DIR/current"
systemctl restart "$SERVICE"

PORT="$(grep -E '^PORT=' "$APP_DIR/shared/.env" | tail -1 | cut -d= -f2 | tr -d '[:space:]"' || true)"
PORT="${PORT:-4000}"

echo "==> Waiting for the API to answer on port $PORT"
ok=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"database":true'; then ok=1; break; fi
  sleep 2
done

if [[ $ok -ne 1 ]]; then
  echo "!! The new release did not become healthy. Recent log:"
  journalctl -u "$SERVICE" -n 25 --no-pager | sed 's/mongodb[^ ]*/[hidden]/g' || true
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    echo "==> Rolling back to $PREVIOUS"
    ln -sfn "$PREVIOUS" "$APP_DIR/current"
    systemctl restart "$SERVICE"
  fi
  echo "Deploy FAILED. The failed release is kept at $RELEASE for inspection."
  exit 1
fi

echo "==> Healthy. Cleaning up old releases (keeping $KEEP)"
ls -1dt "$APP_DIR"/releases/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf

echo "Deployed $STAMP."
