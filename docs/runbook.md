# Runbook

## Production deployment

- Host: DigitalOcean droplet `botsfight`, `s-4vcpu-8gb`, region `sgp1`, Ubuntu 24.04.
- Checkout: `/home/deploy/botsbattle`, deployed as the `deploy` user.
- DNS: `botsfight.com` and `www` are **A records on Cloudflare with the proxy OFF**
  (grey cloud). This is load-bearing: Caddy obtains its certificate over HTTP-01, and an
  orange-cloud proxy intercepts that challenge and terminates TLS itself. If certificates
  stop renewing, check the proxy status first.
  The `MX`, SPF, and Resend/SES `TXT` records on this zone belong to email and must not be
  touched when repointing the site.

### Deploy and roll back

```bash
ssh deploy@botsfight.com
cd botsbattle
bash deploy/deploy.sh                       # pull, build, migrate, restart
```

To roll back, check out the previous commit and redeploy without pulling:

```bash
git checkout <sha>
bash deploy/deploy.sh --no-pull
```

Migrations run in a one-off container *before* the new code serves. A failed migration
aborts the deploy with the previous containers still running, rather than serving new code
against an old schema. Migrations are not automatically reversed on rollback — if the
rolled-back code cannot read the newer schema, restore from backup instead.

### Logs

```bash
cd ~/botsbattle
C="docker compose -f docker-compose.prod.yml --env-file .env.production"
$C ps
$C logs --tail 50 web
$C logs --tail 50 worker
$C logs --tail 50 signer
$C logs --tail 50 caddy      # certificate issuance and renewal live here
```

### Enabling the signer

The signer is the only component that holds spending material, and it is the only service
that will not start without it. `TRON_MNEMONIC` is empty in `.env.production` until the
seed holder fills it in, so the signer is deliberately **not** running: sweeps are not
executed and approved withdrawals are not broadcast. Deposits still credit and bets still
settle, because those are watch-only and ledger-internal.

To enable it, on the droplet only:

```bash
cd ~/botsbattle
nano .env.production                 # set TRON_MNEMONIC, save
docker compose -f docker-compose.prod.yml --env-file .env.production up -d signer
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f signer
```

Expect two lines at startup:

```
[signer] seed matches TRON_XPUB
[signer] hot wallet index matches TRON_HOT_WALLET_ADDRESS
```

If either assertion throws, **stop**. The first means the seed and the published xpub are
different wallets, so deposits are going to addresses this signer cannot spend. The second
means `TRON_HOT_WALLET_INDEX` does not derive `TRON_HOT_WALLET_ADDRESS`, so withdrawals
would be signed from a different, probably unfunded, address.

Never place `TRON_MNEMONIC` in the `web` or `worker` environment. `worker/main.ts` refuses
to start if it is set, and `docker-compose.prod.yml` omits it from both deliberately.

### Derivation indices

Index 0 is **reserved for the hot wallet**. User deposit addresses are allocated from 1
upward (`assignDepositAddress`). Do not set `TRON_HOT_WALLET_INDEX` to any index a
depositor could be assigned: the hot wallet would become someone's deposit address, their
deposit would be indistinguishable from float, and `enqueueSweeps` would queue a sweep from
the hot wallet to itself.

### When reconciliation reports a difference

```bash
cd ~/botsbattle
C="docker compose -f docker-compose.prod.yml --env-file .env.production"
$C stop signer          # FIRST -- stop anything that can move money
$C run --rm --entrypoint node web dist/scripts/reconcile.js
```

Stop the signer before investigating, not after. Then compare `onChainMicros` against
`ledgerCustodyMicros`; admin credits are reported separately so they do not read as
corruption. Do not restart the signer until the difference is explained.

### When a `signer_jobs` row is FAILED

Read the job's error, then decide whether it is retryable. A broadcast failure may be
transient (rate limits, insufficient TRX for energy); an unknown job kind is parked as
FAILED on purpose and needs code, not a retry.

### When a deposit has not credited

1. Check the transfer has `TRON_CONFIRMATIONS` (19) confirmations — nothing credits before.
2. Check the address is in `deposit_addresses`; a transfer to an address we do not own is
   ignored by design.
3. Read the worker log for the poll cycle.
4. Without a `TRONGRID_API_KEY`, TronGrid rate-limits aggressively and the poller may be
   falling behind. Setting a key is the fix.

