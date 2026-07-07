#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/gpt-upi}"
BACKUP_DIR="${BACKUP_DIR:-/opt/gpt-upi-backups}"
REPO_URL="${REPO_URL:-git@github.com:your-org/gpt-upi.git}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
WEB_SERVICE="${WEB_SERVICE:-com.example.gpt-upi.web}"
BOT_SERVICE="${BOT_SERVICE:-com.example.gpt-upi.bot}"
EXTRACTOR_SERVICE="${EXTRACTOR_SERVICE:-com.example.gpt-upi.extractor}"
RESTART_EXTRACTOR="${RESTART_EXTRACTOR:-0}"
HEALTHCHECK_LOCAL="${HEALTHCHECK_LOCAL:-http://127.0.0.1:3001/}"
HEALTHCHECK_PUBLIC="${HEALTHCHECK_PUBLIC:-}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/gpt_upi_backup_${STAMP}.tgz"

export PATH="/usr/local/bin:/opt/homebrew/bin:${PATH}"

for bin in git node npm curl tar; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "$bin not found in PATH" >&2
    exit 1
  fi
done

mkdir -p "$BACKUP_DIR"
mkdir -p "$APP_DIR"

if [ -d "$APP_DIR" ] && [ "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 | head -n 1)" ]; then
  tar -czf "$BACKUP_FILE" \
    -C "$(dirname "$APP_DIR")" \
    --exclude="$(basename "$APP_DIR")/node_modules" \
    --exclude="$(basename "$APP_DIR")/.next" \
    --exclude="$(basename "$APP_DIR")/public/uploads" \
    --exclude="$(basename "$APP_DIR")/src/app/uploads" \
    "$(basename "$APP_DIR")"
  echo "backup:${BACKUP_FILE}"
fi

cd "$APP_DIR"

if [ ! -d .git ]; then
  git init
fi

git remote remove origin >/dev/null 2>&1 || true
git remote add origin "$REPO_URL"
git fetch --prune origin "$DEPLOY_BRANCH"
git reset --hard "origin/${DEPLOY_BRANCH}"
git clean -fd \
  -e .env \
  -e '.env.*' \
  -e node_modules/ \
  -e .next/ \
  -e public/uploads/ \
  -e src/app/uploads/

echo "commit:$(git rev-parse --short HEAD)"
echo "branch:${DEPLOY_BRANCH}"
echo "node:$(node -v)"
echo "npm:$(npm -v)"

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

npm run prisma:generate
npm run build

UID_VALUE="$(id -u)"
launchctl kickstart -k "gui/${UID_VALUE}/${WEB_SERVICE}"
launchctl kickstart -k "gui/${UID_VALUE}/${BOT_SERVICE}"
if [ "$RESTART_EXTRACTOR" = "1" ]; then
  launchctl kickstart -k "gui/${UID_VALUE}/${EXTRACTOR_SERVICE}"
else
  echo "extractor:skip-restart (set RESTART_EXTRACTOR=1 only when extraction worker code changes)"
fi

sleep 3
curl -fsS "$HEALTHCHECK_LOCAL" >/dev/null
if [ -n "$HEALTHCHECK_PUBLIC" ]; then
  curl -fsS "$HEALTHCHECK_PUBLIC" >/dev/null
fi

echo "deploy:ok"
launchctl print "gui/${UID_VALUE}/${WEB_SERVICE}" | grep -E "state|pid|last exit code" || true
launchctl print "gui/${UID_VALUE}/${BOT_SERVICE}" | grep -E "state|pid|last exit code" || true
launchctl print "gui/${UID_VALUE}/${EXTRACTOR_SERVICE}" | grep -E "state|pid|last exit code" || true
