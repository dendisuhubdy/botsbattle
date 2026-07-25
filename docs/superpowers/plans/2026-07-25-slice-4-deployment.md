# Slice 4 — Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the platform on a single DigitalOcean droplet at `https://botsfight.com` with automatic TLS, the signer isolated from the network, and a backup that has been proven by restoring it.

**Architecture:** Docker Compose with five services — `caddy`, `web`, `db`, `worker`, `signer`. Caddy terminates TLS and is the only service with published ports. `db` and `signer` are reachable only on the internal Docker network. The signer is the sole holder of the master seed and accepts no inbound connections at all.

**Tech Stack:** Docker, Docker Compose, Caddy 2, PostgreSQL 16, DigitalOcean, UFW.

> **This slice supersedes the spec's TLS section.** The design document specifies
> `<ip>.sslip.io` wildcard DNS with a Cloudflare Tunnel fallback, chosen because no domain was
> available. **botsfight.com** is now the production domain, so Caddy is configured for it
> directly and the sslip.io workaround is dropped entirely.

## Global Constraints

All constraints from Slices 1–3 still apply. In addition:

- **The signer and database publish no ports.** Only Caddy binds to the host.
- **UFW permits 22, 80, and 443 only.**
- **The master seed reaches only the signer container.** It must not appear in the `web` or `worker` environment, in the image, or in the repository.
- **Secrets are not baked into images** and are not committed. `.env` stays gitignored; the droplet holds its own copy with `chmod 600`.
- **Only operational float is kept hot.** The remainder belongs in separately controlled cold storage.
- **A backup that has not been restored is not a backup.** Task 6 restores one.
- Images are built for **linux/amd64** — a droplet is x86, and an Apple Silicon dev machine defaults to arm64.

## Accepted operational risks

Copied forward from the design document, unchanged and still true:

- A single droplet is a single point of failure; there is no HA story.
- The hot wallet key resides on that droplet.
- Nightly `pg_dump` shipped off the droplet, plus DigitalOcean snapshots.

## File Structure

| Path | Responsibility |
|---|---|
| `Dockerfile` | Multi-stage build producing the `web`, `worker`, and `signer` images |
| `docker-compose.prod.yml` | The five production services |
| `Caddyfile` | TLS termination and reverse proxy for `botsfight.com` |
| `deploy/bootstrap.sh` | One-time droplet preparation: Docker, UFW, users |
| `deploy/backup.sh` | Nightly `pg_dump` and off-droplet upload |
| `deploy/restore.sh` | Restore from a dump into a scratch database |
| `docs/runbook.md` | Operational procedures |

---

## Task 1: Production Dockerfile

**Files:**
- Create: `Dockerfile`, `.dockerignore` (extend)
- Modify: `next.config.mjs` (standalone output)

**Interfaces:**
- Produces: one image with three entrypoints — `node server.js` (web), `node worker/main.js` (worker), `node signer/main.js` (signer)

Next's standalone output keeps the web image small. The worker and signer are plain Node
processes compiled from the same source tree.

- [ ] **Step 1: Enable standalone output**

In `next.config.mjs`:

```js
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['pg', '@node-rs/argon2'],
}
```

- [ ] **Step 2: Write the Dockerfile**

`Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# The worker and signer are plain Node programs; compile them separately from Next.
RUN pnpm exec tsc --project tsconfig.server.json

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app

COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/migrations ./migrations
COPY --from=deps   --chown=app:app /app/node_modules ./node_modules

USER app
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 3: Add the server tsconfig**

Next compiles the app; the worker and signer need their own emit. `tsconfig.server.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["worker/**/*.ts", "signer/**/*.ts", "scripts/**/*.ts", "src/lib/**/*.ts"],
  "exclude": ["node_modules", "tests"]
}
```

Because the emitted files use the `@/*` alias, add a runtime resolver. The simplest reliable
option is to import through relative paths in `worker/main.ts` and `signer/main.ts` — which
they already do — and to ensure `src/lib` modules do the same. Verify with:

```bash
grep -rn "from '@/" src/lib | head
```

If any `src/lib` module imports via `@/`, either convert those to relative imports or add
`tsc-alias` to the build:

```bash
pnpm add -D tsc-alias
```

and change the build step to `pnpm exec tsc -p tsconfig.server.json && pnpm exec tsc-alias -p tsconfig.server.json`.

Decide this once, apply it consistently, and record which option was chosen in `docs/runbook.md`.

- [ ] **Step 4: Extend `.dockerignore`**

```
node_modules
.next
.git
.env
dist
docs
tests
```

- [ ] **Step 5: Build and verify locally**

```bash
docker build --platform linux/amd64 -t botsbattle:test .
docker run --rm botsbattle:test node --version
docker run --rm botsbattle:test ls dist/worker dist/signer
```

Expected: the build succeeds and `dist/worker/main.js` and `dist/signer/main.js` exist. If the
second command fails, the server tsconfig is not emitting what the compose file will run —
fix it now rather than discovering it on the droplet.

- [ ] **Step 6: Confirm no secrets are in the image**

```bash
docker run --rm botsbattle:test sh -c 'env | grep -i -E "mnemonic|seed|password|api_key" || echo "no secrets in env"'
docker run --rm botsbattle:test sh -c 'test -f .env && echo "LEAKED .env" || echo "no .env in image"'
```

Expected: `no secrets in env` and `no .env in image`. Anything else is a stop-and-fix.

- [ ] **Step 7: Commit and push**

```bash
git add Dockerfile tsconfig.server.json .dockerignore next.config.mjs package.json
git commit -m "build: production Dockerfile with standalone web and compiled worker/signer"
git push origin main
```

---

## Task 2: Compose stack and Caddy

**Files:**
- Create: `docker-compose.prod.yml`, `Caddyfile`, `.env.production.example`

**Interfaces:**
- Produces: five services; only `caddy` publishes ports

- [ ] **Step 1: Write the Caddyfile**

`Caddyfile`. Caddy obtains and renews a Let's Encrypt certificate for `botsfight.com`
automatically, provided the A record points at the droplet and ports 80/443 are open.

```
{
	email admin@botsfight.com
}

botsfight.com, www.botsfight.com {
	encode zstd gzip

	# HSTS. Only safe because every path is served over TLS.
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
	}

	reverse_proxy web:3000
}
```

- [ ] **Step 2: Write the compose file**

`docker-compose.prod.yml`. Note what is *absent*: `db` and `signer` have no `ports` key at all,
so they are unreachable from outside the Docker network.

```yaml
name: botsbattle

x-app: &app
  build:
    context: .
    dockerfile: Dockerfile
  image: botsbattle:latest
  restart: unless-stopped
  depends_on:
    db:
      condition: service_healthy

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - web

  web:
    <<: *app
    command: ["node", "server.js"]
    environment:
      NODE_ENV: production
      HOSTNAME: 0.0.0.0
      PORT: 3000
      DATABASE_URL: ${DATABASE_URL}
      TRON_NETWORK: ${TRON_NETWORK}
      TRON_FULL_HOST: ${TRON_FULL_HOST}
      TRONGRID_API_KEY: ${TRONGRID_API_KEY}
      TRON_USDT_CONTRACT: ${TRON_USDT_CONTRACT}
      TRON_HOT_WALLET_ADDRESS: ${TRON_HOT_WALLET_ADDRESS}
      TRON_XPUB: ${TRON_XPUB}
      TRON_CONFIRMATIONS: ${TRON_CONFIRMATIONS}
      TRON_SWEEP_MIN_MICROS: ${TRON_SWEEP_MIN_MICROS}
      TOTP_ENCRYPTION_KEY: ${TOTP_ENCRYPTION_KEY}
      # TRON_MNEMONIC is deliberately absent.

  worker:
    <<: *app
    command: ["node", "dist/worker/main.js"]
    environment:
      NODE_ENV: production
      DATABASE_URL: ${DATABASE_URL}
      TRON_NETWORK: ${TRON_NETWORK}
      TRON_FULL_HOST: ${TRON_FULL_HOST}
      TRONGRID_API_KEY: ${TRONGRID_API_KEY}
      TRON_USDT_CONTRACT: ${TRON_USDT_CONTRACT}
      TRON_HOT_WALLET_ADDRESS: ${TRON_HOT_WALLET_ADDRESS}
      TRON_XPUB: ${TRON_XPUB}
      TRON_CONFIRMATIONS: ${TRON_CONFIRMATIONS}
      TRON_SWEEP_MIN_MICROS: ${TRON_SWEEP_MIN_MICROS}
      WORKER_INTERVAL_MS: ${WORKER_INTERVAL_MS:-15000}
      # TRON_MNEMONIC is deliberately absent; worker/main.ts refuses to start if it is set.

  signer:
    <<: *app
    command: ["node", "dist/signer/main.js"]
    environment:
      NODE_ENV: production
      DATABASE_URL: ${DATABASE_URL}
      TRON_NETWORK: ${TRON_NETWORK}
      TRON_FULL_HOST: ${TRON_FULL_HOST}
      TRONGRID_API_KEY: ${TRONGRID_API_KEY}
      TRON_USDT_CONTRACT: ${TRON_USDT_CONTRACT}
      TRON_HOT_WALLET_ADDRESS: ${TRON_HOT_WALLET_ADDRESS}
      TRON_XPUB: ${TRON_XPUB}
      TRON_CONFIRMATIONS: ${TRON_CONFIRMATIONS}
      TRON_SWEEP_MIN_MICROS: ${TRON_SWEEP_MIN_MICROS}
      SIGNER_INTERVAL_MS: ${SIGNER_INTERVAL_MS:-5000}
      TRON_MNEMONIC: ${TRON_MNEMONIC}

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  pgdata:
  caddy_data:
  caddy_config:
```

- [ ] **Step 3: Write the production env template**

`.env.production.example`:

```
# --- database (internal to the compose network) ---
POSTGRES_USER=botsbattle
POSTGRES_PASSWORD=
POSTGRES_DB=botsbattle
DATABASE_URL=postgres://botsbattle:CHANGEME@db:5432/botsbattle

# --- Tron (mainnet) ---
TRON_NETWORK=mainnet
TRON_FULL_HOST=https://api.trongrid.io
TRONGRID_API_KEY=
TRON_USDT_CONTRACT=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
TRON_HOT_WALLET_ADDRESS=
TRON_XPUB=
TRON_CONFIRMATIONS=19
TRON_SWEEP_MIN_MICROS=20000000

# --- secrets ---
TOTP_ENCRYPTION_KEY=
# Signer container only. Never place this anywhere the web or worker can read.
TRON_MNEMONIC=

WORKER_INTERVAL_MS=15000
SIGNER_INTERVAL_MS=5000
```

`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` is the mainnet USDT contract, confirmed against TronGrid
during Slice 2 planning. It is **not** valid on Nile.

- [ ] **Step 4: Verify the isolation locally**

Bring the stack up on the dev machine with a throwaway `.env.production`, then prove the
isolation claims rather than assuming them:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml ps
```

```bash
# Only caddy may publish ports.
docker compose -f docker-compose.prod.yml ps --format '{{.Service}}\t{{.Ports}}'
```

Expected: ports listed for `caddy` only; `db`, `web`, `worker`, and `signer` show none.

```bash
# The seed must exist in exactly one container.
for s in web worker signer; do
  echo -n "$s: "
  docker compose -f docker-compose.prod.yml exec -T $s sh -c \
    '[ -n "$TRON_MNEMONIC" ] && echo HAS_SEED || echo no-seed'
done
```

Expected: `web: no-seed`, `worker: no-seed`, `signer: HAS_SEED`. Any other result is a
stop-and-fix — it is the single most important property of this deployment.

- [ ] **Step 5: Commit and push**

```bash
git add docker-compose.prod.yml Caddyfile .env.production.example
git commit -m "build: production compose stack with isolated signer and Caddy TLS"
git push origin main
```

---

## Task 3: Droplet bootstrap

**Files:**
- Create: `deploy/bootstrap.sh`

**Prerequisites:**
- A DigitalOcean droplet, 4 GB RAM minimum, Ubuntu 24.04
- An SSH key added to the droplet
- `botsfight.com` DNS: an `A` record for `@` and `www` pointing at the droplet's IPv4 address

- [ ] **Step 1: Point DNS at the droplet and verify before anything else**

Certificate issuance fails if DNS has not propagated, and Let's Encrypt rate-limits repeated
failures. Check first:

```bash
dig +short botsfight.com
dig +short www.botsfight.com
```

Expected: both return the droplet's IP. Do not proceed until they do.

- [ ] **Step 2: Write the bootstrap script**

`deploy/bootstrap.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# One-time droplet preparation. Run as root on a fresh Ubuntu 24.04 droplet.

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

echo "==> packages"
apt-get update
apt-get install -y ca-certificates curl gnupg ufw postgresql-client

echo "==> docker"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> deploy user"
if ! id deploy >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" deploy
  usermod -aG docker deploy
  mkdir -p /home/deploy/.ssh
  cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
  chown -R deploy:deploy /home/deploy/.ssh
  chmod 700 /home/deploy/.ssh
  chmod 600 /home/deploy/.ssh/authorized_keys
fi

echo "==> firewall"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> hardening sshd"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

echo "==> unattended security updates"
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo
echo "bootstrap complete"
ufw status verbose
```

Disabling root SSH login is the last step for a reason: if the `deploy` user's key was copied
incorrectly, you still have the root session open to fix it. **Do not close that session until
you have confirmed `ssh deploy@botsfight.com` works in a second terminal.**

- [ ] **Step 3: Run it**

```bash
scp deploy/bootstrap.sh root@botsfight.com:/tmp/
ssh root@botsfight.com 'bash /tmp/bootstrap.sh'
```

- [ ] **Step 4: Verify the firewall and the deploy user, keeping the root session open**

In a second terminal:

```bash
ssh deploy@botsfight.com 'docker --version && docker compose version && sudo -n true 2>/dev/null; ufw status'
```

Expected: Docker responds and UFW shows exactly 22, 80, and 443 allowed. Only once this
succeeds, close the root session.

- [ ] **Step 5: Commit and push**

```bash
git add deploy/bootstrap.sh
git commit -m "ops: droplet bootstrap script"
git push origin main
```

---

## Task 4: First deploy

**Files:**
- Create: `deploy/deploy.sh`

- [ ] **Step 1: Write the deploy script**

`deploy/deploy.sh`, run on the droplet as `deploy`:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /home/deploy/botsbattle

echo "==> pulling"
git pull --ff-only origin main

echo "==> building"
docker compose -f docker-compose.prod.yml --env-file .env.production build

echo "==> migrating"
# Migrations run in a one-off container before the new code starts serving.
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  --entrypoint node web dist/scripts/migrate.js

echo "==> starting"
docker compose -f docker-compose.prod.yml --env-file .env.production up -d

echo "==> status"
docker compose -f docker-compose.prod.yml ps
```

- [ ] **Step 2: Clone and configure on the droplet**

```bash
ssh deploy@botsfight.com
git clone https://github.com/dendisuhubdy/botsbattle.git
cd botsbattle
cp .env.production.example .env.production
chmod 600 .env.production
```

Fill in `.env.production`. Generate the secrets on the droplet, not locally:

```bash
openssl rand -hex 32   # TOTP_ENCRYPTION_KEY
openssl rand -hex 24   # POSTGRES_PASSWORD
```

For `TRON_MNEMONIC`, use the production wallet's phrase. **Only operational float belongs in
this hot wallet** — the remainder stays in separately controlled cold storage.

- [ ] **Step 3: Verify the seed matches the xpub before starting**

The signer refuses to start on a mismatch, but finding out now is cheaper:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  --entrypoint node signer -e "
    import('./dist/lib/signer/keys.js').then(async (k) => {
      const seed = k.loadSignerSeed()
      k.assertMatchesXpub(seed, process.env.TRON_XPUB)
      console.log('seed matches xpub')
    })
  "
```

Adjust the import path to wherever `tsconfig.server.json` actually emitted the module. If it
throws, **stop** — deposits would be sent to addresses this signer cannot spend.

- [ ] **Step 4: Deploy**

```bash
bash deploy/deploy.sh
```

- [ ] **Step 5: Verify TLS**

```bash
curl -sI https://botsfight.com | head -5
curl -s https://botsfight.com | head -c 200
```

Expected: `HTTP/2 200` and the fight list page. If Caddy failed to obtain a certificate:

```bash
docker compose -f docker-compose.prod.yml logs caddy | tail -40
```

The usual causes are DNS not yet propagated or port 80 blocked. Fix the cause; do not disable
TLS.

- [ ] **Step 6: Verify the certificate and security headers**

```bash
echo | openssl s_client -connect botsfight.com:443 -servername botsfight.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
curl -sI https://botsfight.com | grep -i -E 'strict-transport|x-frame|x-content'
```

Expected: a Let's Encrypt certificate for `botsfight.com` with a future expiry, and all three
headers present.

- [ ] **Step 7: Confirm the database and signer are not reachable from outside**

```bash
# From your laptop, not the droplet.
nc -zv -w 5 botsfight.com 5432 || echo "postgres correctly unreachable"
nmap -Pn -p 22,80,443,3000,5432 botsfight.com
```

Expected: 22, 80, and 443 open; 3000 and 5432 closed or filtered.

- [ ] **Step 8: Create the first admin**

```bash
ssh deploy@botsfight.com
cd botsbattle
# Sign up through the website first, then:
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  --entrypoint node web dist/scripts/make-admin.js you@example.com
```

- [ ] **Step 9: Commit and push**

```bash
git add deploy/deploy.sh
git commit -m "ops: deploy script with pre-start migrations"
git push origin main
```

---

## Task 5: Backups

**Files:**
- Create: `deploy/backup.sh`, `deploy/restore.sh`

A backup that has never been restored is a guess. Task 6 restores one.

- [ ] **Step 1: Write the backup script**

`deploy/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Nightly logical backup. Run from /home/deploy/botsbattle via cron.

cd /home/deploy/botsbattle
set -a; . ./.env.production; set +a

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_DIR=/home/deploy/backups
OUT="$OUT_DIR/botsbattle-$STAMP.sql.gz"
mkdir -p "$OUT_DIR"

docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  | gzip -9 > "$OUT"

# A dump that is suspiciously small usually means pg_dump failed and gzip wrote a header.
SIZE=$(stat -c%s "$OUT")
if [ "$SIZE" -lt 1024 ]; then
  echo "backup $OUT is only $SIZE bytes — treating as failed" >&2
  exit 1
fi

echo "wrote $OUT ($SIZE bytes)"

# Ship it off the droplet. A backup that only exists on the machine it protects is not one.
if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copy "$OUT" "$BACKUP_REMOTE" && echo "uploaded to $BACKUP_REMOTE"
else
  echo "BACKUP_REMOTE not set — backup is LOCAL ONLY and does not protect against droplet loss" >&2
fi

# Keep 14 days locally.
find "$OUT_DIR" -name 'botsbattle-*.sql.gz' -mtime +14 -delete
```

- [ ] **Step 2: Write the restore script**

`deploy/restore.sh`. It restores into a *scratch* database by default, so a rehearsal cannot
destroy production:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: restore.sh <dump.sql.gz> [target-database]
# Defaults to a scratch database so a rehearsal cannot clobber production.

DUMP="${1:?usage: restore.sh <dump.sql.gz> [target-database]}"
cd /home/deploy/botsbattle
set -a; . ./.env.production; set +a

TARGET="${2:-botsbattle_restore_check}"

if [ "$TARGET" = "$POSTGRES_DB" ]; then
  echo "About to restore over the PRODUCTION database '$TARGET'."
  echo "Type 'restore-production' to continue:"
  read -r CONFIRM
  [ "$CONFIRM" = "restore-production" ] || { echo "aborted"; exit 1; }
fi

echo "==> creating $TARGET"
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$TARGET\";"
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"$TARGET\";"

echo "==> restoring"
gunzip -c "$DUMP" | docker compose -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$TARGET" -v ON_ERROR_STOP=1

echo "==> verifying the ledger in the restored copy"
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$TARGET" -c \
  "SELECT COALESCE(SUM(amount),0) AS grand_total FROM ledger_entries;"
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$TARGET" -c \
  "SELECT tx_id, SUM(amount) FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0;"

echo "restored into $TARGET"
```

- [ ] **Step 3: Schedule it**

```bash
ssh deploy@botsfight.com
chmod +x ~/botsbattle/deploy/backup.sh ~/botsbattle/deploy/restore.sh
crontab -e
```

Add:

```
17 3 * * * /home/deploy/botsbattle/deploy/backup.sh >> /home/deploy/backup.log 2>&1
```

- [ ] **Step 4: Enable DigitalOcean snapshots**

In the DigitalOcean control panel, enable weekly backups for the droplet. This covers the
volume; `pg_dump` covers the data. Neither substitutes for the other.

- [ ] **Step 5: Commit and push**

```bash
git add deploy/backup.sh deploy/restore.sh
git commit -m "ops: nightly pg_dump backup and scratch-database restore"
git push origin main
```

---

## Task 6: Prove the deployment

Nothing here is new code. It is the evidence that what was built actually works, and it is the
part most likely to be skipped.

**Files:**
- Create: `docs/runbook.md`, `docs/superpowers/plans/slice-4-walkthrough.md`

- [ ] **Step 1: Run a real backup and restore it**

```bash
ssh deploy@botsfight.com
cd botsbattle
bash deploy/backup.sh
ls -la ~/backups/
bash deploy/restore.sh ~/backups/$(ls -t ~/backups | head -1)
```

Expected: the restore completes and reports `grand_total` of `0` with no lopsided
transactions. Record the actual output. If the restore fails, the backup strategy does not
exist yet regardless of what the script says.

- [ ] **Step 2: Verify each service recovers from a restart**

```bash
docker compose -f docker-compose.prod.yml restart worker signer
sleep 20
docker compose -f docker-compose.prod.yml logs --tail 20 worker
docker compose -f docker-compose.prod.yml logs --tail 20 signer
```

Expected: both resume polling without manual intervention and without errors. Confirm the
signer logged its xpub match at startup.

- [ ] **Step 3: Verify the droplet reboots cleanly**

```bash
ssh deploy@botsfight.com 'sudo reboot' || true
sleep 90
curl -sI https://botsfight.com | head -3
ssh deploy@botsfight.com 'cd botsbattle && docker compose -f docker-compose.prod.yml ps'
```

Expected: the site is back without anyone logging in, because every service is
`restart: unless-stopped`. This is the test that catches a stack which only ever worked
because someone started it by hand.

- [ ] **Step 4: Run one small real-money end-to-end transaction**

On mainnet, with an amount you are willing to lose:

1. Sign up, get a deposit address, send a small USDT amount
2. Watch it credit after 19 confirmations
3. Place a bet on a test fight, settle it
4. Enrol in TOTP, request a withdrawal, approve it, watch it confirm
5. Run reconciliation:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
  --entrypoint node web dist/scripts/reconcile.js
```

Expected: `balanced`. Record every observed figure.

- [ ] **Step 5: Write the runbook**

`docs/runbook.md`, covering at minimum:

- How to deploy (`deploy/deploy.sh`) and how to roll back (`git checkout <sha> && deploy.sh`)
- How to read logs per service
- What to do when reconciliation reports a difference: stop the signer first, then investigate
- What to do when a `signer_jobs` row is `FAILED`
- What to do when a deposit has not credited: check confirmations, check the worker log,
  check that the address is in `deposit_addresses`
- How to lock an account (`users.withdrawal_locked`)
- How to restore from backup, including the production-restore confirmation phrase
- Which alias strategy Task 1 Step 3 settled on
- Cold storage policy: how much float stays hot and who holds the remainder

- [ ] **Step 6: Write the walkthrough**

`docs/superpowers/plans/slice-4-walkthrough.md` recording observed values: the certificate
issuer and expiry, the `nmap` output, the per-container seed check, the backup size, the
restore verification output, the reboot recovery time, and the real-money transaction figures.

**No secrets in either document.**

- [ ] **Step 7: Commit and push**

```bash
git add docs/runbook.md docs/superpowers/plans/slice-4-walkthrough.md
git commit -m "docs: runbook and Slice 4 deployment walkthrough"
git push origin main
```

---

## Done when

- `https://botsfight.com` serves the site with a valid Let's Encrypt certificate
- `nmap` shows only 22, 80, and 443 reachable
- `TRON_MNEMONIC` is present in the `signer` container and in no other
- A backup has been taken **and restored**, with the restored ledger summing to zero
- The droplet survives a reboot with no manual intervention
- One real end-to-end transaction completed and reconciliation reports `balanced`
- `docs/runbook.md` exists and describes rollback and the reconciliation-failure procedure

## Deliberately not in this slice

High availability, horizontal scaling, log aggregation, metrics and alerting, CI/CD, KYC, and
geo-restriction. Geo-restriction, if it becomes necessary, belongs at the Caddy layer.

## A closing note on scope

This platform takes custody of other people's money, and real-money betting is a licensed
activity in most jurisdictions. USDT settlement does not change that. Nothing in Slices 1–4
implements KYC, AML, or licensing; the seams exist (`users.verification_status`,
`users.withdrawal_locked`, and a human approval step on every withdrawal) but the obligations
do not go away because the code has a place to put them later. Get advice appropriate to the
jurisdictions you intend to serve before accepting deposits from the public.