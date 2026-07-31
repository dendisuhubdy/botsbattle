#!/usr/bin/env bash
set -euo pipefail

# Nightly logical backup. Run from /home/deploy/botsbattle via cron.

cd "$(dirname "$0")/.."
set -a; . ./.env.production; set +a

# rclone is installed to ~/bin because the deploy user has no sudo. cron runs with
# PATH=/usr/bin:/bin, so without this the upload silently falls through to the
# "LOCAL ONLY" branch every night while the interactive test keeps passing.
PATH="$HOME/bin:$PATH"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_DIR=/home/deploy/backups
OUT="$OUT_DIR/botsbattle-$STAMP.sql.gz"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.production)

# `set -o pipefail` matters here: without it a pg_dump failure is masked by gzip's
# successful exit and the size check below becomes the only line of defence.
"${COMPOSE[@]}" exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  | gzip -9 > "$OUT"

chmod 600 "$OUT"

# A dump that is suspiciously small usually means pg_dump failed and gzip wrote a header.
SIZE=$(stat -c%s "$OUT")
if [ "$SIZE" -lt 1024 ]; then
  echo "backup $OUT is only $SIZE bytes -- treating as failed" >&2
  exit 1
fi

echo "wrote $OUT ($SIZE bytes)"

# Ship it off the droplet. A backup that only exists on the machine it protects is not one:
# it does not survive the droplet being destroyed, which is the case it exists for.
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$OUT" "$BACKUP_REMOTE" && echo "uploaded to $BACKUP_REMOTE"
else
  echo "BACKUP_REMOTE not set -- backup is LOCAL ONLY and does not protect against droplet loss" >&2
fi

# Keep 14 days locally.
find "$OUT_DIR" -name 'botsbattle-*.sql.gz' -mtime +14 -delete
