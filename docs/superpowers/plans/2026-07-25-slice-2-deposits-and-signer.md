# Slice 2 — Tron Deposits, Signer, and Sweeps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real USDT-TRC20 deposits credit the Slice 1 ledger idempotently after 19 confirmations, and an isolated signer process sweeps deposit addresses into the hot wallet.

**Architecture:** Two new long-running Node processes beside the Next.js app. The **worker** polls TronGrid over HTTP, tracks confirmations, and credits deposits through the existing `postTransaction`. The **signer** is the only process that ever sees the master seed; it consumes a `signer_jobs` table in Postgres and never accepts inbound HTTP. All Tron access sits behind one `TronClient` interface with a deterministic fake, so every rule is testable without a network.

**Tech Stack:** Everything from Slice 1, plus `tronweb` 6, `@scure/bip32`, `@scure/bip39`, `@noble/curves`.

## Global Constraints

Slice 1's constraints all still apply — integers only, no `balance` column, zero-sum ledger, idempotency keys, work on `main` and `git push origin main` after every task. In addition:

- **The web process and the worker hold only the xpub.** The master seed exists solely in the signer's environment. A compromise of `web` must not yield spending power.
- **Deposit idempotency key is `(tx_hash, log_index)`**, uniqueness-constrained in the database.
- **19 confirmations** before a deposit is credited. Configurable via `TRON_CONFIRMATIONS`, defaulting to 19.
- **Sweep threshold is 20 USDT** (`20_000_000` micro-units). Balances below it stay at the deposit address; the user's ledger balance is already credited and spendable, so this is expected behaviour and not a stuck deposit.
- **Derivation path is `m/44'/195'/0'/0/i`.** The account-level node `m/44'/195'/0'/0` is what gets exported as the xpub.
- Network is **Nile testnet** during development; mainnet is a config change only. Never hard-code a contract address or endpoint.
- The signer container publishes **no ports**.

## Verified facts (probed against live TronGrid on 2026-07-25)

Do not re-derive these; they were confirmed by running against the real API.

**1. `@scure/bip32` public keys are compressed; TronWeb needs uncompressed.**
`HDKey.publicKey` is 33 bytes. `utils.crypto.computeAddress` expects the 65-byte uncompressed
form. Passing the compressed key produces a *valid-looking but completely wrong address* —
deposits sent there would be unspendable. Decompress via
`secp256k1.Point.fromBytes(compressed).toBytes(false)`.

**2. Known-good test vector.** For the standard BIP39 test mnemonic
(`abandon` ×11 + `about`), path `m/44'/195'/0'/0/i`:

| i | address |
|---|---|
| 0 | `TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH` |
| 1 | `TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK` |
| 5 | `TBdYXtwq18cAhi1BA574TrP6tw2G86anu1` |
| 42 | `TEnzFm6jmsVnizS7RSuBr7H6zzn4e7H7Pb` |

**3. `/v1/accounts/{addr}/transactions/trc20` has no `log_index`.** It returns
`transaction_id`, `from`, `to`, `value`, `block_timestamp`, `token_info` — and nothing else.
It is the cheap per-address *discovery* endpoint.

**4. `/v1/transactions/{txid}/events` does have `event_index` and `block_number`,** and is the
authoritative source for the spec's `(tx_hash, log_index)` key. Its `result.to` / `result.from`
are 20-byte hex strings **without** Tron's `0x41` prefix (e.g. `0x82dd6b99…`); converting to a
Tron address means replacing the leading `0x` with `41` and base58check-encoding.

**5. `POST /wallet/getnowblock`** returns the head height at
`block_header.raw_data.number` — this is the confirmation counter's reference point.

So the poller is a two-stage read: discover candidate transactions cheaply per address, then
fetch that transaction's events once to obtain the authoritative index and block number.

## Ledger convention (carried forward from Slice 1)

A deposit posts exactly what an admin credit posts:

```
hot_wallet     −amount
user_available +amount
```

