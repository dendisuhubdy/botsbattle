# Robot MMA Betting Platform — Design

**Date:** 2026-07-25
**Status:** Approved
**Repo:** botsbattle

## Summary

A pari-mutuel betting site for third-party Robot MMA events, settled in USDT on Tron.
Users deposit USDT, stake it on one of two robots in an upcoming fight, watch the fight
on an embedded live stream, and are paid from the pool when an admin declares the winner.
The house takes a fixed rake and never carries outcome risk.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| League relationship | Third-party leagues | User does not own the events |
| Result source | Manual admin settlement | No reliable API exists; fights are watched live |
| Market model | Pari-mutuel pools | No bankroll, no odds-setting, no house outcome risk |
| Custody | Custodial, off-chain ledger | Free instant betting; only deposits/withdrawals touch chain |
| Chain | Tron, USDT-TRC20 | Where retail USDT liquidity actually is; cheap, fast |
| Auth | Email + password, TOTP on withdrawal | Lowest friction; KYC seam left in place |
| Withdrawals | Admin-approved | Cheapest effective fraud control at low volume |
| Deployment | Single DigitalOcean droplet, Docker Compose | Personal account, small scale |

## Non-goals

Explicitly out of scope. Each of these is a future project, not a deferred detail:

- Parlays, accumulators, prop bets, or any market other than "which robot wins"
- In-play / live betting after lock
- Fixed-odds or exchange-style markets
- Multiple currencies or chains
- KYC/AML verification (the seam exists; the integration does not)
- Automated withdrawals without human approval
- Websockets, Redis, or any real-time transport beyond HTTP polling
- Mobile apps, referral programs, bonuses, or affiliate tracking

## Architecture

Four processes, one database.

| Process | Responsibility | Holds secrets? |
|---|---|---|
| **web** (Next.js 15 App Router, TypeScript) | Public site, admin panel, API routes | Session keys, xpub. **No spending keys.** |
| **db** (PostgreSQL 16 + Drizzle) | Single source of truth for all money | — |
| **worker** (Node) | Watches Tron for deposits, confirms, triggers sweeps, tracks withdrawal broadcasts | — |
| **signer** (Node) | Derives keys, signs and broadcasts Tron transactions | **Master seed.** |

The signer is a separate process on the internal Docker network with **no published ports**.
It consumes a job queue table in Postgres and never accepts inbound HTTP. This means a
compromise of the web application — XSS, SSRF, a malicious dependency — yields an attacker
a *withdrawal request awaiting admin approval*, not the hot wallet.

Live odds refresh by polling every 3 seconds. Pool totals change slowly enough that polling
is correct, and it eliminates an entire class of state-synchronisation bugs. The live stream
is a third-party iframe embed (Twitch/YouTube); no video is hosted.

## Money model

Three rules. Everything else follows from them.

### 1. Integers only

USDT-TRC20 has 6 decimals. All amounts are `BIGINT` micro-units: `1 USDT = 1_000_000`.
No floats, no `NUMERIC`, no decimal strings in any calculation. Conversion to a display
string such as `"48.20"` happens in the view layer and nowhere else.

### 2. Double-entry ledger

There is no `balance` column that application code mutates. Every movement of value is a
set of rows in `ledger_entries` sharing a `tx_id`, with the invariant:

> **The signed amounts of every ledger transaction sum to exactly zero.**

Enforced by a deferred constraint trigger, not by convention. An account's balance is
`SUM(amount)` over its entries. A `balance_cache` table holds a materialised copy for
fast reads, rebuilt and compared against the ledger by a reconciliation job; any
disagreement raises an alert and is treated as a production incident.

Account kinds:

- `user_available` — spendable balance, one per user
- `user_pending_withdrawal` — funds committed to an unreviewed withdrawal, one per user
- `pool` — stakes held for one fight, one per fight
- `house_rake` — accumulated commission
- `house_dust` — integer-division remainders
- `hot_wallet` — on-chain holdings under platform control

### 3. Idempotency keys everywhere

The worker will retry. The admin will double-click. The network will time out mid-write.
Every operation that touches the chain or a pool carries a uniqueness-constrained key:

- Deposits: `(tx_hash, log_index)`
- Settlements: `fight_id`
- Bets: client-supplied `idempotency_key`
- Withdrawals: `request_id`

## Fight lifecycle

