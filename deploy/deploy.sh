#!/usr/bin/env bash
set -euo pipefail

# Run on the droplet as `deploy`.
#   bash deploy/deploy.sh            # pull, build, migrate, restart
#   bash deploy/deploy.sh --no-pull  # redeploy the checked-out tree (use when rolling back)

cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.production)

if [ "${1:-}" != "--no-pull" ]; then
  echo "==> pulling"
  git pull --ff-only origin main
fi

echo "==> building"
"${COMPOSE[@]}" build

echo "==> migrating"
# Migrations run in a one-off container before the new code starts serving. If this fails
# the deploy stops here, leaving the previous containers running rather than serving code
# against a schema that does not match it.
"${COMPOSE[@]}" run --rm --entrypoint node web dist/scripts/migrate.js

echo "==> starting"
"${COMPOSE[@]}" up -d

echo "==> status"
"${COMPOSE[@]}" ps