`hot_wallet` is a **chain-custody** account whose *negated* balance is the platform's total
on-chain obligation. Slice 1 left it at `−200000000` with nothing actually on chain, because
admin credits are fabricated money. Slice 2 makes the reconciliation real:

> `−balance(hot_wallet)` must equal the summed on-chain USDT across all deposit addresses
> plus the hot wallet.

Task 12 implements that check. Admin credits are the only thing that can break it, which is
why Task 12 reports them separately rather than treating the mismatch as corruption.

## File Structure

| Path | Responsibility |
|---|---|
| `migrations/0004_deposits.sql` | `deposit_addresses`, `deposits`, `signer_jobs`, `chain_cursors` |
| `src/lib/tron/config.ts` | Env parsing: network, endpoints, contract, confirmations, thresholds |
| `src/lib/tron/address.ts` | xpub → Tron address derivation; hex ↔ base58 conversion |
| `src/lib/tron/client.ts` | `TronClient` interface and shared types |
| `src/lib/tron/trongrid.ts` | Real `TronClient` over TronGrid HTTP |
| `src/lib/tron/fake.ts` | Deterministic in-memory `TronClient` for tests |
| `src/lib/deposits/addresses.ts` | Assigning a deposit address to a user |
| `src/lib/deposits/credit.ts` | Idempotent credit of a confirmed deposit |
| `src/lib/deposits/poller.ts` | One poll cycle: discover → confirm → credit |
| `src/lib/signer/jobs.ts` | `signer_jobs` enqueue/claim/complete |
| `src/lib/signer/sweep.ts` | Sweep threshold policy and job creation |
| `src/lib/signer/keys.ts` | **Seed-holding**: private key derivation (signer process only) |
| `src/lib/signer/run.ts` | Signer loop: claim job, sign, broadcast, record |
| `src/lib/reconcile/chain.ts` | On-chain vs ledger reconciliation |
| `worker/main.ts` | Worker process entrypoint |
| `signer/main.ts` | Signer process entrypoint |
| `src/app/deposit/page.tsx`, `src/app/api/me/deposit-address/route.ts` | User-facing deposit address |

---

## Task 1: Tron configuration and address derivation

The single highest-risk function in the slice. A wrong address means user money is sent
somewhere nobody holds a key for, and it is unrecoverable.

**Files:**
- Create: `src/lib/tron/config.ts`, `src/lib/tron/address.ts`
- Modify: `.env.example`
- Test: `tests/tron/address.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `src/lib/tron/config.ts`: `type TronConfig = { network: 'nile' | 'mainnet'; fullHost: string; apiKey: string | null; usdtContract: string; confirmations: number; sweepMinMicros: bigint; hotWalletAddress: string; xpub: string }`, `loadTronConfig(env?: NodeJS.ProcessEnv): TronConfig`
  - `src/lib/tron/address.ts`:
    - `ACCOUNT_PATH = "m/44'/195'/0'/0"`
    - `deriveAddress(xpub: string, index: number): string`
    - `hexToTronAddress(hex: string): string` — accepts `0x…`/`41…`/bare 40-char hex
    - `isTronAddress(value: string): boolean`

- [ ] **Step 1: Install the dependencies**

```bash
pnpm add tronweb@6 @scure/bip32@2 @scure/bip39@2 @noble/curves@2
```

- [ ] **Step 2: Write the failing test**

`tests/tron/address.test.ts`. The vectors come from the probe recorded in this plan's header;
the cross-check against private-key derivation is what actually guarantees correctness.

```ts
import { describe, it, expect } from 'vitest'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { TronWeb } from 'tronweb'
import { deriveAddress, hexToTronAddress, isTronAddress, ACCOUNT_PATH } from '@/lib/tron/address'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

function testXpub(): string {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(ACCOUNT_PATH)
    .publicExtendedKey
}

