# Slice 4 — Deployment — Walkthrough

Observed values from the real deployment on 2026-07-31. No secrets appear here.

Live at **https://botsfight.com**.

## Infrastructure

| | |
|---|---|
| Droplet | `botsfight`, `s-4vcpu-8gb`, Ubuntu 24.04.4 LTS, region `sgp1` |
| Public IPv4 | 165.245.185.0 |
| Checkout | `/home/deploy/botsbattle`, owned by `deploy` |
| Docker | 29.7.0, Compose v5.3.1 |
| Disk | 154 GB, 8.1 GB used (6%) after first deploy |

## DNS

`botsfight.com` is on **Cloudflare**, not DigitalOcean DNS. Apex and `www` are `A` records
at 165.245.185.0 with the **proxy disabled**.

The proxy state is load-bearing rather than cosmetic. Caddy obtains its certificate over
HTTP-01, and an orange-cloud proxy intercepts that challenge and terminates TLS itself, so
issuance fails. The domain was previously parked at a Namecheap page (`192.64.119.48`,
proxied) and returned `HTTP 522` — a Cloudflare origin-timeout — so nothing live was
displaced.

The zone also carries email records that were deliberately left untouched: five `MX` to
`eforward{1..5}.registrar-servers.com`, an SPF `TXT`, and Resend/SES records on
`send.botsfight.com` and `resend._domainkey`.

```
$ dig +short A botsfight.com @1.1.1.1
165.245.185.0
$ dig +short A www.botsfight.com @8.8.8.8
165.245.185.0
```

## TLS

```
subject=CN=botsfight.com
issuer=C=US, O=Let's Encrypt, CN=YE2
notBefore=Jul 31 01:17:51 2026 GMT
notAfter=Oct 29 01:17:50 2026 GMT
```

Response headers on `https://botsfight.com`:

```
HTTP/2 200
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: strict-origin-when-cross-origin
via: 1.1 Caddy
```

`http://botsfight.com` returns `HTTP/1.1 308 Permanent Redirect` to `https://botsfight.com/`.
`https://www.botsfight.com` returns `HTTP/2 200`.

## Network exposure

From a laptop outside the droplet:

```
22  OPEN
80  OPEN
443 OPEN
3000 closed/filtered
5432 closed/filtered
```

Host port bindings, from `docker compose ps`:

```
caddy   0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
db      5432/tcp        <- container port only, not published
web     3000/tcp        <- container port only, not published
worker  3000/tcp        <- container port only, not published
```

UFW allows 22, 80, and 443 only. Root SSH is refused (`Permission denied (publickey)`);
`deploy` authenticates.

## Seed placement

```
web: no-seed
worker: no-seed
```

The signer is **not running**. `TRON_MNEMONIC` is empty because the seed is held by its
owner, not by this deployment, so the signer would only crash-loop. The deployment is
watch-only in the meantime: deposits credit and bets settle, but sweeps and withdrawal
broadcasts do not happen.

Hot wallet `TD3CrWAqbq2jRN6yHPQao9d1hJD4STSyCd` is index 0 under the supplied account xpub,
confirmed against the seed holder's own wallet on 2026-07-31. That confirmation carries
real weight here: `assertMatchesXpub` and `assertHotWalletKey` cannot run without the seed,
so a human check is the only thing standing in for them. Had the xpub been exported at a
different depth, every deposit address on the site would have been unspendable.

## Bug found during deployment

Deposit addresses were allocated from `COALESCE(MAX(derivation_index) + 1, 0)` — index 0,
the same index shipped as `TRON_HOT_WALLET_INDEX`. The first user to request a deposit
address would have received the hot wallet itself: their deposit indistinguishable from
operational float, and `enqueueSweeps` — which sweeps every row in `deposit_addresses`
without excluding the hot wallet — queuing a sweep from the hot wallet to itself.

The test suite already assumed the correct arrangement, passing `hotWalletIndex: 99`
throughout, so the defect lived only in the shipped default configuration. Fixed in
`0af6c49`: index 0 reserved, allocation starts at 1, floored with `GREATEST`.

## Backups

Nightly at 03:17 UTC via the `deploy` crontab.

```
wrote /home/deploy/backups/botsbattle-20260731T022746Z.sql.gz (4676 bytes)
uploaded to dospaces:botsfight-backups
```

Restore rehearsal, performed against the copy **downloaded from the Space** rather than the
local file — the local copy does not exist in the scenario backups are for:

```
==> creating botsbattle_restore_check
==> restoring
==> verifying the ledger in the restored copy
 grand_total
-------------
           0
restored into botsbattle_restore_check -- ledger balanced, no lopsided transactions
```

The restored copy carried 14 tables and the 3 seeded house accounts
(`house_rake`, `house_dust`, `hot_wallet`). Production was untouched by the rehearsal.

The Space is private:

```
bucket listing: HTTP 403
object direct:  HTTP 403
```

Caveat worth repeating: the ledger is empty today, so `grand_total = 0` is a weak
assertion. Repeat this rehearsal once there is real transaction volume.

## Restart recovery

All four containers carry `RestartPolicy=unless-stopped`, which is what makes reboot
recovery work.

Worker restart:

```
[worker] polling mainnet every 15000ms
[worker] SIGTERM received, shutting down
[worker] stopped
[worker] polling mainnet every 15000ms
```

It shuts down gracefully on SIGTERM and resumes polling unattended. The site stayed up
throughout (`HTTP/2 200`).

## Not yet done

- **Reboot recovery** (plan Task 6 Step 3) — not attempted; it interrupts the live site.
  The restart policies above are necessary but not sufficient evidence.
- **Signer restart recovery** — blocked until the signer has a seed.
- **One real end-to-end money transaction and `reconcile.js`** (Task 6 Step 4) — blocked on
  the signer.
- **`TRONGRID_API_KEY`** is empty, so mainnet polling is rate-limited.
- **No admin user** exists yet.
- **DO droplet snapshots** not enabled.

## Note on scope

Nothing in Slices 1–4 implements KYC, AML, or licensing. The seams exist
(`users.verification_status`, `users.withdrawal_locked`, and a human approval step on every
withdrawal) but the obligations do not go away because the code has somewhere to put them
later. Real-money betting is a licensed activity in most jurisdictions.