```
DRAFT ──► OPEN ──► LOCKED ──► SETTLED
          betting   stream         ↘
                                    VOIDED
```

- `DRAFT → OPEN` — admin publishes the fight
- `OPEN → LOCKED` — at `lock_at`, **checked on every bet insert**; a scheduled job is only a backstop
- `LOCKED → SETTLED` — admin declares outcome `A` or `B`
- `LOCKED → VOIDED` — admin voids (cancellation, no-contest, robot failed inspection, disputed result)
- `OPEN → VOIDED` — admin voids before the fight starts

`VOID` exists because real fights get cancelled and admins make mistakes. Without it, the
only recovery from a bad fight is manual database surgery on live money.

Enforcing the lock at insert time rather than by scheduler is the point that matters: a bet
accepted a moment after the outcome becomes knowable is free money taken from other users.

### Bet placement

One database transaction:

1. `SELECT ... FROM fights WHERE id = ? FOR UPDATE`
2. Assert `status = 'OPEN'` and `now() < lock_at`
3. Assert `user_available` balance ≥ stake (from the ledger, not the cache)
4. Write ledger transaction: `user_available −stake`, `pool +stake`
5. Insert the bet row

The row lock makes concurrent bets at the closing bell correct rather than approximately
correct. Minimum stake is 1 USDT.

## Settlement math

All integer arithmetic. One transaction, keyed by `fight_id` with a unique constraint in
the `settlements` table so a double-click cannot double-pay.

Given `pool_total` (all stakes) and `winning_pool` (stakes on the declared winner):

```
rake          = pool_total * rake_bps / 10000          (floor)
distributable = pool_total - rake
payout_i      = distributable * stake_i / winning_pool (floor)
dust          = distributable - Σ payout_i             → house_dust
```

Default `rake_bps` is 500 (5%), configurable per fight.

### Refund cases

Three situations collapse to **refund every stake at face value, zero rake**:

1. `outcome = VOID`
2. `winning_pool = 0` — nobody backed the winner, so the pool has no claimants
3. `winning_pool = pool_total` — every stake was on the winning side

Case 3 is not optional. Without it, a fight where all money lands on one robot pays the
winners *less than they staked*, which is indefensible to users and the first thing anyone
will screenshot.

### Invariant

Asserted inside the settlement transaction:

```
Σ payout_i + rake + dust == pool_total
```

If it does not hold, the transaction aborts rather than paying out.

### Displayed odds

`distributable_now / winning_pool_now`, always labelled as an estimate. In a pari-mutuel
market that figure is genuinely not a promise until lock. Presenting it as fixed odds
invites disputes the platform would deserve to lose.

## Deposits

Each user is assigned one Tron address derived at BIP44 path `m/44'/195'/0'/0/i`.

The web application holds only the **xpub** — sufficient to derive every deposit address,
insufficient to spend from any of them. The master seed exists only inside the signer.

The worker polls TronGrid for TRC-20 transfer events to known addresses, waits 19
confirmations, then credits `user_available` idempotently on `(tx_hash, log_index)`.

Sweeping a deposit address into the hot wallet requires TRX in that address for energy and
bandwidth, so sweeps are subject to a 20 USDT minimum threshold. Balances below it remain
at the deposit address until sweeping is economical. This is expected behaviour, not a
stuck deposit — the user's ledger balance is already credited and spendable.

## Withdrawals

1. User submits address and amount, confirms with TOTP
2. Ledger moves the amount `user_available → user_pending_withdrawal` **immediately**, so
   the funds cannot be staked or withdrawn twice while awaiting review
3. Admin approves or rejects in a queue
4. On approval, the signer broadcasts; the worker confirms and closes out
   `user_pending_withdrawal → hot_wallet`
5. On rejection, the amount returns to `user_available`

Every state change writes a ledger entry, so a stuck withdrawal is always explainable from
the ledger alone. TOTP enrolment is triggered at the first withdrawal attempt, not at signup.

## Compliance seam

Real-money betting is a licensed activity in most jurisdictions and USDT settlement does not
change that. No KYC is implemented. The design leaves three specific insertion points so
that adding it later is an integration rather than a migration:

- `users.verification_status` — defaults to `'none'`, unused at launch
- `users.withdrawal_locked` — a boolean gate already checked in the withdrawal path
- Withdrawal approval is already a human step, which is where a verification requirement
  naturally attaches

Geo-restriction, if needed, belongs at the Caddy layer.

