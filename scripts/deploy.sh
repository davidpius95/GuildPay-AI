#!/usr/bin/env bash
# Deploy GuildPay to the Guild Server (guildpay.guildserver.io).
#
# Prereqs: SSH key access to the server (recommended over passwords) and Docker on the box.
# Usage:   ./scripts/deploy.sh
# Override via env: GUILDPAY_SSH_HOST, GUILDPAY_SSH_PORT, GUILDPAY_REMOTE_DIR, GUILDPAY_ENV_FILE
set -euo pipefail

SSH_HOST="${GUILDPAY_SSH_HOST:-usher-node@143.105.102.121}"
SSH_PORT="${GUILDPAY_SSH_PORT:-5555}"
REMOTE_DIR="${GUILDPAY_REMOTE_DIR:-apps/guildpay}"   # relative to remote $HOME
ENV_FILE="${GUILDPAY_ENV_FILE:-.env.production}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE not found (server env with real secrets)"; exit 1; }

echo "→ syncing repo to $SSH_HOST:$REMOTE_DIR"
ssh -p "$SSH_PORT" "$SSH_HOST" "mkdir -p $REMOTE_DIR"
rsync -az --delete -e "ssh -p $SSH_PORT" \
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude '.next' \
  --exclude 'coverage' --exclude '.env' --exclude '.env.*' --exclude 'files.zip' \
  --exclude 'supabase/.branches' --exclude 'supabase/.temp' \
  ./ "$SSH_HOST:$REMOTE_DIR/"

echo "→ copying $ENV_FILE → remote .env (secrets; never committed)"
scp -P "$SSH_PORT" "$ENV_FILE" "$SSH_HOST:$REMOTE_DIR/.env"

echo "→ build + (re)start containers"
ssh -p "$SSH_PORT" "$SSH_HOST" "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml up -d --build"

echo "→ health check"
sleep 5
if curl -fsS --max-time 20 https://guildpay.guildserver.io/health; then
  echo " ✓ deployed"
else
  echo " ✗ health check failed — check: docker logs guildpay-api"
  exit 1
fi
