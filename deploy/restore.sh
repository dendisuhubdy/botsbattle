#!/usr/bin/env bash
set -euo pipefail

# Usage: restore.sh <dump.sql.gz> [target-database]
# Defaults to a scratch database so a rehearsal cannot clobber production.

DUMP="${1:?usage: restore.sh <dump.sql.gz> [target-database]}"
[ -r "$DUMP" ] || { echo "cannot read $DUMP" >&2; exit 1; }

cd "$(dirname "$0")/.."
set -a; . ./.env.production; set +a

TARGET="${2:-botsbattle_restore_check}"

COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.production)

if [ "$TARGET" = "$POSTGRES_DB" ]; then
  echo "About to restore over the PRODUCTION database '$TARGET'."
  echo "Type 'restore-production' to continue:"
  read -r CONFIRM
  [ "$CONFIRM" = "restore-production" ] || { echo "aborted"; exit 1; }
fi

echo "==> creating $TARGET"
"${COMPOSE[@]}" exec -T db \
  psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$TARGET\";"
"${COMPOSE[@]}" exec -T db \
  psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"$TARGET\";"

echo "==> restoring"
gunzip -c "$DUMP" | "${COMPOSE[@]}" exec -T db \
  psql -U "$POSTGRES_USER" -d "$TARGET" -v ON_ERROR_STOP=1 >/dev/null

echo "==> verifying the ledger in the restored copy"
# Double-entry means every transaction must sum to zero and so must the whole ledger.
# A restore that produces a lopsided ledger is a corrupt restore, however cleanly psql exited.
"${COMPOSE[@]}" exec -T db \
  psql -U "$POSTGRES_USER" -d "$TARGET" -c \
  "SELECT COALESCE(SUM(amount),0) AS grand_total FROM ledger_entries;"

LOPSIDED=$("${COMPOSE[@]}" exec -T db \
  psql -U "$POSTGRES_USER" -d "$TARGET" -tAc \
  "SELECT COUNT(*) FROM (
     SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0
   ) AS unbalanced;")

if [ "${LOPSIDED//[$'\r\n ']/}" != "0" ]; then
  echo "RESTORE SUSPECT: $LOPSIDED transaction(s) do not sum to zero" >&2
  "${COMPOSE[@]}" exec -T db \
    psql -U "$POSTGRES_USER" -d "$TARGET" -c \
    "SELECT tx_id, SUM(amount) FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0;"
  exit 1
fi

echo "restored into $TARGET -- ledger balanced, no lopsided transactions"
