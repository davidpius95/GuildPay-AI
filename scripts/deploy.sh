#!/usr/bin/env bash
# Deploy GuildPay to the Guild Server (guildpay.guildserver.io).
#
# Best-practice guarantees:
#   • Only *committed* code is deployed — refuses a dirty working tree so prod
#     always equals a git commit (pass ALLOW_DIRTY=1 to override in an emergency).
#   • Ships only git-tracked files (via `git ls-files`); never server junk, never
#     `--delete` (so server-side secrets like .env.production are never touched).
#   • Copies the real secrets file to the server as .env.production (what
#     docker-compose.prod.yml reads), and records the deployed commit SHA.
#
# Auth: SSH keys are preferred. For the current password-auth box, export
#   SSHPASS=... and this script uses sshpass automatically.
#
# Usage:   ./scripts/deploy.sh
# Env overrides: GUILDPAY_SSH_HOST, GUILDPAY_SSH_PORT, GUILDPAY_REMOTE_DIR,
#                GUILDPAY_ENV_FILE, ALLOW_DIRTY, SSHPASS
set -euo pipefail

SSH_HOST="${GUILDPAY_SSH_HOST:-usher-node@143.105.102.121}"
SSH_PORT="${GUILDPAY_SSH_PORT:-5555}"
REMOTE_DIR="${GUILDPAY_REMOTE_DIR:-apps/guildpay}"   # relative to remote $HOME
ENV_FILE="${GUILDPAY_ENV_FILE:-.env.production}"
COMPOSE_FILE="docker-compose.prod.yml"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Use sshpass transparently when a password is provided; otherwise plain ssh (keys).
if [ -n "${SSHPASS:-}" ]; then
  export SSHPASS
  SSH="sshpass -e ssh -p $SSH_PORT -o StrictHostKeyChecking=accept-new"
  RSH="sshpass -e ssh -p $SSH_PORT -o StrictHostKeyChecking=accept-new"
  SCP="sshpass -e scp -P $SSH_PORT -o StrictHostKeyChecking=accept-new"
else
  SSH="ssh -p $SSH_PORT"
  RSH="ssh -p $SSH_PORT"
  SCP="scp -P $SSH_PORT"
fi

# 1. Guard: never deploy uncommitted code (prod must map to a git commit).
if [ "${ALLOW_DIRTY:-0}" != "1" ] && ! git diff --quiet HEAD --; then
  echo "✗ Working tree is dirty. Commit (and ideally push) first, or set ALLOW_DIRTY=1." >&2
  git status --short >&2
  exit 1
fi
SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE not found (local copy of the server secrets)"; exit 1; }

echo "→ deploying $BRANCH @ $SHA to $SSH_HOST:$REMOTE_DIR"
$SSH "$SSH_HOST" "mkdir -p $REMOTE_DIR"

# 2. Ship only tracked files (working tree == HEAD because we required a clean tree).
git ls-files -z > /tmp/guildpay-deploy-files.txt
rsync -az --from0 --files-from=/tmp/guildpay-deploy-files.txt -e "$RSH" \
  ./ "$SSH_HOST:$REMOTE_DIR/"

# 3. Secrets: land the real env as .env.production (what the prod compose reads).
echo "→ syncing $ENV_FILE → remote .env.production"
$SCP "$ENV_FILE" "$SSH_HOST:$REMOTE_DIR/.env.production"

# 4. Build the new images and switch containers over (build alone does not restart).
echo "→ build + up -d (this can take ~15–20 min on a cold build)"
$SSH "$SSH_HOST" "cd $REMOTE_DIR && \
  echo '$SHA ($BRANCH) '\$(date -u +%FT%TZ) > DEPLOYED_SHA.txt && \
  docker compose -f $COMPOSE_FILE build guildpay-api guildpay-dashboard && \
  docker compose -f $COMPOSE_FILE up -d"

# 5. Health check via the public host.
echo "→ health check"
sleep 5
if curl -fsS --max-time 20 https://guildpay.guildserver.io/health >/dev/null; then
  echo "✓ deployed $SHA — https://guildpay.guildserver.io/health ok"
else
  echo "✗ health check failed — inspect: $SSH $SSH_HOST 'docker logs guildpay-api'" >&2
  exit 1
fi