describe('deriveAddress', () => {
  it('matches known vectors for the standard test mnemonic', () => {
    const xpub = testXpub()
    expect(deriveAddress(xpub, 0)).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')
    expect(deriveAddress(xpub, 1)).toBe('TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK')
    expect(deriveAddress(xpub, 5)).toBe('TBdYXtwq18cAhi1BA574TrP6tw2G86anu1')
    expect(deriveAddress(xpub, 42)).toBe('TEnzFm6jmsVnizS7RSuBr7H6zzn4e7H7Pb')
  })

  it('agrees with private-key derivation at every index', () => {
    // The guarantee that matters: an address derived from the watch-only xpub must be
    // spendable by the key the signer derives for the same index.
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC))
    const xpub = master.derive(ACCOUNT_PATH).publicExtendedKey

    for (let i = 0; i < 20; i++) {
      const priv = master.derive(`${ACCOUNT_PATH}/${i}`).privateKey!
      const fromPrivate = TronWeb.address.fromPrivateKey(Buffer.from(priv).toString('hex'))
      expect(deriveAddress(xpub, i)).toBe(fromPrivate)
    }
  })

  it('is deterministic', () => {
    const xpub = testXpub()
    expect(deriveAddress(xpub, 7)).toBe(deriveAddress(xpub, 7))
  })

  it('produces a distinct address per index', () => {
    const xpub = testXpub()
    const seen = new Set(Array.from({ length: 50 }, (_, i) => deriveAddress(xpub, i)))
    expect(seen.size).toBe(50)
  })

  it('rejects a negative or non-integer index', () => {
    const xpub = testXpub()
    expect(() => deriveAddress(xpub, -1)).toThrow(RangeError)
    expect(() => deriveAddress(xpub, 1.5)).toThrow(RangeError)
  })

  it('refuses an extended key that carries a private key', () => {
    // Passing an xprv here would mean the web process was handed spending material.
    const xprv = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(ACCOUNT_PATH)
      .privateExtendedKey
    expect(() => deriveAddress(xprv, 0)).toThrow(/xpub/i)
  })
})

describe('hexToTronAddress', () => {
  it('converts the 0x-prefixed form TronGrid events return', () => {
    // from the probed Transfer event
    expect(hexToTronAddress('0x82dd6b9966724ae2fdc79b416c7588da67ff1b35')).toBe(
      'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9',
    )
  })

  it('accepts the 41-prefixed and bare forms too', () => {
    expect(hexToTronAddress('4182dd6b9966724ae2fdc79b416c7588da67ff1b35')).toBe(
      'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9',
    )
    expect(hexToTronAddress('82dd6b9966724ae2fdc79b416c7588da67ff1b35')).toBe(
      'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9',
    )
  })

  it('rejects malformed hex', () => {
    expect(() => hexToTronAddress('0x1234')).toThrow(RangeError)
    expect(() => hexToTronAddress('zzzz')).toThrow(RangeError)
  })
})

