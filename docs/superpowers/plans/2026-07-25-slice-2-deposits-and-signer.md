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

---

## Task 2: TronClient interface and the fake

Every rule in this slice is testable without a network because all chain access goes through
one narrow interface. The fake is not a stub — it is a deterministic in-memory chain that
tests drive.

**Files:**
- Create: `src/lib/tron/client.ts`, `src/lib/tron/fake.ts`
- Test: `tests/tron/fake.test.ts`

**Interfaces:**
- Consumes: `hexToTronAddress` from Task 1
- Produces (`src/lib/tron/client.ts`):
  - `type Trc20Transfer = { txHash: string; logIndex: number; from: string; to: string; amountMicros: bigint; blockNumber: number }`
  - `type TronClient = { headBlock(): Promise<number>; incomingTransfers(address: string, opts?: { sinceMs?: number }): Promise<Trc20Transfer[]>; trc20Balance(address: string): Promise<bigint>; trxBalance(address: string): Promise<bigint>; sendTrc20(args: SendArgs): Promise<string> }`
  - `type SendArgs = { fromPrivateKeyHex: string; to: string; amountMicros: bigint }`
  - `class TronError extends Error { code: 'RPC_FAILED' | 'BROADCAST_FAILED' | 'INSUFFICIENT_ENERGY' }`
- Produces (`src/lib/tron/fake.ts`):
  - `class FakeTron implements TronClient` with test controls:
    - `setHead(n: number): void`
    - `deposit(args: { to: string; amountMicros: bigint; blockNumber: number; txHash?: string; logIndex?: number; from?: string }): Trc20Transfer`
    - `setTrxBalance(address: string, sun: bigint): void`
    - `failNextSend(message: string): void`
    - `readonly broadcasts: Array<{ from: string; to: string; amountMicros: bigint; txHash: string }>`

- [ ] **Step 1: Write the failing test**

`tests/tron/fake.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { FakeTron } from '@/lib/tron/fake'
import { TronError } from '@/lib/tron/client'

const ADDR_A = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const ADDR_B = 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK'
const USDT = 1_000_000n

describe('FakeTron', () => {
  it('starts at a known head and advances only when told', async () => {
    const tron = new FakeTron()
    expect(await tron.headBlock()).toBe(1000)
    tron.setHead(1042)
    expect(await tron.headBlock()).toBe(1042)
  })

  it('returns deposits addressed to the queried address only', async () => {
    const tron = new FakeTron()
    tron.deposit({ to: ADDR_A, amountMicros: 25n * USDT, blockNumber: 1001 })
    tron.deposit({ to: ADDR_B, amountMicros: 5n * USDT, blockNumber: 1001 })

    const forA = await tron.incomingTransfers(ADDR_A)
    expect(forA).toHaveLength(1)
    expect(forA[0]).toMatchObject({ to: ADDR_A, amountMicros: 25n * USDT, blockNumber: 1001 })
  })

  it('assigns distinct (txHash, logIndex) pairs automatically', async () => {
    const tron = new FakeTron()
    tron.deposit({ to: ADDR_A, amountMicros: 1n * USDT, blockNumber: 1001 })
    tron.deposit({ to: ADDR_A, amountMicros: 2n * USDT, blockNumber: 1002 })

    const transfers = await tron.incomingTransfers(ADDR_A)
    const keys = transfers.map((t) => `${t.txHash}:${t.logIndex}`)
    expect(new Set(keys).size).toBe(2)
  })

  it('supports two transfers sharing one transaction hash', async () => {
    const tron = new FakeTron()
    tron.deposit({ to: ADDR_A, amountMicros: 1n * USDT, blockNumber: 1001, txHash: 'shared', logIndex: 0 })
    tron.deposit({ to: ADDR_A, amountMicros: 2n * USDT, blockNumber: 1001, txHash: 'shared', logIndex: 1 })

    const transfers = await tron.incomingTransfers(ADDR_A)
    expect(transfers.map((t) => t.logIndex).sort()).toEqual([0, 1])
  })

  it('tracks the TRC20 balance as deposits land and sends leave', async () => {
    const tron = new FakeTron()
    tron.deposit({ to: ADDR_A, amountMicros: 30n * USDT, blockNumber: 1001 })
    expect(await tron.trc20Balance(ADDR_A)).toBe(30n * USDT)

    await tron.sendTrc20({ fromPrivateKeyHex: 'aa'.repeat(32), to: ADDR_B, amountMicros: 10n * USDT })
    // The fake attributes the send to the address matching the key it was given.
    expect(tron.broadcasts).toHaveLength(1)
    expect(tron.broadcasts[0]).toMatchObject({ to: ADDR_B, amountMicros: 10n * USDT })
  })

  it('reports TRX balance, defaulting to zero', async () => {
    const tron = new FakeTron()
    expect(await tron.trxBalance(ADDR_A)).toBe(0n)
    tron.setTrxBalance(ADDR_A, 5_000_000n)
    expect(await tron.trxBalance(ADDR_A)).toBe(5_000_000n)
  })

  it('can be told to fail the next broadcast', async () => {
    const tron = new FakeTron()
    tron.failNextSend('out of energy')

    await expect(
      tron.sendTrc20({ fromPrivateKeyHex: 'aa'.repeat(32), to: ADDR_B, amountMicros: 1n * USDT }),
    ).rejects.toBeInstanceOf(TronError)

    // The failure is consumed: the next send succeeds.
    const hash = await tron.sendTrc20({
      fromPrivateKeyHex: 'aa'.repeat(32),
      to: ADDR_B,
      amountMicros: 1n * USDT,
    })
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/tron/fake.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/tron/fake"`.

