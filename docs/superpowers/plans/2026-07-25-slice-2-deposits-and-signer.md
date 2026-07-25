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

---

## Task 4: Schema and deposit address assignment

**Files:**
- Create: `migrations/0004_deposits.sql`
- Modify: `src/lib/db/schema.ts`, `tests/helpers/db.ts`
- Create: `src/lib/deposits/addresses.ts`
- Test: `tests/deposits/addresses.test.ts`

**Interfaces:**
- Consumes: `deriveAddress`, `Executor`, `Db`
- Produces (`src/lib/deposits/addresses.ts`):
  - `class DepositAddressError extends Error { code: 'ALREADY_ASSIGNED' }`
  - `assignDepositAddress(db: Db, args: { userId: string; xpub: string }): Promise<{ address: string; derivationIndex: number; created: boolean }>`
  - `getDepositAddress(x: Executor, userId: string): Promise<{ address: string; derivationIndex: number } | null>`
  - `listDepositAddresses(x: Executor): Promise<Array<{ userId: string; derivationIndex: number; address: string }>>`

Index allocation must be gap-free and race-free: two simultaneous requests from the same user
must not burn two indices, and two different users must never share one. The implementation
takes a transaction-scoped advisory lock so `MAX(derivation_index) + 1` is safe.

- [ ] **Step 1: Write the migration**

`migrations/0004_deposits.sql`:

```sql
CREATE TYPE deposit_status AS ENUM ('PENDING', 'CREDITED');
CREATE TYPE signer_job_status AS ENUM ('PENDING', 'CLAIMED', 'DONE', 'FAILED');

CREATE TABLE deposit_addresses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  derivation_index INTEGER NOT NULL UNIQUE CHECK (derivation_index >= 0),
  address          TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deposits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  address      TEXT NOT NULL REFERENCES deposit_addresses(address) ON DELETE RESTRICT,
  from_address TEXT NOT NULL,
  amount       BIGINT NOT NULL CHECK (amount > 0),
  block_number BIGINT NOT NULL,
  status       deposit_status NOT NULL DEFAULT 'PENDING',
  ledger_tx_id UUID REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at  TIMESTAMPTZ,
  CONSTRAINT deposits_chain_uq UNIQUE (tx_hash, log_index),
  CONSTRAINT deposits_credited_has_ledger CHECK (
    (status = 'CREDITED' AND ledger_tx_id IS NOT NULL AND credited_at IS NOT NULL)
    OR (status = 'PENDING' AND ledger_tx_id IS NULL AND credited_at IS NULL)
  )
);

CREATE INDEX deposits_status_idx  ON deposits (status);
CREATE INDEX deposits_address_idx ON deposits (address);

CREATE TABLE signer_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload      JSONB NOT NULL,
  status       signer_job_status NOT NULL DEFAULT 'PENDING',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  tx_hash      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX signer_jobs_status_idx ON signer_jobs (status, created_at);

-- Named high-water marks so the poller need not rescan from genesis.
CREATE TABLE chain_cursors (
  name       TEXT PRIMARY KEY,
  value      BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Extend the Drizzle schema**

Append to `src/lib/db/schema.ts`:

```ts
export const depositStatus = pgEnum('deposit_status', ['PENDING', 'CREDITED'])
export const signerJobStatus = pgEnum('signer_job_status', [
  'PENDING',
  'CLAIMED',
  'DONE',
  'FAILED',
])