describe('isTronAddress', () => {
  it('accepts real addresses and rejects junk', () => {
    expect(isTronAddress('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')).toBe(true)
    expect(isTronAddress('0x82dd6b9966724ae2fdc79b416c7588da67ff1b35')).toBe(false)
    expect(isTronAddress('not-an-address')).toBe(false)
    expect(isTronAddress('')).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test tests/tron/address.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/tron/address"`.

- [ ] **Step 4: Write the address module**

`src/lib/tron/address.ts`:

```ts
import { HDKey } from '@scure/bip32'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { TronWeb, utils as tronUtils } from 'tronweb'

/** BIP44 account-level node for Tron. The exported xpub is this node's public key. */
export const ACCOUNT_PATH = "m/44'/195'/0'/0"

const HEX_40 = /^[0-9a-f]{40}$/i

/**
 * Derive the deposit address for `index` from a watch-only xpub.
 *
 * `@scure/bip32` returns a 33-byte COMPRESSED public key; TronWeb's `computeAddress`
 * requires the 65-byte uncompressed form. Feeding it the compressed key yields a
 * well-formed but wrong address, and funds sent there are unrecoverable — so the
 * decompression below is load-bearing, not a formality.
 */
export function deriveAddress(xpub: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`derivation index must be a non-negative integer, got ${index}`)
  }

  const node = HDKey.fromExtendedKey(xpub)
  if (node.privateKey) {
    throw new Error('expected a watch-only xpub; this key carries private material')
  }

  const compressed = node.deriveChild(index).publicKey
  if (!compressed) throw new Error(`could not derive public key at index ${index}`)

  const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false)
  return tronUtils.crypto.getBase58CheckAddress(tronUtils.crypto.computeAddress(uncompressed))
}

/**
 * Convert a hex address to base58check. TronGrid event results use a bare 20-byte hex
 * form with an `0x` prefix and no Tron `41` version byte.
 */
export function hexToTronAddress(hex: string): string {
  let body = hex.startsWith('0x') ? hex.slice(2) : hex
  if (body.length === 42 && body.toLowerCase().startsWith('41')) body = body.slice(2)
  if (!HEX_40.test(body)) throw new RangeError(`not a 20-byte hex address: ${hex}`)

  const bytes = Buffer.from(`41${body}`, 'hex')
  return tronUtils.crypto.getBase58CheckAddress(Array.from(bytes))
}

export function isTronAddress(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && TronWeb.isAddress(value)
}
```

- [ ] **Step 5: Write the config module**

`src/lib/tron/config.ts`:

```ts
export type TronNetwork = 'nile' | 'mainnet'

export type TronConfig = {
  network: TronNetwork
  fullHost: string
  apiKey: string | null
  usdtContract: string
  confirmations: number
  sweepMinMicros: bigint
  hotWalletAddress: string
  xpub: string
}

const DEFAULT_HOSTS: Record<TronNetwork, string> = {
  nile: 'https://nile.trongrid.io',
  mainnet: 'https://api.trongrid.io',
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

export function loadTronConfig(env: NodeJS.ProcessEnv = process.env): TronConfig {
  const network = (env.TRON_NETWORK ?? 'nile') as TronNetwork
  if (network !== 'nile' && network !== 'mainnet') {
    throw new Error(`TRON_NETWORK must be "nile" or "mainnet", got ${network}`)
  }

  return {
    network,
    fullHost: env.TRON_FULL_HOST ?? DEFAULT_HOSTS[network],
    apiKey: env.TRONGRID_API_KEY ?? null,
    usdtContract: required(env, 'TRON_USDT_CONTRACT'),
    confirmations: Number(env.TRON_CONFIRMATIONS ?? '19'),
    sweepMinMicros: BigInt(env.TRON_SWEEP_MIN_MICROS ?? '20000000'),
    hotWalletAddress: required(env, 'TRON_HOT_WALLET_ADDRESS'),
    xpub: required(env, 'TRON_XPUB'),
  }
}
```

- [ ] **Step 6: Extend `.env.example`**

Append. Note that `TRON_MNEMONIC` is listed separately and belongs **only** to the signer's
environment — it must never appear in the web or worker containers.

```
# --- Tron (web + worker: watch-only) ---
TRON_NETWORK=nile
TRON_FULL_HOST=https://nile.trongrid.io
TRONGRID_API_KEY=
TRON_USDT_CONTRACT=
TRON_HOT_WALLET_ADDRESS=
TRON_XPUB=
TRON_CONFIRMATIONS=19
TRON_SWEEP_MIN_MICROS=20000000

# --- signer process ONLY. Never set this in web or worker. ---
TRON_MNEMONIC=
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm test tests/tron/address.test.ts
pnpm typecheck
```

Expected: PASS, 10 tests. The cross-check loop over 20 indices is the one that matters — if it
fails, stop and fix the derivation before writing anything else in this slice.

- [ ] **Step 8: Commit and push**

```bash
git add src/lib/tron tests/tron .env.example package.json pnpm-lock.yaml
git commit -m "feat: Tron config and xpub deposit address derivation"
git push origin main
```

<!-- PLAN-CONTINUES -->