- [ ] **Step 3: Write the interface**

`src/lib/tron/client.ts`:

```ts
export type Trc20Transfer = {
  txHash: string
  logIndex: number
  from: string
  to: string
  amountMicros: bigint
  blockNumber: number
}

export type SendArgs = {
  fromPrivateKeyHex: string
  to: string
  amountMicros: bigint
}

export class TronError extends Error {
  constructor(
    message: string,
    readonly code: 'RPC_FAILED' | 'BROADCAST_FAILED' | 'INSUFFICIENT_ENERGY',
  ) {
    super(message)
    this.name = 'TronError'
  }
}

/**
 * Every chain interaction the platform performs. Deliberately narrow: the fake in
 * `fake.ts` must be able to implement all of it faithfully, or the tests are lying.
 */
export type TronClient = {
  headBlock(): Promise<number>
  /** TRC20 transfers *into* `address`, newest first. */
  incomingTransfers(address: string, opts?: { sinceMs?: number }): Promise<Trc20Transfer[]>
  trc20Balance(address: string): Promise<bigint>
  /** TRX balance in SUN (1 TRX = 1e6 SUN), used to check sweep gas. */
  trxBalance(address: string): Promise<bigint>
  sendTrc20(args: SendArgs): Promise<string>
}
```

- [ ] **Step 4: Write the fake**

`src/lib/tron/fake.ts`:

```ts
import { TronWeb } from 'tronweb'
import { TronError, type SendArgs, type TronClient, type Trc20Transfer } from './client'

/**
 * A deterministic in-memory chain. No randomness and no clock: transaction hashes are
 * generated from a counter so tests reproduce exactly.
 */
export class FakeTron implements TronClient {
  private head = 1000
  private transfers: Trc20Transfer[] = []
  private trc20: Map<string, bigint> = new Map()
  private trx: Map<string, bigint> = new Map()
  private counter = 0
  private nextSendFailure: string | null = null

  readonly broadcasts: Array<{ from: string; to: string; amountMicros: bigint; txHash: string }> = []

  setHead(n: number): void {
    this.head = n
  }

  setTrxBalance(address: string, sun: bigint): void {
    this.trx.set(address, sun)
  }

  failNextSend(message: string): void {
    this.nextSendFailure = message
  }

  deposit(args: {
    to: string
    amountMicros: bigint
    blockNumber: number
    txHash?: string
    logIndex?: number
    from?: string
  }): Trc20Transfer {
    const transfer: Trc20Transfer = {
      txHash: args.txHash ?? `fake${(this.counter++).toString(16).padStart(60, '0')}`,
      logIndex: args.logIndex ?? 0,
      from: args.from ?? 'TSenderAddressPlaceholder00000000',
      to: args.to,
      amountMicros: args.amountMicros,
      blockNumber: args.blockNumber,
    }
    this.transfers.push(transfer)
    this.credit(args.to, args.amountMicros)
    return transfer
  }

  private credit(address: string, amount: bigint): void {
    this.trc20.set(address, (this.trc20.get(address) ?? 0n) + amount)
  }

  async headBlock(): Promise<number> {
    return this.head
  }

  async incomingTransfers(address: string): Promise<Trc20Transfer[]> {
    return this.transfers
      .filter((t) => t.to === address)
      .slice()
      .sort((a, b) => b.blockNumber - a.blockNumber)
  }

  async trc20Balance(address: string): Promise<bigint> {
    return this.trc20.get(address) ?? 0n
  }

  async trxBalance(address: string): Promise<bigint> {
    return this.trx.get(address) ?? 0n
  }

  async sendTrc20(args: SendArgs): Promise<string> {
    if (this.nextSendFailure) {
      const message = this.nextSendFailure
      this.nextSendFailure = null
      throw new TronError(message, 'BROADCAST_FAILED')
    }

    const from = TronWeb.address.fromPrivateKey(args.fromPrivateKeyHex)
    if (from === false) throw new TronError('invalid private key', 'BROADCAST_FAILED')

    const available = this.trc20.get(from) ?? 0n
    if (available < args.amountMicros) {
      throw new TronError(
        `fake chain: ${from} holds ${available}, cannot send ${args.amountMicros}`,
        'BROADCAST_FAILED',
      )
    }

    this.trc20.set(from, available - args.amountMicros)
    this.credit(args.to, args.amountMicros)

    const txHash = `send${(this.counter++).toString(16).padStart(60, '0')}`
    this.broadcasts.push({ from, to: args.to, amountMicros: args.amountMicros, txHash })
    return txHash
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test tests/tron/fake.test.ts
pnpm typecheck
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit and push**

```bash
git add src/lib/tron tests/tron
git commit -m "feat: TronClient interface and deterministic fake chain"
git push origin main
```

---

## Task 3: Real TronGrid client

**Files:**
- Create: `src/lib/tron/trongrid.ts`
- Test: `tests/tron/trongrid.test.ts`

**Interfaces:**
- Consumes: `TronClient`, `TronError`, `Trc20Transfer`, `TronConfig`, `hexToTronAddress`
- Produces: `createTronGridClient(config: TronConfig, fetchImpl?: typeof fetch): TronClient`

The two-stage read from the plan header: `/v1/accounts/{addr}/transactions/trc20` discovers
candidate transactions cheaply, then `/v1/transactions/{txid}/events` supplies the authoritative
`event_index` and `block_number`. Tests inject a stubbed `fetch` with recorded response shapes,
so no network is touched.

- [ ] **Step 1: Write the failing test**

`tests/tron/trongrid.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createTronGridClient } from '@/lib/tron/trongrid'
import { TronError } from '@/lib/tron/client'
import type { TronConfig } from '@/lib/tron/config'

const ADDR = 'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9'
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TX = '8b5e5f9a99d65c0b3aac7f3cbc2ee3029a0d4225054fd99830236d96d853c503'

const config: TronConfig = {
  network: 'nile',
  fullHost: 'https://nile.trongrid.io',
  apiKey: 'test-key',
  usdtContract: USDT_CONTRACT,
  confirmations: 19,
  sweepMinMicros: 20_000_000n,
  hotWalletAddress: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
  xpub: 'xpub-not-used-here',
}