export const depositAddresses = pgTable('deposit_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  derivationIndex: integer('derivation_index').notNull().unique(),
  address: text('address').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const deposits = pgTable(
  'deposits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    address: text('address')
      .notNull()
      .references(() => depositAddresses.address),
    fromAddress: text('from_address').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    status: depositStatus('status').notNull().default('PENDING'),
    ledgerTxId: uuid('ledger_tx_id').references(() => ledgerTransactions.id),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    creditedAt: timestamp('credited_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('deposits_chain_uq').on(t.txHash, t.logIndex),
    index('deposits_status_idx').on(t.status),
    index('deposits_address_idx').on(t.address),
  ],
)

export const signerJobs = pgTable(
  'signer_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    payload: jsonb('payload').notNull(),
    status: signerJobStatus('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    txHash: text('tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('signer_jobs_status_idx').on(t.status, t.createdAt)],
)

export const chainCursors = pgTable('chain_cursors', {
  name: text('name').primaryKey(),
  value: bigint('value', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

Add `uniqueIndex` to the existing `drizzle-orm/pg-core` import.

- [ ] **Step 3: Extend the truncation helper**

In `tests/helpers/db.ts`, replace the `TRUNCATE` statement with:

```ts
  await db.execute(sql`
    TRUNCATE deposits, deposit_addresses, signer_jobs, chain_cursors,
             ledger_entries, ledger_transactions, settlements, bets, accounts, fights,
             sessions, users
    RESTART IDENTITY CASCADE
  `)
```

- [ ] **Step 4: Write the failing test**

`tests/deposits/addresses.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { ACCOUNT_PATH, deriveAddress } from '@/lib/tron/address'
import {
  assignDepositAddress,
  getDepositAddress,
  listDepositAddresses,
} from '@/lib/deposits/addresses'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(ACCOUNT_PATH)
  .publicExtendedKey

describe('deposit addresses', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('assigns index 0 to the first user', async () => {
    const user = await makeUser(db)
    const assigned = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    expect(assigned.derivationIndex).toBe(0)
    expect(assigned.created).toBe(true)
    expect(assigned.address).toBe(deriveAddress(XPUB, 0))
  })

  it('gives each user the next index without gaps', async () => {
    const users = [await makeUser(db), await makeUser(db), await makeUser(db)]
    const indices: number[] = []
    for (const user of users) {
      indices.push((await assignDepositAddress(db, { userId: user, xpub: XPUB })).derivationIndex)
    }
    expect(indices).toEqual([0, 1, 2])
  })

  it('is idempotent for one user', async () => {
    const user = await makeUser(db)
    const first = await assignDepositAddress(db, { userId: user, xpub: XPUB })
    const second = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    expect(second.created).toBe(false)
    expect(second.address).toBe(first.address)
    expect(second.derivationIndex).toBe(first.derivationIndex)
  })

  it('never issues one index twice under concurrency', async () => {
    // Ten different users requesting simultaneously must receive ten distinct indices.
    const users = await Promise.all(Array.from({ length: 10 }, () => makeUser(db)))
    const results = await Promise.all(
      users.map((userId) => assignDepositAddress(db, { userId, xpub: XPUB })),
    )

    expect(new Set(results.map((r) => r.derivationIndex)).size).toBe(10)
    expect(new Set(results.map((r) => r.address)).size).toBe(10)
    expect(results.map((r) => r.derivationIndex).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
  })

  it('never issues one index twice when the same user races itself', async () => {
    const user = await makeUser(db)
    const results = await Promise.all(
      Array.from({ length: 5 }, () => assignDepositAddress(db, { userId: user, xpub: XPUB })),
    )
    expect(new Set(results.map((r) => r.address)).size).toBe(1)
    expect(await listDepositAddresses(db)).toHaveLength(1)
  })

  it('returns null for a user with no address yet', async () => {
    expect(await getDepositAddress(db, await makeUser(db))).toBeNull()
  })

  it('reads back an assigned address', async () => {
    const user = await makeUser(db)
    const assigned = await assignDepositAddress(db, { userId: user, xpub: XPUB })
    expect(await getDepositAddress(db, user)).toEqual({
      address: assigned.address,
      derivationIndex: assigned.derivationIndex,
    })
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test tests/deposits/addresses.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/deposits/addresses"`.

- [ ] **Step 6: Write the implementation**

`src/lib/deposits/addresses.ts`:

```ts
import { eq, sql } from 'drizzle-orm'
import type { Db, Executor } from '@/lib/db/client'
import { depositAddresses } from '@/lib/db/schema'
import { deriveAddress } from '@/lib/tron/address'

/** Arbitrary constant identifying the index-allocation lock. */
const INDEX_LOCK_KEY = 8_112_026

export type AssignedAddress = { address: string; derivationIndex: number; created: boolean }

export async function getDepositAddress(
  x: Executor,
  userId: string,
): Promise<{ address: string; derivationIndex: number } | null> {
  const rows = await x
    .select({ address: depositAddresses.address, derivationIndex: depositAddresses.derivationIndex })
    .from(depositAddresses)
    .where(eq(depositAddresses.userId, userId))
    .limit(1)
  return rows.length ? rows[0] : null
}

/**
 * Assign this user their permanent deposit address, or return the existing one.
 *
 * Allocation takes a transaction-scoped advisory lock so `MAX(index) + 1` cannot race.
 * Handing two users the same index would point both at one address and make deposits
 * indistinguishable, so the lock is correctness, not throughput tuning.
 */
export async function assignDepositAddress(
  db: Db,
  args: { userId: string; xpub: string },
): Promise<AssignedAddress> {
  const existing = await getDepositAddress(db, args.userId)
  if (existing) return { ...existing, created: false }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INDEX_LOCK_KEY})`)

    // Re-check under the lock: a racing call may have assigned it since our first read.
    const raced = await getDepositAddress(tx, args.userId)
    if (raced) return { ...raced, created: false }

    const [{ next }] = await tx
      .execute<{ next: number }>(
        sql`SELECT COALESCE(MAX(derivation_index) + 1, 0)::int AS next FROM deposit_addresses`,
      )
      .then((r) => r.rows)

    const address = deriveAddress(args.xpub, next)

    await tx
      .insert(depositAddresses)
      .values({ userId: args.userId, derivationIndex: next, address })

    return { address, derivationIndex: next, created: true }
  })
}

