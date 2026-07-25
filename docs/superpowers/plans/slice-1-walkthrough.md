# Slice 1 — End-to-end walkthrough

**Date:** 2026-07-25
**Commit:** Task 13 of `2026-07-25-slice-1-ledger-betting-settlement.md`
**Environment:** Next 15.5.21 dev server on `localhost:3001` (port 3000 was held by an
unrelated process), PostgreSQL 16 in Docker on `localhost:5434` (5433 was held by an
unrelated `cofounder-pg` container).

All numbers below are **observed output**, not expectations.

## Result

The full lifecycle — signup → credit → publish → bet → lock → settle — completed with the
ledger globally balanced and every idempotency and authorisation gate holding.

## Steps

| # | Action | Observed |
|---|---|---|
| 1 | Sign up `admin@`, `alice@`, `bob@` | Three users, all `isAdmin: false` |
| 2 | `GET /api/admin/users` as pre-promotion admin | `403 FORBIDDEN` — privilege cannot be granted over HTTP |
| 3 | `pnpm make-admin admin@example.com` | `admin@example.com is now an admin` |
| 4 | Credit Alice and Bob 100 USDT each | Two `ADMIN_CREDIT` transactions, `replayed: false` |
| 5 | **Replay** Alice's credit, same reference `seed-alice` | Same `txId` returned, `replayed: true` |
| 6 | Balances after replay | Alice `100000000`, Bob `100000000` — unchanged |
| 7 | Create fight, rake 500 bps, locks in 10 min | Status `DRAFT`, `rakeBps: 500` |
| 8 | Alice bets on the `DRAFT` fight | `409 FIGHT_NOT_OPEN` |
| 9 | Publish | Status `OPEN` |
| 10 | Alice 25 on A, Bob 75 on B | Two bets accepted |
| 11 | Alice bets 90 with 75 remaining | `402 INSUFFICIENT_FUNDS` — "balance 75000000 is less than stake 90000000" |
| 12 | Live estimates | Pool `100000000`; est. A `3800000` (3.80×), est. B `1266666` (1.27×) |
| 13 | Settle while still `OPEN` | `409 NOT_SETTLEABLE` |
| 14 | Push `lock_at` into the past, hit `GET /api/fights` | Status `LOCKED` — the lazy backstop fired |
| 15 | Alice bets after lock | `409 FIGHT_NOT_OPEN` |
| 16 | Settle outcome `A` | `refunded false`, pool `100000000`, winningPool `25000000`, rake `5000000`, dust `0` |
| 17 | **Double-click** settle | `replayed: true`, rake still `5000000` |
| 18 | Final balances | Alice `170000000` (75 kept + 95 won), Bob `25000000` |

## Ledger verification

```
      kind      |  balance
----------------+------------
 hot_wallet     | -200000000
 house_rake     |    5000000
 pool           |          0
 user_available |  195000000
```

`-200 + 195 + 5 + 0 = 0`.

```
 grand_total
-------------
           0
```

Transactions not summing to zero: **0 rows**.

The full ledger, showing that neither replay wrote anything:

```
     kind     |                     idempotency_key
--------------+---------------------------------------------------------
 ADMIN_CREDIT | credit:seed-alice
 ADMIN_CREDIT | credit:seed-bob
 BET          | bet:6200ff31-…:alice-bet-0001
 BET          | bet:434cfc00-…:bob-bet-0001
 SETTLEMENT   | settle:90d8d938-…
```

Five transactions for five distinct effects. The replayed credit (step 5) and the
double-clicked settlement (step 17) produced no additional rows.

`hot_wallet` sitting at `-200000000` is correct double-entry for Slice 1: the admin credit
stands in for a deposit that has not happened on chain, so the platform's on-chain account
records the liability. Slice 2's real deposit crediting restores it to a true figure.

## Page rendering

- **Fight list** — `Crusher vs Bolt · Robot League · SETTLED (A) · 100.00 USDT · 3.80× · 1.26×`
- **Account (Alice)** — `Balance: 170.00 USDT`, bet row `A · 25.00 USDT · SETTLED (A) · 95.00 USDT`
- **Admin gate** — `/admin` returns `200` for the admin, `404` for Alice, `404` for anonymous

## Notes

- The displayed estimate truncates to two decimals (`1.26×` for `1266666`), which matches
  `formatUsdt`'s truncate-never-round rule. It is labelled an estimate throughout.
- Ports differ from the plan's defaults because both 3000 and 5433 were occupied by
  unrelated local processes. `docker-compose.yml` and `.env.example` pin Postgres to 5434.