## Data model

```
users(id, email UNIQUE, password_hash, totp_secret_enc, totp_enabled,
      verification_status, withdrawal_locked, created_at)
sessions(id, user_id, expires_at)

accounts(id, kind, user_id NULL, fight_id NULL)
ledger_transactions(id, kind, idempotency_key UNIQUE, metadata, created_at)
ledger_entries(id, tx_id, account_id, amount BIGINT)
balance_cache(account_id PK, balance BIGINT, updated_at)

fights(id, league_name, fighter_a, fighter_b, stream_embed_url,
       status, lock_at, rake_bps, outcome NULL, created_by, settled_at NULL)
bets(id, fight_id, user_id, side, stake BIGINT,
     idempotency_key UNIQUE, payout BIGINT NULL, created_at)
settlements(id, fight_id UNIQUE, outcome, pool_total, winning_pool,
            rake, dust, settled_by, settled_at)

deposit_addresses(id, user_id UNIQUE, derivation_index UNIQUE, address UNIQUE)
deposits(id, tx_hash, log_index, address, amount, status, ledger_tx_id,
         UNIQUE(tx_hash, log_index))
withdrawal_requests(id, user_id, address, amount, status, requested_at,
                    reviewed_by NULL, reviewed_at NULL, tx_hash NULL)
signer_jobs(id, kind, payload, status, created_at, completed_at)
```

`side` is `'A' | 'B'`. `outcome` is `'A' | 'B' | 'VOID'`.

## Authentication

Argon2id password hashing. Server-side sessions in Postgres, delivered as an `httpOnly`,
`Secure`, `SameSite=Lax` cookie with a 30-day expiry. TOTP (RFC 6238) gates withdrawals only.

## Testing strategy

The settlement engine is the highest-risk code in the system and gets the heaviest coverage:

- **Property-based tests** (fast-check) over randomly generated pools, asserting
  `Σ payouts + rake + dust == pool_total` and that no winner ever receives less than their
  stake in the refund cases
- **Concurrency tests** — many simultaneous bets against one fight at the lock boundary,
  asserting no overdraft and no post-lock acceptance
- **Ledger invariant tests** — every transaction sums to zero; cache matches ledger
- **Idempotency tests** — replayed deposits, double-clicked settlements, retried withdrawals
  each produce exactly one effect

Integration tests run against real PostgreSQL via testcontainers. Tron interaction is behind
an interface with a fake implementation for tests; the real client is exercised separately
against Nile testnet.

## Build order

Ordered so the riskiest correctness work is complete before any chain complexity exists.

**Slice 1 — Ledger, fights, betting, settlement.** No Tron. Admin credits balances manually.
This is the entire product minus money movement, and it is where the settlement invariant is
proven against thousands of generated pools.

**Slice 2 — Deposits.** Worker, xpub address derivation, confirmation tracking, sweeps.
Added to accounting already known to be correct.

**Slice 3 — Withdrawals.** Signer process, admin approval queue, TOTP enrolment.

**Slice 4 — Deployment.** Docker Compose on the droplet.

Each slice gets its own implementation plan.

## Deployment

Single DigitalOcean droplet (4 GB minimum), Docker Compose: `caddy`, `web`, `db`, `worker`,
`signer`. The signer and database have no published ports. UFW permits 22, 80, 443 only.

### TLS without a domain

No hostname means no trusted certificate, which would put passwords, session cookies, TOTP
codes and withdrawal addresses on the wire in cleartext and disable `Secure` cookies. For a
platform holding customer funds this is not an acceptable launch state.

The resolution requires no registrar: a wildcard-DNS service maps the droplet IP to a real
hostname (`<ip>.sslip.io` resolves to `<ip>`), and Let's Encrypt issues an ordinary trusted
certificate for it. Caddy performs issuance and renewal automatically. If Let's Encrypt is
rate-limiting that shared suffix at deploy time, the fallback is a Cloudflare Tunnel, which
also provides an HTTPS hostname at no cost.

The configuration is hostname-shaped either way, so pointing a purchased domain at it later
is a single config change.

### Operational risks accepted

- A single droplet is a single point of failure; there is no HA story
- The hot wallet key resides on that droplet. Only operational float is kept hot; the
  remainder belongs in separately controlled cold storage
- Nightly `pg_dump` shipped off the droplet, plus DigitalOcean snapshots