### Locking an account

Set `users.withdrawal_locked` for the user. Withdrawal requests are refused while set;
deposits and betting are unaffected.

### Restoring from backup

See `deploy/restore.sh`. It restores into a scratch database by default so a rehearsal
cannot clobber production. Restoring over production requires typing the confirmation
phrase `restore-production`.

## Production Docker image

The production image (`Dockerfile`) builds three entrypoints from one source tree:

- web: `node server.js` (Next.js standalone output)
- worker: `node dist/worker/main.js`
- signer: `node dist/signer/main.js`

Next compiles the web app itself. The worker and signer are plain Node/TypeScript
programs with no bundler, so they're compiled separately with `tsc` via
`tsconfig.server.json`, emitting to `dist/` (mirroring the source layout, e.g.
`worker/main.ts` -> `dist/worker/main.js`, `src/lib/db/client.ts` ->
`dist/src/lib/db/client.js`).

### `@/*` alias resolution: `tsc-alias`, not relative rewrites

`worker/main.ts` and `signer/main.ts` already import `src/lib` via relative paths
(`../src/lib/...`), but `src/lib` internally has 55 imports written through the
`@/*` tsconfig path alias (e.g. `import { x } from '@/lib/tron/address'`). `tsc`
type-checks path aliases but does not rewrite them at emit time, so a plain
`tsc -p tsconfig.server.json` produces JS files with the literal specifier
`'@/lib/tron/address'`, which Node's module resolver cannot find
(`Cannot find package '@/lib'`).

Two ways to fix this were considered:

1. Convert `src/lib`'s `@/` imports to relative paths.
2. Add `tsc-alias` as a post-processing step that rewrites the alias imports to
   relative paths in the compiled output.

**Decision: `tsc-alias`.** Rewriting 55 imports across `src/lib` by hand is a large,
unrelated refactor with real risk of introducing mistakes for no functional gain —
the alias exists precisely so application code doesn't need to hand-maintain
relative paths. `tsc-alias` solves the same problem mechanically as a build step:

```json
"build:server": "tsc -p tsconfig.server.json && tsc-alias -p tsconfig.server.json -f"
```

### The `-f` (`--resolve-full-paths`) flag is required, not optional

Running `tsc-alias` without `-f` only gets you halfway. By default it rewrites
`@/lib/tron/address` to `../../lib/tron/address` but does **not** append a file
extension. Because the repo is ESM (`"type": "module"` in `package.json`) and
`tsconfig.server.json` targets `"module": "ESNext"` / `"moduleResolution": "bundler"`,
`tsc` emits relative import specifiers exactly as written in the source — no `.js` is
ever added, whether the specifier came from an alias or was already relative
(e.g. `worker/main.ts`'s `import { createDb } from '../src/lib/db/client'`). Node's
ESM loader requires an explicit extension on relative specifiers, so any
extension-less relative import fails at runtime with
`ERR_MODULE_NOT_FOUND`, even after tsc-alias has "fixed" the alias.

`tsc-alias -f` appends `.js` to every relative specifier it touches — both the
alias-derived ones and plain relative ones already present in the source. This was
verified directly: compiling without `-f` and running
`node -e "import('./dist/src/lib/signer/keys.js')"` fails with
`Cannot find module '.../dist/src/lib/tron/address'`; compiling with `-f` resolves
and loads correctly, including the native/heavy dependencies transitively pulled in
(`@node-rs/argon2` via `src/lib/auth/password.ts`, `tronweb` via
`src/lib/tron/trongrid.ts`).

### Image layout

- `.next/standalone` + `.next/static` + `public/` -> the web server (`node server.js`)
- `dist/` (from `tsconfig.server.json`) -> worker and signer entrypoints
- `migrations/` -> so `scripts/migrate.ts` (compiled to `dist/scripts/migrate.js`) can run
  against the production database
- Full `node_modules` (from the `deps` stage, not the Next-traced subset in
  `.next/standalone/node_modules`) is copied last, overwriting the standalone
  subset, because the worker/signer/scripts import the full dependency graph
  (`pg`, `tronweb`, `@node-rs/argon2`, `drizzle-orm`, etc.), not just what Next's
  file tracer captured for the web app.
- Runs as a non-root `app` user (uid/gid 1001).
- No `.env` file or secret-bearing layer is copied into the image; all secrets are
  injected at container runtime via environment variables.
