#!/usr/bin/env bash
set -euo pipefail

# Run on the droplet as `deploy`.
#   bash deploy/deploy.sh            # pull, build, migrate, restart
#   bash deploy/deploy.sh --no-pull  # redeploy the checked-out tree (use when rolling back)

# Everything lives in main(), called on the last line, so bash parses the whole file before
# running any of it. This script `git pull`s itself, and bash otherwise reads a script
# incrementally by byte offset -- rewriting it mid-run can splice old and new bytes into
# something neither version says. That is undefined behaviour, and it silently produced a
# deploy that ran the previous logic on 1 August 2026.
#
# Consequence worth knowing: a change to this file takes effect on the NEXT deploy, not the
# one that pulls it. That is now deterministic rather than a race. To apply a deploy.sh
# change immediately, run it twice, or pull by hand and use --no-pull.
main() {
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
  # The signer is the one container holding spending material, and it fails fast when
  # TRON_MNEMONIC is unset. A blanket `up -d` therefore starts a container that can only
  # crash-loop under `restart: unless-stopped`, burning CPU and flooding the logs.
  #
  # So start it only once a mnemonic exists. Deciding here rather than with a compose
  # `profiles:` key is deliberate: a profile would have to be opted into on the command
  # line, which turns this into the opposite and worse bug -- a funded signer that silently
  # never starts, so withdrawals are approved and never broadcast.
  #
  # The emptiness test strips quotes and whitespace first: compose unquotes env-file values,
  # so a literal `TRON_MNEMONIC=""` means empty to it, and a plain `grep -q .+` would read
  # those two quote characters as a mnemonic. Stripping whitespace is safe here because the
  # value is only tested for emptiness, never used -- a real BIP39 phrase is all spaces.
  local SERVICES MNEMONIC
  SERVICES=(db caddy web worker)
  MNEMONIC=$(sed -n 's/^TRON_MNEMONIC=//p' .env.production | head -n1)
  MNEMONIC=${MNEMONIC//[\"\']/}
  MNEMONIC=${MNEMONIC//[[:space:]]/}

  if [ -n "$MNEMONIC" ]; then
    SERVICES+=(signer)
  else
    echo "    TRON_MNEMONIC is empty -- skipping signer (withdrawals cannot be broadcast)"
    # Clear out a signer left behind by an older deploy, so the steady state after this
    # script is the same whether or not one was running when it started.
    "${COMPOSE[@]}" rm -sf signer >/dev/null 2>&1 || true
  fi

  "${COMPOSE[@]}" up -d "${SERVICES[@]}"

  echo "==> status"
  "${COMPOSE[@]}" ps
}

main "$@"