/** Response bodies copied from the live probe recorded in this plan's header. */
function stubFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    const match = Object.keys(routes).find((k) => url.includes(k))
    if (!match) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(routes[match]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

describe('TronGrid client', () => {
  it('reads the head block height', async () => {
    const client = createTronGridClient(
      config,
      stubFetch({ '/wallet/getnowblock': { block_header: { raw_data: { number: 84768962 } } } }),
    )
    expect(await client.headBlock()).toBe(84768962)
  })

  it('joins the discovery and events endpoints into transfers', async () => {
    const calls: string[] = []
    const client = createTronGridClient(
      config,
      stubFetch(
        {
          '/transactions/trc20': {
            success: true,
            data: [
              {
                transaction_id: TX,
                token_info: { address: USDT_CONTRACT, decimals: 6, symbol: 'USDT' },
                block_timestamp: 1764517689000,
                from: 'TEPSrSYPDSQ7yXpMFPq91Fb1QEWpMkRGfn',
                to: ADDR,
                type: 'Transfer',
                value: '2000000',
              },
            ],
          },
          [`/transactions/${TX}/events`]: {
            success: true,
            data: [
              {
                event_name: 'Transfer',
                event_index: 0,
                block_number: 77951958,
                contract_address: USDT_CONTRACT,
                result: {
                  from: '0x30760c7e10b1d3509d8d64a7e9eb9ab94bc83495',
                  to: '0x82dd6b9966724ae2fdc79b416c7588da67ff1b35',
                  value: '2000000',
                },
              },
            ],
          },
        },
        calls,
      ),
    )

    const transfers = await client.incomingTransfers(ADDR)
    expect(transfers).toEqual([
      {
        txHash: TX,
        logIndex: 0,
        from: 'TEPSrSYPDSQ7yXpMFPq91Fb1QEWpMkRGfn',
        to: ADDR,
        amountMicros: 2_000_000n,
        blockNumber: 77951958,
      },
    ])
    expect(calls.some((c) => c.includes('only_to=true'))).toBe(true)
    expect(calls.some((c) => c.includes(`contract_address=${USDT_CONTRACT}`))).toBe(true)
  })

  it('ignores events from other contracts and other recipients', async () => {
    const client = createTronGridClient(
      config,
      stubFetch({
        '/transactions/trc20': {
          success: true,
          data: [{ transaction_id: TX, token_info: { address: USDT_CONTRACT }, to: ADDR, value: '1' }],
        },
        [`/transactions/${TX}/events`]: {
          success: true,
          data: [
            {
              event_name: 'Transfer',
              event_index: 0,
              block_number: 10,
              contract_address: 'TSomeOtherContract0000000000000000',
              result: { from: '0x' + '11'.repeat(20), to: '0x82dd6b9966724ae2fdc79b416c7588da67ff1b35', value: '1' },
            },
            {
              event_name: 'Transfer',
              event_index: 1,
              block_number: 10,
              contract_address: USDT_CONTRACT,
              result: { from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), value: '9' },
            },
            {
              event_name: 'Approval',
              event_index: 2,
              block_number: 10,
              contract_address: USDT_CONTRACT,
              result: { from: '0x' + '11'.repeat(20), to: '0x82dd6b9966724ae2fdc79b416c7588da67ff1b35', value: '5' },
            },
          ],
        },
      }),
    )

    expect(await client.incomingTransfers(ADDR)).toEqual([])
  })

  it('sends the API key header when configured', async () => {
    let seenKey: string | null = null
    const client = createTronGridClient(config, (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenKey = new Headers(init?.headers).get('TRON-PRO-API-KEY')
      return new Response(JSON.stringify({ block_header: { raw_data: { number: 1 } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)

    await client.headBlock()
    expect(seenKey).toBe('test-key')
  })

  it('raises TronError on a non-200 response', async () => {
    const client = createTronGridClient(config, (async () =>
      new Response('rate limited', { status: 429 })) as typeof fetch)

    await expect(client.headBlock()).rejects.toMatchObject({ code: 'RPC_FAILED' })
    await expect(client.headBlock()).rejects.toBeInstanceOf(TronError)
  })

  it('treats an empty discovery result as no transfers', async () => {
    const client = createTronGridClient(
      config,
      stubFetch({ '/transactions/trc20': { success: true, data: [] } }),
    )
    expect(await client.incomingTransfers(ADDR)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/tron/trongrid.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/tron/trongrid"`.

- [ ] **Step 3: Write the implementation**

`src/lib/tron/trongrid.ts`:

```ts
import { TronWeb } from 'tronweb'
import { TronError, type SendArgs, type TronClient, type Trc20Transfer } from './client'
import type { TronConfig } from './config'
import { hexToTronAddress } from './address'

type Json = Record<string, any>

export function createTronGridClient(
  config: TronConfig,
  fetchImpl: typeof fetch = fetch,
): TronClient {
  async function call(path: string, init?: RequestInit): Promise<Json> {
    const headers = new Headers(init?.headers)
    headers.set('accept', 'application/json')
    if (config.apiKey) headers.set('TRON-PRO-API-KEY', config.apiKey)
    if (init?.body) headers.set('content-type', 'application/json')

    const response = await fetchImpl(`${config.fullHost}${path}`, { ...init, headers })
    if (!response.ok) {
      throw new TronError(`TronGrid ${path} returned ${response.status}`, 'RPC_FAILED')
    }
    return (await response.json()) as Json
  }

  async function headBlock(): Promise<number> {
    const body = await call('/wallet/getnowblock', { method: 'POST', body: '{}' })
    const height = body?.block_header?.raw_data?.number
    if (typeof height !== 'number') {
      throw new TronError('getnowblock returned no block number', 'RPC_FAILED')
    }
    return height
  }

  /**
   * Two stages, because the cheap per-address endpoint carries no log index:
   *   1. discover candidate transaction ids for this address
   *   2. read each transaction's events for the authoritative index and block number
   */
  async function incomingTransfers(address: string): Promise<Trc20Transfer[]> {
    const query = new URLSearchParams({
      only_to: 'true',
      limit: '50',
      contract_address: config.usdtContract,
    })
    const discovery = await call(`/v1/accounts/${address}/transactions/trc20?${query}`)
    const rows: Json[] = discovery?.data ?? []

    const txIds = [...new Set(rows.map((r) => r.transaction_id).filter(Boolean))]
    const transfers: Trc20Transfer[] = []

    for (const txId of txIds) {
      const events = await call(`/v1/transactions/${txId}/events`)
      for (const event of (events?.data ?? []) as Json[]) {
        if (event.event_name !== 'Transfer') continue
        if (event.contract_address !== config.usdtContract) continue

        const to = hexToTronAddress(String(event.result?.to ?? ''))
        if (to !== address) continue

        transfers.push({
          txHash: txId,
          logIndex: Number(event.event_index),
          from: hexToTronAddress(String(event.result?.from ?? '')),
          to,
          amountMicros: BigInt(String(event.result?.value ?? '0')),
          blockNumber: Number(event.block_number),
        })
      }
    }

    return transfers.sort((a, b) => b.blockNumber - a.blockNumber)
  }

  function tronWebFor(privateKey?: string): TronWeb {
    return new TronWeb({
      fullHost: config.fullHost,
      headers: config.apiKey ? { 'TRON-PRO-API-KEY': config.apiKey } : undefined,
      privateKey,
    })
  }

  async function trc20Balance(address: string): Promise<bigint> {
    const tronWeb = tronWebFor()
    tronWeb.setAddress(address)
    const contract = await tronWeb.contract().at(config.usdtContract)
    const raw = await contract.balanceOf(address).call()
    return BigInt(raw.toString())
  }

  async function trxBalance(address: string): Promise<bigint> {
    const tronWeb = tronWebFor()
    return BigInt((await tronWeb.trx.getBalance(address)).toString())
  }

  async function sendTrc20(args: SendArgs): Promise<string> {
    const tronWeb = tronWebFor(args.fromPrivateKeyHex)
    try {
      const contract = await tronWeb.contract().at(config.usdtContract)
      const txHash: string = await contract
        .transfer(args.to, args.amountMicros.toString())
        .send({ feeLimit: 40_000_000 })
      return txHash
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = /energy|bandwidth/i.test(message) ? 'INSUFFICIENT_ENERGY' : 'BROADCAST_FAILED'
      throw new TronError(`TRC20 transfer failed: ${message}`, code)
    }
  }

  return { headBlock, incomingTransfers, trc20Balance, trxBalance, sendTrc20 }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/tron/trongrid.test.ts
pnpm typecheck
```

Expected: PASS, 6 tests.

`TEPSrSYPDSQ7yXpMFPq91Fb1QEWpMkRGfn` is not a guess: it is the value the live TronGrid
*discovery* endpoint reported as `from` for this transaction, and the test asserts that
converting the *events* endpoint's hex form reproduces it. If it ever disagrees, the hex
conversion is wrong — do not relax the expectation to match whatever the code emitted.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/tron/trongrid.ts tests/tron/trongrid.test.ts
git commit -m "feat: TronGrid client joining transfer discovery with event indices"
git push origin main
```

<!-- PLAN-CONTINUES -->