export async function listDepositAddresses(
  x: Executor,
): Promise<Array<{ userId: string; derivationIndex: number; address: string }>> {
  return x
    .select({
      userId: depositAddresses.userId,
      derivationIndex: depositAddresses.derivationIndex,
      address: depositAddresses.address,
    })
    .from(depositAddresses)
    .orderBy(depositAddresses.derivationIndex)
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm test tests/deposits/addresses.test.ts
pnpm typecheck
```

Expected: PASS, 7 tests. Run the file three times — the two concurrency tests are the point of
this task, and an intermittent failure there is a real defect, not flake.

- [ ] **Step 8: Commit and push**

```bash
git add migrations/0004_deposits.sql src/lib/db/schema.ts src/lib/deposits tests/deposits tests/helpers/db.ts
git commit -m "feat: deposit address assignment with race-free index allocation"
git push origin main
```

---

## Task 5: Crediting a confirmed deposit

**Files:**
- Create: `src/lib/deposits/credit.ts`
- Test: `tests/deposits/credit.test.ts`

**Interfaces:**
- Consumes: `postTransaction`, `houseAccount`, `userAvailableAccount`, `Trc20Transfer`, `Db`
- Produces (`src/lib/deposits/credit.ts`):
  - `type RecordResult = { depositId: string; alreadyKnown: boolean }`
  - `recordSeenTransfer(db: Db, transfer: Trc20Transfer): Promise<RecordResult | null>` — `null` when the address is not one of ours
  - `creditConfirmedDeposits(db: Db, headBlock: number, confirmations: number): Promise<string[]>` — returns credited deposit ids
  - `class DepositError extends Error { code: 'UNKNOWN_ADDRESS' }`

The ledger legs are identical to an admin credit — `hot_wallet −amount`, `user_available +amount`
— and the idempotency key is `deposit:{txHash}:{logIndex}`.

- [ ] **Step 1: Write the failing test**

`tests/deposits/credit.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { deposits as depositsTable } from '@/lib/db/schema'
import { ACCOUNT_PATH } from '@/lib/tron/address'
import { assignDepositAddress } from '@/lib/deposits/addresses'
import { recordSeenTransfer, creditConfirmedDeposits } from '@/lib/deposits/credit'
import { userBalance, balanceOf, houseAccount } from '@/lib/ledger/accounts'
import type { Trc20Transfer } from '@/lib/tron/client'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(ACCOUNT_PATH)
  .publicExtendedKey
const USDT = 1_000_000n

function transfer(over: Partial<Trc20Transfer> & { to: string }): Trc20Transfer {
  return {
    txHash: 'aa'.repeat(32),
    logIndex: 0,
    from: 'TEPSrSYPDSQ7yXpMFPq91Fb1QEWpMkRGfn',
    amountMicros: 50n * USDT,
    blockNumber: 100,
    ...over,
  }
}

describe('deposit crediting', () => {
  let db: Db
  let user: string
  let address: string

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
    user = await makeUser(db)
    address = (await assignDepositAddress(db, { userId: user, xpub: XPUB })).address
  })

  it('records a seen transfer as PENDING without crediting', async () => {
    const result = await recordSeenTransfer(db, transfer({ to: address }))

    expect(result).not.toBeNull()
    expect(result!.alreadyKnown).toBe(false)
    expect(await userBalance(db, user)).toBe(0n)

    const rows = await db.select().from(depositsTable)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('PENDING')
  })

  it('ignores a transfer to an address we do not own', async () => {
    const result = await recordSeenTransfer(db, transfer({ to: 'TUnknownAddress00000000000000000' }))
    expect(result).toBeNull()
    expect(await db.select().from(depositsTable)).toHaveLength(0)
  })

  it('does not credit before the confirmation threshold', async () => {
    await recordSeenTransfer(db, transfer({ to: address, blockNumber: 100 }))

    // head 118 means 18 confirmations for a block-100 transfer; the threshold is 19.
    expect(await creditConfirmedDeposits(db, 118, 19)).toEqual([])
    expect(await userBalance(db, user)).toBe(0n)
  })

  it('credits once the threshold is reached', async () => {
    await recordSeenTransfer(db, transfer({ to: address, blockNumber: 100 }))

    const credited = await creditConfirmedDeposits(db, 119, 19)
    expect(credited).toHaveLength(1)

    expect(await userBalance(db, user)).toBe(50n * USDT)
    expect(await balanceOf(db, await houseAccount(db, 'hot_wallet'))).toBe(-50n * USDT)

    const [row] = await db.select().from(depositsTable)
    expect(row.status).toBe('CREDITED')
    expect(row.ledgerTxId).not.toBeNull()
    expect(row.creditedAt).not.toBeNull()
  })

  it('is idempotent on (tx_hash, log_index): reseeing writes nothing new', async () => {
    const t = transfer({ to: address, blockNumber: 100 })
    await recordSeenTransfer(db, t)
    const second = await recordSeenTransfer(db, t)

    expect(second!.alreadyKnown).toBe(true)
    expect(await db.select().from(depositsTable)).toHaveLength(1)
  })

  it('does not double-credit when crediting runs twice', async () => {
    await recordSeenTransfer(db, transfer({ to: address, blockNumber: 100 }))

    await creditConfirmedDeposits(db, 200, 19)
    const secondRun = await creditConfirmedDeposits(db, 200, 19)

    expect(secondRun).toEqual([])
    expect(await userBalance(db, user)).toBe(50n * USDT)
  })

  it('treats two transfers sharing a tx hash as distinct deposits', async () => {
    await recordSeenTransfer(db, transfer({ to: address, txHash: 'shared'.padEnd(64, '0'), logIndex: 0, amountMicros: 10n * USDT }))
    await recordSeenTransfer(db, transfer({ to: address, txHash: 'shared'.padEnd(64, '0'), logIndex: 1, amountMicros: 20n * USDT }))

    await creditConfirmedDeposits(db, 200, 19)
    expect(await userBalance(db, user)).toBe(30n * USDT)
  })

  it('credits several users independently in one run', async () => {
    const other = await makeUser(db)
    const otherAddress = (await assignDepositAddress(db, { userId: other, xpub: XPUB })).address

    await recordSeenTransfer(db, transfer({ to: address, txHash: 'a'.repeat(64), amountMicros: 10n * USDT }))
    await recordSeenTransfer(db, transfer({ to: otherAddress, txHash: 'b'.repeat(64), amountMicros: 7n * USDT }))

    expect(await creditConfirmedDeposits(db, 200, 19)).toHaveLength(2)
    expect(await userBalance(db, user)).toBe(10n * USDT)
    expect(await userBalance(db, other)).toBe(7n * USDT)
  })

  it('leaves every ledger transaction balanced', async () => {
    await recordSeenTransfer(db, transfer({ to: address }))
    await creditConfirmedDeposits(db, 200, 19)

    const unbalanced = await db.execute<{ tx_id: string }>(
      sql`SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0`,
    )
    expect(unbalanced.rows).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/deposits/credit.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/deposits/credit"`.

- [ ] **Step 3: Write the implementation**

`src/lib/deposits/credit.ts`:

```ts
import { and, eq, lte, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { depositAddresses, deposits } from '@/lib/db/schema'
import { houseAccount, userAvailableAccount } from '@/lib/ledger/accounts'
import { postTransaction } from '@/lib/ledger/post'
import type { Trc20Transfer } from '@/lib/tron/client'

export class DepositError extends Error {
  constructor(
    message: string,
    readonly code: 'UNKNOWN_ADDRESS',
  ) {
    super(message)
    this.name = 'DepositError'
  }
}

export type RecordResult = { depositId: string; alreadyKnown: boolean }

/**
 * Persist a transfer we have observed on chain. Does not move money — crediting waits
 * for confirmations. Returns `null` when the destination is not one of our addresses,
 * which is normal: TronGrid can return transfers we never asked about.
 */
export async function recordSeenTransfer(
  db: Db,
  transfer: Trc20Transfer,
): Promise<RecordResult | null> {
  const owned = await db
    .select({ address: depositAddresses.address })
    .from(depositAddresses)
    .where(eq(depositAddresses.address, transfer.to))
    .limit(1)
  if (!owned.length) return null

  const inserted = await db
    .insert(deposits)
    .values({
      txHash: transfer.txHash,
      logIndex: transfer.logIndex,
      address: transfer.to,
      fromAddress: transfer.from,
      amount: transfer.amountMicros,
      blockNumber: BigInt(transfer.blockNumber),
    })
    .onConflictDoNothing({ target: [deposits.txHash, deposits.logIndex] })
    .returning({ id: deposits.id })

  if (inserted.length) return { depositId: inserted[0].id, alreadyKnown: false }

  const existing = await db
    .select({ id: deposits.id })
    .from(deposits)
    .where(and(eq(deposits.txHash, transfer.txHash), eq(deposits.logIndex, transfer.logIndex)))
    .limit(1)
  return { depositId: existing[0].id, alreadyKnown: true }
}

/**
 * Credit every PENDING deposit buried at least `confirmations` blocks deep.
 *
 * Each deposit is its own transaction: one failure must not roll back the others, and the
 * ledger idempotency key means a retry after a partial run is safe.
 */
export async function creditConfirmedDeposits(
  db: Db,
  headBlock: number,
  confirmations: number,
): Promise<string[]> {
  const maxBlock = BigInt(headBlock - confirmations + 1)

  const ready = await db
    .select({
      id: deposits.id,
      txHash: deposits.txHash,
      logIndex: deposits.logIndex,
      amount: deposits.amount,
      userId: depositAddresses.userId,
    })
    .from(deposits)
    .innerJoin(depositAddresses, eq(depositAddresses.address, deposits.address))
    .where(and(eq(deposits.status, 'PENDING'), lte(deposits.blockNumber, maxBlock)))

  const credited: string[] = []

  for (const deposit of ready) {
    await db.transaction(async (tx) => {
      // Re-read under the row lock so two workers cannot both credit this deposit.
      const locked = await tx
        .select({ status: deposits.status })
        .from(deposits)
        .where(eq(deposits.id, deposit.id))
        .for('update')
        .limit(1)
      if (!locked.length || locked[0].status !== 'PENDING') return

      const [userAccount, hotWallet] = await Promise.all([
        userAvailableAccount(tx, deposit.userId),
        houseAccount(tx, 'hot_wallet'),
      ])

      const posted = await postTransaction(tx, {
        kind: 'DEPOSIT',
        idempotencyKey: `deposit:${deposit.txHash}:${deposit.logIndex}`,
        metadata: {
          depositId: deposit.id,
          userId: deposit.userId,
          txHash: deposit.txHash,
          logIndex: deposit.logIndex,
        },
        legs: [
          { accountId: hotWallet, amount: -deposit.amount },
          { accountId: userAccount, amount: deposit.amount },
        ],
      })

      await tx
        .update(deposits)
        .set({ status: 'CREDITED', ledgerTxId: posted.txId, creditedAt: sql`now()` })
        .where(eq(deposits.id, deposit.id))

      credited.push(deposit.id)
    })
  }

  return credited
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/deposits/credit.test.ts
pnpm typecheck
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/deposits/credit.ts tests/deposits/credit.test.ts
git commit -m "feat: idempotent deposit crediting after confirmation threshold"
git push origin main
```

<!-- PLAN-CONTINUES -->
