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

---

## Task 6: Deposit poller

**Files:**
- Create: `src/lib/deposits/poller.ts`
- Test: `tests/deposits/poller.test.ts`

**Interfaces:**
- Consumes: `TronClient`, `listDepositAddresses`, `recordSeenTransfer`, `creditConfirmedDeposits`
- Produces (`src/lib/deposits/poller.ts`):
  - `type PollResult = { headBlock: number; addressesScanned: number; newTransfers: number; credited: string[] }`
  - `pollDeposits(db: Db, tron: TronClient, opts: { confirmations: number }): Promise<PollResult>`

One cycle, fully driven by the fake in tests: read head, scan each known address, record what
is new, then credit whatever is now buried deep enough. Errors on one address must not abort
the cycle — a single unlucky address should not stall every other user's deposits.

- [ ] **Step 1: Write the failing test**

`tests/deposits/poller.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { ACCOUNT_PATH } from '@/lib/tron/address'
import { assignDepositAddress } from '@/lib/deposits/addresses'
import { pollDeposits } from '@/lib/deposits/poller'
import { FakeTron } from '@/lib/tron/fake'
import { userBalance } from '@/lib/ledger/accounts'
import type { TronClient } from '@/lib/tron/client'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(ACCOUNT_PATH)
  .publicExtendedKey
const USDT = 1_000_000n
const CONF = { confirmations: 19 }

describe('pollDeposits', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('does nothing when no addresses are assigned', async () => {
    const tron = new FakeTron()
    const result = await pollDeposits(db, tron, CONF)
    expect(result).toMatchObject({ addressesScanned: 0, newTransfers: 0, credited: [] })
  })

  it('records a transfer but withholds credit until confirmed', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    const tron = new FakeTron()
    tron.setHead(1000)
    tron.deposit({ to: address, amountMicros: 40n * USDT, blockNumber: 1000 })

    const first = await pollDeposits(db, tron, CONF)
    expect(first.newTransfers).toBe(1)
    expect(first.credited).toEqual([])
    expect(await userBalance(db, user)).toBe(0n)

    tron.setHead(1018) // 19 blocks deep requires head 1018 for a block-1000 transfer
    const second = await pollDeposits(db, tron, CONF)
    expect(second.credited).toHaveLength(1)
    expect(await userBalance(db, user)).toBe(40n * USDT)
  })

  it('is safe to run repeatedly — no double credit, no duplicate rows', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    const tron = new FakeTron()
    tron.deposit({ to: address, amountMicros: 12n * USDT, blockNumber: 1000 })
    tron.setHead(2000)

    await pollDeposits(db, tron, CONF)
    await pollDeposits(db, tron, CONF)
    const third = await pollDeposits(db, tron, CONF)

    expect(third.newTransfers).toBe(0)
    expect(third.credited).toEqual([])
    expect(await userBalance(db, user)).toBe(12n * USDT)
  })

  it('scans every assigned address', async () => {
    const users = [await makeUser(db), await makeUser(db)]
    const addresses = []
    for (const u of users) {
      addresses.push((await assignDepositAddress(db, { userId: u, xpub: XPUB })).address)
    }

    const tron = new FakeTron()
    tron.deposit({ to: addresses[0], amountMicros: 5n * USDT, blockNumber: 1000 })
    tron.deposit({ to: addresses[1], amountMicros: 6n * USDT, blockNumber: 1000 })
    tron.setHead(2000)

    const result = await pollDeposits(db, tron, CONF)
    expect(result.addressesScanned).toBe(2)
    expect(result.credited).toHaveLength(2)
    expect(await userBalance(db, users[0])).toBe(5n * USDT)
    expect(await userBalance(db, users[1])).toBe(6n * USDT)
  })

  it('keeps going when one address fails to read', async () => {
    const users = [await makeUser(db), await makeUser(db)]
    const addresses = []
    for (const u of users) {
      addresses.push((await assignDepositAddress(db, { userId: u, xpub: XPUB })).address)
    }

    const inner = new FakeTron()
    inner.deposit({ to: addresses[1], amountMicros: 9n * USDT, blockNumber: 1000 })
    inner.setHead(2000)

    // A client that throws for exactly one address.
    const flaky: TronClient = {
      headBlock: () => inner.headBlock(),
      incomingTransfers: (address) => {
        if (address === addresses[0]) return Promise.reject(new Error('rpc exploded'))
        return inner.incomingTransfers(address)
      },
      trc20Balance: (a) => inner.trc20Balance(a),
      trxBalance: (a) => inner.trxBalance(a),
      sendTrc20: (a) => inner.sendTrc20(a),
    }

    const result = await pollDeposits(db, flaky, CONF)
    expect(result.addressesScanned).toBe(2)
    expect(await userBalance(db, users[1])).toBe(9n * USDT)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/deposits/poller.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/deposits/poller"`.

- [ ] **Step 3: Write the implementation**

`src/lib/deposits/poller.ts`:

```ts
import type { Db } from '@/lib/db/client'
import type { TronClient } from '@/lib/tron/client'
import { listDepositAddresses } from './addresses'
import { creditConfirmedDeposits, recordSeenTransfer } from './credit'

export type PollResult = {
  headBlock: number
  addressesScanned: number
  newTransfers: number
  credited: string[]
}

/**
 * One poll cycle. A read failure on a single address is logged and skipped rather than
 * aborting the cycle: one unlucky address must not stall every other user's deposits.
 */
export async function pollDeposits(
  db: Db,
  tron: TronClient,
  opts: { confirmations: number },
): Promise<PollResult> {
  const headBlock = await tron.headBlock()
  const addresses = await listDepositAddresses(db)
  let newTransfers = 0

  for (const { address } of addresses) {
    try {
      for (const transfer of await tron.incomingTransfers(address)) {
        const recorded = await recordSeenTransfer(db, transfer)
        if (recorded && !recorded.alreadyKnown) newTransfers++
      }
    } catch (err) {
      console.error(`[poller] failed to read ${address}:`, err)
    }
  }

  const credited = await creditConfirmedDeposits(db, headBlock, opts.confirmations)
  return { headBlock, addressesScanned: addresses.length, newTransfers, credited }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/deposits/poller.test.ts
pnpm typecheck
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/deposits/poller.ts tests/deposits/poller.test.ts
git commit -m "feat: deposit poller cycle resilient to per-address read failures"
git push origin main
```

---

## Task 7: Sweep policy and signer job queue

**Files:**
- Create: `src/lib/signer/jobs.ts`, `src/lib/signer/sweep.ts`
- Test: `tests/signer/jobs.test.ts`, `tests/signer/sweep.test.ts`

**Interfaces:**
- Consumes: `Db`, `TronClient`, `listDepositAddresses`, `signerJobs`
- Produces (`src/lib/signer/jobs.ts`):
  - `type SignerJob = { id: string; kind: string; payload: Record<string, unknown>; attempts: number }`
  - `enqueueJob(db: Db, args: { kind: string; idempotencyKey: string; payload: Record<string, unknown> }): Promise<{ jobId: string; created: boolean }>`
  - `claimNextJob(db: Db): Promise<SignerJob | null>`
  - `completeJob(db: Db, jobId: string, txHash: string): Promise<void>`
  - `failJob(db: Db, jobId: string, error: string, opts?: { retry?: boolean }): Promise<void>`
  - `MAX_ATTEMPTS = 5`
- Produces (`src/lib/signer/sweep.ts`):
  - `type SweepPayload = { derivationIndex: number; address: string; amountMicros: string }`
  - `planSweeps(db: Db, tron: TronClient, opts: { minMicros: bigint }): Promise<SweepPayload[]>`
  - `enqueueSweeps(db: Db, tron: TronClient, opts: { minMicros: bigint }): Promise<number>`

The sweep idempotency key is `sweep:{address}:{amountMicros}`, so re-planning an unchanged
balance does not queue a second job, while a genuinely larger balance later does.

- [ ] **Step 1: Write the failing job-queue test**

`tests/signer/jobs.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import type { Db } from '@/lib/db/client'
import { signerJobs } from '@/lib/db/schema'
import { enqueueJob, claimNextJob, completeJob, failJob, MAX_ATTEMPTS } from '@/lib/signer/jobs'

describe('signer job queue', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const job = (key: string) => ({ kind: 'SWEEP', idempotencyKey: key, payload: { address: 'T1' } })

  it('enqueues a pending job', async () => {
    const result = await enqueueJob(db, job('k1'))
    expect(result.created).toBe(true)

    const [row] = await db.select().from(signerJobs)
    expect(row.status).toBe('PENDING')
    expect(row.attempts).toBe(0)
  })

  it('is idempotent on the key', async () => {
    const first = await enqueueJob(db, job('dup'))
    const second = await enqueueJob(db, job('dup'))

    expect(second.created).toBe(false)
    expect(second.jobId).toBe(first.jobId)
    expect(await db.select().from(signerJobs)).toHaveLength(1)
  })

  it('claims a job and marks it CLAIMED', async () => {
    await enqueueJob(db, job('k1'))
    const claimed = await claimNextJob(db)

    expect(claimed).not.toBeNull()
    expect(claimed!.attempts).toBe(1)

    const [row] = await db.select().from(signerJobs)
    expect(row.status).toBe('CLAIMED')
    expect(row.claimedAt).not.toBeNull()
  })

  it('returns null when there is nothing to claim', async () => {
    expect(await claimNextJob(db)).toBeNull()
  })

  it('never hands one job to two concurrent claimants', async () => {
    await enqueueJob(db, job('only-one'))
    const claims = await Promise.all([claimNextJob(db), claimNextJob(db), claimNextJob(db)])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('completes a job with its transaction hash', async () => {
    const { jobId } = await enqueueJob(db, job('k1'))
    await claimNextJob(db)
    await completeJob(db, jobId, 'abc123')

    const [row] = await db.select().from(signerJobs).where(eq(signerJobs.id, jobId))
    expect(row.status).toBe('DONE')
    expect(row.txHash).toBe('abc123')
    expect(row.completedAt).not.toBeNull()
  })

  it('returns a retryable failure to PENDING', async () => {
    const { jobId } = await enqueueJob(db, job('k1'))
    await claimNextJob(db)
    await failJob(db, jobId, 'temporary rpc error', { retry: true })

    const [row] = await db.select().from(signerJobs).where(eq(signerJobs.id, jobId))
    expect(row.status).toBe('PENDING')
    expect(row.lastError).toBe('temporary rpc error')
    expect(await claimNextJob(db)).not.toBeNull()
  })

  it('marks a non-retryable failure FAILED', async () => {
    const { jobId } = await enqueueJob(db, job('k1'))
    await claimNextJob(db)
    await failJob(db, jobId, 'bad address', { retry: false })

    const [row] = await db.select().from(signerJobs).where(eq(signerJobs.id, jobId))
    expect(row.status).toBe('FAILED')
    expect(await claimNextJob(db)).toBeNull()
  })

  it('stops retrying after MAX_ATTEMPTS', async () => {
    const { jobId } = await enqueueJob(db, job('k1'))
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const claimed = await claimNextJob(db)
      expect(claimed).not.toBeNull()
      await failJob(db, jobId, `attempt ${i}`, { retry: true })
    }

    const [row] = await db.select().from(signerJobs).where(eq(signerJobs.id, jobId))
    expect(row.status).toBe('FAILED')
    expect(await claimNextJob(db)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/signer/jobs.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/signer/jobs"`.

- [ ] **Step 3: Write the job queue**

`src/lib/signer/jobs.ts`:

```ts
import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { signerJobs } from '@/lib/db/schema'

export const MAX_ATTEMPTS = 5

export type SignerJob = {
  id: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
}

export async function enqueueJob(
  db: Db,
  args: { kind: string; idempotencyKey: string; payload: Record<string, unknown> },
): Promise<{ jobId: string; created: boolean }> {
  const inserted = await db
    .insert(signerJobs)
    .values({ kind: args.kind, idempotencyKey: args.idempotencyKey, payload: args.payload })
    .onConflictDoNothing({ target: signerJobs.idempotencyKey })
    .returning({ id: signerJobs.id })

  if (inserted.length) return { jobId: inserted[0].id, created: true }

  const existing = await db
    .select({ id: signerJobs.id })
    .from(signerJobs)
    .where(eq(signerJobs.idempotencyKey, args.idempotencyKey))
    .limit(1)
  return { jobId: existing[0].id, created: false }
}

/**
 * Claim the oldest pending job. `FOR UPDATE SKIP LOCKED` means several signer instances
 * could run without ever handing one job to two of them.
 */
export async function claimNextJob(db: Db): Promise<SignerJob | null> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: signerJobs.id })
      .from(signerJobs)
      .where(eq(signerJobs.status, 'PENDING'))
      .orderBy(asc(signerJobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true })

    if (!candidates.length) return null

    const [claimed] = await tx
      .update(signerJobs)
      .set({
        status: 'CLAIMED',
        attempts: sql`${signerJobs.attempts} + 1`,
        claimedAt: sql`now()`,
      })
      .where(eq(signerJobs.id, candidates[0].id))
      .returning({
        id: signerJobs.id,
        kind: signerJobs.kind,
        payload: signerJobs.payload,
        attempts: signerJobs.attempts,
      })

    return {
      id: claimed.id,
      kind: claimed.kind,
      payload: claimed.payload as Record<string, unknown>,
      attempts: claimed.attempts,
    }
  })
}

export async function completeJob(db: Db, jobId: string, txHash: string): Promise<void> {
  await db
    .update(signerJobs)
    .set({ status: 'DONE', txHash, completedAt: sql`now()`, lastError: null })
    .where(eq(signerJobs.id, jobId))
}

/**
 * A retryable failure goes back to PENDING until MAX_ATTEMPTS is exhausted, after which it
 * is parked as FAILED for a human. Broadcasting blindly forever would burn gas on a
 * transaction that cannot succeed.
 */
export async function failJob(
  db: Db,
  jobId: string,
  error: string,
  opts: { retry?: boolean } = {},
): Promise<void> {
  const rows = await db
    .select({ attempts: signerJobs.attempts })
    .from(signerJobs)
    .where(eq(signerJobs.id, jobId))
    .limit(1)
  if (!rows.length) return

  const exhausted = rows[0].attempts >= MAX_ATTEMPTS
  const status = opts.retry && !exhausted ? 'PENDING' : 'FAILED'

  await db
    .update(signerJobs)
    .set({
      status,
      lastError: error,
      completedAt: status === 'FAILED' ? sql`now()` : null,
    })
    .where(eq(signerJobs.id, jobId))
}
```

- [ ] **Step 4: Write the failing sweep test**

`tests/signer/sweep.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { signerJobs } from '@/lib/db/schema'
import { ACCOUNT_PATH } from '@/lib/tron/address'
import { assignDepositAddress } from '@/lib/deposits/addresses'
import { planSweeps, enqueueSweeps } from '@/lib/signer/sweep'
import { FakeTron } from '@/lib/tron/fake'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(ACCOUNT_PATH)
  .publicExtendedKey
const USDT = 1_000_000n
const OPTS = { minMicros: 20n * USDT }

describe('sweep planning', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  async function addressFor(): Promise<string> {
    return (await assignDepositAddress(db, { userId: await makeUser(db), xpub: XPUB })).address
  }

  it('ignores a balance below the threshold', async () => {
    const address = await addressFor()
    const tron = new FakeTron()
    tron.deposit({ to: address, amountMicros: 19n * USDT, blockNumber: 1 })

    expect(await planSweeps(db, tron, OPTS)).toEqual([])
  })

  it('plans a sweep at exactly the threshold', async () => {
    const address = await addressFor()
    const tron = new FakeTron()
    tron.deposit({ to: address, amountMicros: 20n * USDT, blockNumber: 1 })

    const plans = await planSweeps(db, tron, OPTS)
    expect(plans).toEqual([
      { derivationIndex: 0, address, amountMicros: (20n * USDT).toString() },
    ])
  })

  it('plans nothing for an empty address', async () => {
    await addressFor()
    expect(await planSweeps(db, new FakeTron(), OPTS)).toEqual([])
  })

  it('enqueues one job per sweepable address', async () => {
    const a = await addressFor()
    const b = await addressFor()
    const tron = new FakeTron()
    tron.deposit({ to: a, amountMicros: 25n * USDT, blockNumber: 1 })
    tron.deposit({ to: b, amountMicros: 1n * USDT, blockNumber: 1 })

    expect(await enqueueSweeps(db, tron, OPTS)).toBe(1)
    const jobs = await db.select().from(signerJobs)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].kind).toBe('SWEEP')
  })

  it('does not re-enqueue while the balance is unchanged', async () => {
    const address = await addressFor()
    const tron = new FakeTron()
    tron.deposit({ to: address, amountMicros: 25n * USDT, blockNumber: 1 })

    await enqueueSweeps(db, tron, OPTS)
    expect(await enqueueSweeps(db, tron, OPTS)).toBe(0)
    expect(await db.select().from(signerJobs)).toHaveLength(1)
  })

  it('enqueues again once more funds arrive', async () => {
    const address = await addressFor()
    const tron = new FakeTron()
    tron.deposit({ to: address, amountMicros: 25n * USDT, blockNumber: 1 })
    await enqueueSweeps(db, tron, OPTS)

    tron.deposit({ to: address, amountMicros: 5n * USDT, blockNumber: 2 })
    expect(await enqueueSweeps(db, tron, OPTS)).toBe(1)
    expect(await db.select().from(signerJobs)).toHaveLength(2)
  })
})
```

- [ ] **Step 5: Write the sweep module**

`src/lib/signer/sweep.ts`:

```ts
import type { Db } from '@/lib/db/client'
import type { TronClient } from '@/lib/tron/client'
import { listDepositAddresses } from '@/lib/deposits/addresses'
import { enqueueJob } from './jobs'

export type SweepPayload = {
  derivationIndex: number
  address: string
  /** Serialised because JSONB cannot hold a bigint. */
  amountMicros: string
}

/**
 * Sweeping costs TRX for energy and bandwidth, so it is only economical above a threshold.
 * Funds below it stay at the deposit address; the user's ledger balance is already credited
 * and spendable, so this is expected behaviour rather than a stuck deposit.
 */
export async function planSweeps(
  db: Db,
  tron: TronClient,
  opts: { minMicros: bigint },
): Promise<SweepPayload[]> {
  const addresses = await listDepositAddresses(db)
  const plans: SweepPayload[] = []

  for (const { address, derivationIndex } of addresses) {
    try {
      const balance = await tron.trc20Balance(address)
      if (balance < opts.minMicros) continue
      plans.push({ derivationIndex, address, amountMicros: balance.toString() })
    } catch (err) {
      console.error(`[sweep] failed to read balance for ${address}:`, err)
    }
  }

  return plans
}

export async function enqueueSweeps(
  db: Db,
  tron: TronClient,
  opts: { minMicros: bigint },
): Promise<number> {
  let created = 0

  for (const plan of await planSweeps(db, tron, opts)) {
    // Keying on the amount means an unchanged balance re-plans to the same job, while a
    // genuinely larger balance later produces a new one.
    const result = await enqueueJob(db, {
      kind: 'SWEEP',
      idempotencyKey: `sweep:${plan.address}:${plan.amountMicros}`,
      payload: plan as unknown as Record<string, unknown>,
    })
    if (result.created) created++
  }

  return created
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm test tests/signer
pnpm typecheck
```

Expected: PASS, 9 + 6 = 15 tests.

- [ ] **Step 7: Commit and push**

```bash
git add src/lib/signer tests/signer
git commit -m "feat: signer job queue and sweep threshold policy"
git push origin main
```

---

## Task 8: Signer key derivation and execution loop

The only module in the codebase that touches the master seed. Treat every line as security-
sensitive.

**Files:**
- Create: `src/lib/signer/keys.ts`, `src/lib/signer/run.ts`
- Test: `tests/signer/keys.test.ts`, `tests/signer/run.test.ts`

**Interfaces:**
- Consumes: `TronClient`, `claimNextJob`, `completeJob`, `failJob`, `SweepPayload`, `deriveAddress`
- Produces (`src/lib/signer/keys.ts`):
  - `loadSignerSeed(env?: NodeJS.ProcessEnv): Uint8Array`
  - `derivePrivateKeyHex(seed: Uint8Array, index: number): string`
  - `deriveXpub(seed: Uint8Array): string`
  - `assertMatchesXpub(seed: Uint8Array, xpub: string, index?: number): void`
- Produces (`src/lib/signer/run.ts`):
  - `type SignerDeps = { db: Db; tron: TronClient; seed: Uint8Array; hotWalletAddress: string }`
  - `runOnce(deps: SignerDeps): Promise<'idle' | 'done' | 'failed'>`

- [ ] **Step 1: Write the failing key test**

`tests/signer/keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mnemonicToSeedSync } from '@scure/bip39'
import { TronWeb } from 'tronweb'
import { derivePrivateKeyHex, deriveXpub, assertMatchesXpub, loadSignerSeed } from '@/lib/signer/keys'
import { deriveAddress } from '@/lib/tron/address'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEED = mnemonicToSeedSync(MNEMONIC)

describe('signer keys', () => {
  it('derives a key whose address matches the xpub-derived address', () => {
    const xpub = deriveXpub(SEED)
    for (let i = 0; i < 10; i++) {
      const priv = derivePrivateKeyHex(SEED, i)
      expect(TronWeb.address.fromPrivateKey(priv)).toBe(deriveAddress(xpub, i))
    }
  })

  it('produces a 64-character hex private key', () => {
    expect(derivePrivateKeyHex(SEED, 0)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('derives the expected xpub for the standard test mnemonic', () => {
    expect(deriveAddress(deriveXpub(SEED), 0)).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')
  })

  it('rejects a negative or non-integer index', () => {
    expect(() => derivePrivateKeyHex(SEED, -1)).toThrow(RangeError)
    expect(() => derivePrivateKeyHex(SEED, 2.5)).toThrow(RangeError)
  })

  it('assertMatchesXpub passes for the matching xpub', () => {
    expect(() => assertMatchesXpub(SEED, deriveXpub(SEED))).not.toThrow()
  })

  it('assertMatchesXpub throws when seed and xpub disagree', () => {
    // The catastrophic misconfiguration: web hands out addresses from one wallet while the
    // signer holds a different seed, so swept funds and deposits diverge permanently.
    const otherSeed = mnemonicToSeedSync(
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
    )
    expect(() => assertMatchesXpub(otherSeed, deriveXpub(SEED))).toThrow(/does not match/i)
  })

  it('loadSignerSeed refuses to start without a mnemonic', () => {
    expect(() => loadSignerSeed({} as NodeJS.ProcessEnv)).toThrow(/TRON_MNEMONIC/)
  })

  it('loadSignerSeed accepts a valid mnemonic', () => {
    const seed = loadSignerSeed({ TRON_MNEMONIC: MNEMONIC } as NodeJS.ProcessEnv)
    expect(Buffer.from(seed).toString('hex')).toBe(Buffer.from(SEED).toString('hex'))
  })

  it('loadSignerSeed rejects an invalid mnemonic', () => {
    expect(() =>
      loadSignerSeed({ TRON_MNEMONIC: 'not actually a valid bip39 phrase at all' } as NodeJS.ProcessEnv),
    ).toThrow(/mnemonic/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/signer/keys.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/signer/keys"`.

- [ ] **Step 3: Write the keys module**

`src/lib/signer/keys.ts`:

```ts
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { ACCOUNT_PATH, deriveAddress } from '@/lib/tron/address'

/**
 * SIGNER PROCESS ONLY.
 *
 * Nothing in this file may be imported by `web` or `worker`. It is the single point at
 * which spending material enters the system.
 */
export function loadSignerSeed(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const mnemonic = env.TRON_MNEMONIC?.trim()
  if (!mnemonic) throw new Error('TRON_MNEMONIC is not set; the signer cannot start')
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('TRON_MNEMONIC is not a valid BIP39 mnemonic')
  }
  return mnemonicToSeedSync(mnemonic)
}

export function deriveXpub(seed: Uint8Array): string {
  return HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH).publicExtendedKey
}

export function derivePrivateKeyHex(seed: Uint8Array, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`derivation index must be a non-negative integer, got ${index}`)
  }
  const key = HDKey.fromMasterSeed(seed).derive(`${ACCOUNT_PATH}/${index}`).privateKey
  if (!key) throw new Error(`could not derive private key at index ${index}`)
  return Buffer.from(key).toString('hex')
}

/**
 * Fail fast on the catastrophic misconfiguration: if the signer's seed does not correspond
 * to the xpub the web app hands out, deposits go to addresses this signer cannot spend and
 * sweeps move funds nobody expected. Checked at signer startup.
 */
export function assertMatchesXpub(seed: Uint8Array, xpub: string, index = 0): void {
  const fromSeed = deriveAddress(deriveXpub(seed), index)
  const fromXpub = deriveAddress(xpub, index)
  if (fromSeed !== fromXpub) {
    throw new Error(
      `signer seed does not match TRON_XPUB: index ${index} derives ${fromSeed} from the seed ` +
        `but ${fromXpub} from the xpub`,
    )
  }
}
```

- [ ] **Step 4: Write the failing runner test**

`tests/signer/run.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mnemonicToSeedSync } from '@scure/bip39'
import { eq } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { signerJobs } from '@/lib/db/schema'
import { assignDepositAddress } from '@/lib/deposits/addresses'
import { deriveXpub } from '@/lib/signer/keys'
import { enqueueSweeps } from '@/lib/signer/sweep'
import { enqueueJob } from '@/lib/signer/jobs'
import { runOnce } from '@/lib/signer/run'
import { FakeTron } from '@/lib/tron/fake'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEED = mnemonicToSeedSync(MNEMONIC)
const XPUB = deriveXpub(SEED)
const USDT = 1_000_000n
// Index 99 of the same test wallet, so the hot wallet is provably ours and reproducible.
const HOT = 'TTTFe9haCY6CACG9iTM8uyL89pFEPy4ctW'

describe('signer runOnce', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  async function seedSweepableAddress(tron: FakeTron, amount: bigint): Promise<string> {
    const { address } = await assignDepositAddress(db, { userId: await makeUser(db), xpub: XPUB })
    tron.deposit({ to: address, amountMicros: amount, blockNumber: 1 })
    return address
  }

  it('is idle with no jobs', async () => {
    const tron = new FakeTron()
    expect(await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })).toBe('idle')
  })

  it('sweeps a deposit address into the hot wallet', async () => {
    const tron = new FakeTron()
    const address = await seedSweepableAddress(tron, 25n * USDT)
    await enqueueSweeps(db, tron, { minMicros: 20n * USDT })

    expect(await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })).toBe('done')

    expect(tron.broadcasts).toHaveLength(1)
    expect(tron.broadcasts[0]).toMatchObject({ from: address, to: HOT, amountMicros: 25n * USDT })
    expect(await tron.trc20Balance(address)).toBe(0n)
    expect(await tron.trc20Balance(HOT)).toBe(25n * USDT)
  })

  it('records the broadcast hash on the completed job', async () => {
    const tron = new FakeTron()
    await seedSweepableAddress(tron, 25n * USDT)
    await enqueueSweeps(db, tron, { minMicros: 20n * USDT })
    await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })

    const [job] = await db.select().from(signerJobs)
    expect(job.status).toBe('DONE')
    expect(job.txHash).toBe(tron.broadcasts[0].txHash)
  })

  it('returns a broadcast failure to PENDING for retry', async () => {
    const tron = new FakeTron()
    await seedSweepableAddress(tron, 25n * USDT)
    await enqueueSweeps(db, tron, { minMicros: 20n * USDT })
    tron.failNextSend('temporary node error')

    expect(await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })).toBe('failed')

    const [job] = await db.select().from(signerJobs)
    expect(job.status).toBe('PENDING')
    expect(job.lastError).toMatch(/temporary node error/)

    // The retry succeeds and moves the money.
    expect(await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })).toBe('done')
    expect(tron.broadcasts).toHaveLength(1)
  })

  it('parks an unknown job kind as FAILED without retrying', async () => {
    await enqueueJob(db, { kind: 'NOT_A_REAL_KIND', idempotencyKey: 'weird', payload: {} })
    const tron = new FakeTron()

    expect(await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })).toBe('failed')

    const [job] = await db.select().from(signerJobs)
    expect(job.status).toBe('FAILED')
    expect(job.lastError).toMatch(/unknown job kind/i)
  })

  it('processes one job per call', async () => {
    const tron = new FakeTron()
    await seedSweepableAddress(tron, 25n * USDT)
    await seedSweepableAddress(tron, 30n * USDT)
    await enqueueSweeps(db, tron, { minMicros: 20n * USDT })

    await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })
    expect(tron.broadcasts).toHaveLength(1)

    await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })
    expect(tron.broadcasts).toHaveLength(2)

    expect(await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })).toBe('idle')
  })
})
```

- [ ] **Step 5: Write the runner**

`src/lib/signer/run.ts`:

```ts
import type { Db } from '@/lib/db/client'
import { TronError, type TronClient } from '@/lib/tron/client'
import { claimNextJob, completeJob, failJob } from './jobs'
import { derivePrivateKeyHex } from './keys'
import type { SweepPayload } from './sweep'

export type SignerDeps = {
  db: Db
  tron: TronClient
  seed: Uint8Array
  hotWalletAddress: string
}

export type RunOutcome = 'idle' | 'done' | 'failed'

/**
 * Claim and execute at most one job. Returning after a single job keeps the loop's failure
 * blast radius small and lets the caller decide the pacing.
 */
export async function runOnce(deps: SignerDeps): Promise<RunOutcome> {
  const job = await claimNextJob(deps.db)
  if (!job) return 'idle'

  if (job.kind !== 'SWEEP') {
    await failJob(deps.db, job.id, `unknown job kind: ${job.kind}`, { retry: false })
    return 'failed'
  }

  const payload = job.payload as unknown as SweepPayload

  try {
    const privateKeyHex = derivePrivateKeyHex(deps.seed, payload.derivationIndex)

    const txHash = await deps.tron.sendTrc20({
      fromPrivateKeyHex: privateKeyHex,
      to: deps.hotWalletAddress,
      amountMicros: BigInt(payload.amountMicros),
    })

    await completeJob(deps.db, job.id, txHash)
    return 'done'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // A TronError is a chain-side problem: the node was unreachable, the address was out of
    // energy, the broadcast bounced. All of those can succeed later, so retry until
    // MAX_ATTEMPTS parks the job for a human.
    //
    // Anything else came from our own code — a bad derivation index, a malformed payload —
    // and will fail identically every time. Retrying it just burns attempts and delays the
    // alert, so park it immediately.
    const retry = err instanceof TronError
    await failJob(deps.db, job.id, message, { retry })
    return 'failed'
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm test tests/signer
pnpm typecheck
```

Expected: PASS, 9 + 6 + 6 = 21 tests in `tests/signer`.

- [ ] **Step 7: Commit and push**

```bash
git add src/lib/signer tests/signer
git commit -m "feat: signer key derivation and sweep execution loop"
git push origin main
```

---

## Task 9: Worker and signer process entrypoints

**Files:**
- Create: `worker/main.ts`, `signer/main.ts`, `src/lib/process/loop.ts`
- Modify: `package.json` (add `worker` and `signer` scripts)
- Test: `tests/process/loop.test.ts`

**Interfaces:**
- Consumes: `pollDeposits`, `enqueueSweeps`, `runOnce`, `loadTronConfig`, `loadSignerSeed`, `assertMatchesXpub`
- Produces (`src/lib/process/loop.ts`):
  - `type LoopOptions = { intervalMs: number; signal: AbortSignal; onTick: () => Promise<void>; onError?: (err: unknown) => void }`
  - `runLoop(opts: LoopOptions): Promise<void>`

- [ ] **Step 1: Write the failing test**

`tests/process/loop.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runLoop } from '@/lib/process/loop'

describe('runLoop', () => {
  it('ticks repeatedly until aborted', async () => {
    const controller = new AbortController()
    let ticks = 0

    const loop = runLoop({
      intervalMs: 1,
      signal: controller.signal,
      onTick: async () => {
        ticks++
        if (ticks >= 5) controller.abort()
      },
    })

    await loop
    expect(ticks).toBe(5)
  })

  it('survives a throwing tick and reports it', async () => {
    const controller = new AbortController()
    const errors: unknown[] = []
    let ticks = 0

    await runLoop({
      intervalMs: 1,
      signal: controller.signal,
      onTick: async () => {
        ticks++
        if (ticks === 1) throw new Error('transient')
        if (ticks >= 3) controller.abort()
      },
      onError: (err) => errors.push(err),
    })

    expect(ticks).toBe(3)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('transient')
  })

  it('does not tick at all if aborted before starting', async () => {
    const controller = new AbortController()
    controller.abort()
    let ticks = 0

    await runLoop({
      intervalMs: 1,
      signal: controller.signal,
      onTick: async () => {
        ticks++
      },
    })

    expect(ticks).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/process/loop.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/process/loop"`.

- [ ] **Step 3: Write the loop**

`src/lib/process/loop.ts`:

```ts
export type LoopOptions = {
  intervalMs: number
  signal: AbortSignal
  onTick: () => Promise<void>
  onError?: (err: unknown) => void
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
  })
}

/**
 * Tick until aborted. A throwing tick is reported and the loop continues — a long-running
 * chain watcher that exits on the first RPC hiccup is worse than useless.
 */
export async function runLoop(opts: LoopOptions): Promise<void> {
  while (!opts.signal.aborted) {
    try {
      await opts.onTick()
    } catch (err) {
      opts.onError?.(err)
    }
    if (opts.signal.aborted) break
    await delay(opts.intervalMs, opts.signal)
  }
}
```

- [ ] **Step 4: Write the worker entrypoint**

`worker/main.ts`:

```ts
import 'dotenv/config'
import { createDb } from '../src/lib/db/client'
import { loadTronConfig } from '../src/lib/tron/config'
import { createTronGridClient } from '../src/lib/tron/trongrid'
import { pollDeposits } from '../src/lib/deposits/poller'
import { enqueueSweeps } from '../src/lib/signer/sweep'
import { runLoop } from '../src/lib/process/loop'

const POLL_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? '15000')

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

// The worker is watch-only. If a seed leaks into its environment, refuse to start rather
// than quietly run a process that could spend.
if (process.env.TRON_MNEMONIC) {
  throw new Error('TRON_MNEMONIC must not be set in the worker environment')
}

const config = loadTronConfig()
const { db, pool } = createDb(url)
const tron = createTronGridClient(config)
const controller = new AbortController()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[worker] ${signal} received, shutting down`)
    controller.abort()
  })
}

console.log(`[worker] polling ${config.network} every ${POLL_INTERVAL_MS}ms`)

await runLoop({
  intervalMs: POLL_INTERVAL_MS,
  signal: controller.signal,
  onError: (err) => console.error('[worker] tick failed:', err),
  onTick: async () => {
    const result = await pollDeposits(db, tron, { confirmations: config.confirmations })
    if (result.newTransfers || result.credited.length) {
      console.log(
        `[worker] head=${result.headBlock} new=${result.newTransfers} credited=${result.credited.length}`,
      )
    }
    const queued = await enqueueSweeps(db, tron, { minMicros: config.sweepMinMicros })
    if (queued) console.log(`[worker] queued ${queued} sweep job(s)`)
  },
})

await pool.end()
console.log('[worker] stopped')
```

- [ ] **Step 5: Write the signer entrypoint**

`signer/main.ts`:

```ts
import 'dotenv/config'
import { createDb } from '../src/lib/db/client'
import { loadTronConfig } from '../src/lib/tron/config'
import { createTronGridClient } from '../src/lib/tron/trongrid'
import { loadSignerSeed, assertMatchesXpub } from '../src/lib/signer/keys'
import { runOnce } from '../src/lib/signer/run'
import { runLoop } from '../src/lib/process/loop'

const INTERVAL_MS = Number(process.env.SIGNER_INTERVAL_MS ?? '5000')

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

const config = loadTronConfig()
const seed = loadSignerSeed()

// Fail fast if the seed and the xpub the web app publishes are different wallets.
assertMatchesXpub(seed, config.xpub)

const { db, pool } = createDb(url)
const tron = createTronGridClient(config)
const controller = new AbortController()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[signer] ${signal} received, shutting down`)
    controller.abort()
  })
}

console.log(`[signer] watching for jobs on ${config.network} every ${INTERVAL_MS}ms`)

await runLoop({
  intervalMs: INTERVAL_MS,
  signal: controller.signal,
  onError: (err) => console.error('[signer] tick failed:', err),
  onTick: async () => {
    // Drain the queue rather than sleeping between jobs when work is waiting.
    let outcome = await runOnce({ db, tron, seed, hotWalletAddress: config.hotWalletAddress })
    while (outcome !== 'idle') {
      console.log(`[signer] job ${outcome}`)
      outcome = await runOnce({ db, tron, seed, hotWalletAddress: config.hotWalletAddress })
    }
  },
})

await pool.end()
console.log('[signer] stopped')
```

- [ ] **Step 6: Add the scripts**

In `package.json`:

```json
    "worker": "tsx worker/main.ts",
    "signer": "tsx signer/main.ts",
```

- [ ] **Step 7: Verify**

```bash
pnpm test tests/process/loop.test.ts
pnpm typecheck
pnpm build
```

Expected: PASS, 3 tests; typecheck and build clean. Also confirm the worker refuses a leaked
seed:

```bash
TRON_MNEMONIC="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" pnpm worker
```

Expected: exits immediately with `TRON_MNEMONIC must not be set in the worker environment`.

- [ ] **Step 8: Commit and push**

```bash
git add worker signer src/lib/process tests/process package.json
git commit -m "feat: worker and signer process entrypoints with graceful shutdown"
git push origin main
```

---

## Task 10: Deposit address API and page

**Files:**
- Create: `src/app/api/me/deposit-address/route.ts`, `src/app/deposit/page.tsx`
- Modify: `src/components/Nav.tsx` (add a Deposit link)

**Interfaces:**
- Consumes: `requireUser`, `assignDepositAddress`, `getDepositAddress`, `loadTronConfig`
- Produces: `POST /api/me/deposit-address` → `201 { address, derivationIndex, created }`

The address is assigned lazily on first request rather than at signup, so users who never
deposit never consume a derivation index.

- [ ] **Step 1: Write the route**

`src/app/api/me/deposit-address/route.ts`:

```ts
import { getDb } from '@/lib/db/client'
import { loadTronConfig } from '@/lib/tron/config'
import { assignDepositAddress, getDepositAddress } from '@/lib/deposits/addresses'
import { handle, ok } from '@/lib/http/respond'
import { requireUser } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    return ok({ depositAddress: await getDepositAddress(getDb(), user.id) })
  })
}

export async function POST(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const config = loadTronConfig()
    const assigned = await assignDepositAddress(getDb(), { userId: user.id, xpub: config.xpub })
    return ok(assigned, { status: assigned.created ? 201 : 200 })
  })
}
```

- [ ] **Step 2: Write the page**

`src/app/deposit/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { getDepositAddress } from '@/lib/deposits/addresses'
import { loadTronConfig } from '@/lib/tron/config'
import { formatUsdt } from '@/lib/money/units'
import { DepositAddressPanel } from '@/components/DepositAddressPanel'

export const dynamic = 'force-dynamic'

export default async function DepositPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const config = loadTronConfig()
  const existing = await getDepositAddress(getDb(), user.id)

  return (
    <>
      <h1>Deposit USDT</h1>
      <p>
        Send <strong>USDT-TRC20</strong> on the Tron {config.network} network only. Funds sent on
        any other network or in any other token are unrecoverable.
      </p>
      <p className="estimate">
        Deposits are credited after {config.confirmations} confirmations. Amounts below{' '}
        {formatUsdt(config.sweepMinMicros)} USDT remain at your deposit address until it is
        economical to consolidate them — your balance is credited either way.
      </p>
      <DepositAddressPanel initialAddress={existing?.address ?? null} />
    </>
  )
}
```

`src/components/DepositAddressPanel.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { apiPost, ApiError } from '@/lib/client/api'

export function DepositAddressPanel({ initialAddress }: { initialAddress: string | null }) {
  const [address, setAddress] = useState(initialAddress)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function reveal() {
    setBusy(true)
    setError(null)
    try {
      const result = await apiPost<{ address: string }>('/api/me/deposit-address')
      setAddress(result.address)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  if (address) {
    return (
      <fieldset>
        <legend>Your deposit address</legend>
        <p>
          <code>{address}</code>
        </p>
        <button onClick={() => navigator.clipboard.writeText(address)}>Copy</button>
      </fieldset>
    )
  }

  return (
    <fieldset>
      <legend>Your deposit address</legend>
      {error && <p className="error">{error}</p>}
      <button onClick={reveal} disabled={busy}>
        {busy ? 'Generating…' : 'Show my deposit address'}
      </button>
    </fieldset>
  )
}
```

- [ ] **Step 3: Add the nav link**

In `src/components/Nav.tsx`, inside the signed-in branch, immediately before the `Account`
link:

```tsx
          <Link href="/deposit">Deposit</Link>
          {' · '}
```

- [ ] **Step 4: Verify**

```bash
pnpm typecheck
pnpm build
pnpm test
```

Expected: build succeeds with `/deposit` and `/api/me/deposit-address` listed; all tests pass.

- [ ] **Step 5: Commit and push**

```bash
git add src/app/deposit src/app/api/me/deposit-address src/components
git commit -m "feat: deposit address API and page"
git push origin main
```

---

## Task 11: Chain reconciliation

Slice 1's ledger proves internal consistency. This proves the ledger matches the chain — the
check that would actually catch a missed deposit, a double credit, or a sweep to the wrong
address.

**Files:**
- Create: `src/lib/reconcile/chain.ts`, `scripts/reconcile.ts`
- Modify: `package.json`
- Test: `tests/reconcile/chain.test.ts`

**Interfaces:**
- Consumes: `TronClient`, `listDepositAddresses`, `balanceOf`, `houseAccount`
- Produces (`src/lib/reconcile/chain.ts`):
  - `type Reconciliation = { onChainMicros: bigint; ledgerCustodyMicros: bigint; adminCreditedMicros: bigint; differenceMicros: bigint; balanced: boolean; perAddress: Array<{ address: string; onChain: bigint }> }`
  - `reconcileChain(db: Db, tron: TronClient, hotWalletAddress: string): Promise<Reconciliation>`

`ledgerCustodyMicros` is `−balance(hot_wallet)` (see "Ledger convention" above). Admin credits
are fabricated money with no chain backing, so they are reported separately and subtracted
before deciding whether the books balance — otherwise Slice 1's test data would permanently
show a discrepancy.

- [ ] **Step 1: Write the failing test**

`tests/reconcile/chain.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { ACCOUNT_PATH } from '@/lib/tron/address'
import { assignDepositAddress } from '@/lib/deposits/addresses'
import { recordSeenTransfer, creditConfirmedDeposits } from '@/lib/deposits/credit'
import { creditUser } from '@/lib/admin/credit'
import { reconcileChain } from '@/lib/reconcile/chain'
import { derivePrivateKeyHex } from '@/lib/signer/keys'
import { FakeTron } from '@/lib/tron/fake'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEED = mnemonicToSeedSync(MNEMONIC)
const XPUB = HDKey.fromMasterSeed(SEED).derive(ACCOUNT_PATH).publicExtendedKey
const USDT = 1_000_000n
// Index 99 of the same test wallet, so the hot wallet is provably ours and reproducible.
const HOT = 'TTTFe9haCY6CACG9iTM8uyL89pFEPy4ctW'

describe('reconcileChain', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('balances on an empty system', async () => {
    const result = await reconcileChain(db, new FakeTron(), HOT)
    expect(result).toMatchObject({
      onChainMicros: 0n,
      ledgerCustodyMicros: 0n,
      differenceMicros: 0n,
      balanced: true,
    })
  })

  it('balances after a real deposit is credited', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    const tron = new FakeTron()
    const transfer = tron.deposit({ to: address, amountMicros: 60n * USDT, blockNumber: 100 })
    await recordSeenTransfer(db, transfer)
    await creditConfirmedDeposits(db, 200, 19)

    const result = await reconcileChain(db, tron, HOT)
    expect(result.onChainMicros).toBe(60n * USDT)
    expect(result.ledgerCustodyMicros).toBe(60n * USDT)
    expect(result.balanced).toBe(true)
  })

  it('still balances once funds are swept to the hot wallet', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    const tron = new FakeTron()
    const transfer = tron.deposit({ to: address, amountMicros: 60n * USDT, blockNumber: 100 })
    await recordSeenTransfer(db, transfer)
    await creditConfirmedDeposits(db, 200, 19)

    // Perform the sweep for real, with the key the signer would use for index 0.
    await tron.sendTrc20({
      fromPrivateKeyHex: derivePrivateKeyHex(SEED, 0),
      to: HOT,
      amountMicros: 60n * USDT,
    })

    expect(await tron.trc20Balance(address)).toBe(0n)
    expect(await tron.trc20Balance(HOT)).toBe(60n * USDT)

    // A sweep moves money between two accounts we control, so custody is unchanged.
    const result = await reconcileChain(db, tron, HOT)
    expect(result.onChainMicros).toBe(60n * USDT)
    expect(result.ledgerCustodyMicros).toBe(60n * USDT)
    expect(result.balanced).toBe(true)
  })

  it('reports admin credits separately so they do not read as corruption', async () => {
    const admin = await makeAdmin(db)
    const user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })

    const result = await reconcileChain(db, new FakeTron(), HOT)
    expect(result.adminCreditedMicros).toBe(100n * USDT)
    expect(result.ledgerCustodyMicros).toBe(100n * USDT)
    // Chain holds nothing, but 100 of the custody figure is fabricated, so this balances.
    expect(result.differenceMicros).toBe(0n)
    expect(result.balanced).toBe(true)
  })

  it('flags a genuine shortfall', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    const tron = new FakeTron()
    const transfer = tron.deposit({ to: address, amountMicros: 60n * USDT, blockNumber: 100 })
    await recordSeenTransfer(db, transfer)
    await creditConfirmedDeposits(db, 200, 19)

    // The money leaves the chain without any corresponding ledger movement.
    const drained = new FakeTron()
    const result = await reconcileChain(db, drained, HOT)

    expect(result.onChainMicros).toBe(0n)
    expect(result.ledgerCustodyMicros).toBe(60n * USDT)
    expect(result.differenceMicros).toBe(-60n * USDT)
    expect(result.balanced).toBe(false)
  })

  it('lists the per-address on-chain balances it summed', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })
    const tron = new FakeTron()
    tron.deposit({ to: address, amountMicros: 3n * USDT, blockNumber: 1 })

    const result = await reconcileChain(db, tron, HOT)
    expect(result.perAddress).toContainEqual({ address, onChain: 3n * USDT })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/reconcile/chain.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/reconcile/chain"`.

- [ ] **Step 3: Write the implementation**

`src/lib/reconcile/chain.ts`:

```ts
import { eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { ledgerEntries, ledgerTransactions } from '@/lib/db/schema'
import { balanceOf, houseAccount } from '@/lib/ledger/accounts'
import { listDepositAddresses } from '@/lib/deposits/addresses'
import type { TronClient } from '@/lib/tron/client'

export type Reconciliation = {
  onChainMicros: bigint
  ledgerCustodyMicros: bigint
  adminCreditedMicros: bigint
  differenceMicros: bigint
  balanced: boolean
  perAddress: Array<{ address: string; onChain: bigint }>
}

/**
 * Compare what the chain holds against what the ledger says we hold.
 *
 * `hot_wallet` is a chain-custody account carried with inverted sign (see the plan's
 * "Ledger convention"), so the ledger's view of custody is its negated balance.
 *
 * Admin credits from Slice 1 are money that was never on chain. They are reported and
 * netted out separately, so leftover test data does not masquerade as a shortfall.
 */
export async function reconcileChain(
  db: Db,
  tron: TronClient,
  hotWalletAddress: string,
): Promise<Reconciliation> {
  const addresses = await listDepositAddresses(db)
  const perAddress: Array<{ address: string; onChain: bigint }> = []
  let onChainMicros = 0n

  for (const { address } of addresses) {
    const onChain = await tron.trc20Balance(address)
    perAddress.push({ address, onChain })
    onChainMicros += onChain
  }

  const hotOnChain = await tron.trc20Balance(hotWalletAddress)
  perAddress.push({ address: hotWalletAddress, onChain: hotOnChain })
  onChainMicros += hotOnChain

  const ledgerCustodyMicros = -(await balanceOf(db, await houseAccount(db, 'hot_wallet')))

  const adminRows = await db
    .select({ total: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txId))
    .where(
      sql`${ledgerTransactions.kind} = 'ADMIN_CREDIT' AND ${ledgerEntries.accountId} = (
        SELECT id FROM accounts WHERE kind = 'hot_wallet' LIMIT 1
      )`,
    )
  const adminCreditedMicros = -BigInt(adminRows[0]?.total ?? '0')

  const differenceMicros = onChainMicros - (ledgerCustodyMicros - adminCreditedMicros)

  return {
    onChainMicros,
    ledgerCustodyMicros,
    adminCreditedMicros,
    differenceMicros,
    balanced: differenceMicros === 0n,
    perAddress,
  }
}
```

- [ ] **Step 4: Write the CLI**

`scripts/reconcile.ts`:

```ts
import 'dotenv/config'
import { createDb } from '../src/lib/db/client'
import { loadTronConfig } from '../src/lib/tron/config'
import { createTronGridClient } from '../src/lib/tron/trongrid'
import { reconcileChain } from '../src/lib/reconcile/chain'
import { formatUsdt } from '../src/lib/money/units'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const config = loadTronConfig()
const { db, pool } = createDb(url)
const result = await reconcileChain(db, createTronGridClient(config), config.hotWalletAddress)
await pool.end()

console.log(`on chain:        ${formatUsdt(result.onChainMicros)} USDT`)
console.log(`ledger custody:  ${formatUsdt(result.ledgerCustodyMicros)} USDT`)
console.log(`admin credits:   ${formatUsdt(result.adminCreditedMicros)} USDT (not chain-backed)`)
console.log(`difference:      ${formatUsdt(result.differenceMicros)} USDT`)

for (const row of result.perAddress) {
  if (row.onChain > 0n) console.log(`  ${row.address}  ${formatUsdt(row.onChain)}`)
}

if (!result.balanced) {
  console.error('\nRECONCILIATION FAILED — treat as a production incident')
  process.exit(1)
}
console.log('\nbalanced')
```

Add to `package.json` scripts: `"reconcile": "tsx scripts/reconcile.ts"`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm test tests/reconcile/chain.test.ts
pnpm typecheck
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit and push**

```bash
git add src/lib/reconcile scripts/reconcile.ts tests/reconcile package.json
git commit -m "feat: chain reconciliation comparing ledger custody against on-chain balances"
git push origin main
```

---

## Task 12: Live Nile testnet verification

Everything so far ran against the fake. This is the first contact with a real chain, and it is
deliberately the last task: by now the accounting is already proven.

**Files:**
- Create: `docs/superpowers/plans/slice-2-walkthrough.md`

**Prerequisites** — obtain these before starting:
- A free TronGrid API key from <https://www.trongrid.io/dashboard>
- A Nile testnet TRX faucet top-up from <https://nileex.io/join/getJoinPage>
- The Nile USDT contract address from <https://nileex.io> (it is **not** the mainnet
  `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`; using the mainnet address on Nile silently finds
  nothing)

- [ ] **Step 1: Generate a throwaway wallet**

Never reuse a mnemonic that has held real funds.

```bash
node --input-type=module -e "
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
console.log(generateMnemonic(wordlist, 128))
"
```

- [ ] **Step 2: Derive the xpub and hot wallet address from it**

```bash
TRON_MNEMONIC='<the mnemonic>' node --input-type=module -e "
import { loadSignerSeed, deriveXpub } from './src/lib/signer/keys.ts'
import { deriveAddress } from './src/lib/tron/address.ts'
const seed = loadSignerSeed()
const xpub = deriveXpub(seed)
console.log('TRON_XPUB=' + xpub)
console.log('index 0 (use as hot wallet):', deriveAddress(xpub, 0))
"
```

Run it through `tsx` if the direct `.ts` import is rejected: `pnpm tsx -e '<same script>'`.

- [ ] **Step 3: Fill in `.env`**

Set `TRON_NETWORK=nile`, `TRON_FULL_HOST=https://nile.trongrid.io`, `TRONGRID_API_KEY`,
`TRON_USDT_CONTRACT` (Nile's), `TRON_XPUB`, and `TRON_HOT_WALLET_ADDRESS`. Set
`TRON_MNEMONIC` **only** in the shell that runs the signer.

Lower the thresholds so the walkthrough does not need large amounts:

```
TRON_CONFIRMATIONS=1
TRON_SWEEP_MIN_MICROS=1000000
```

Record in the walkthrough that these are test values and that production uses 19 and
20000000.

- [ ] **Step 4: Confirm the client can read the live chain**

```bash
pnpm tsx -e "
import 'dotenv/config'
import { loadTronConfig } from './src/lib/tron/config'
import { createTronGridClient } from './src/lib/tron/trongrid'
const c = createTronGridClient(loadTronConfig())
console.log('head block:', await c.headBlock())
console.log('hot wallet USDT:', await c.trc20Balance(process.env.TRON_HOT_WALLET_ADDRESS))
console.log('hot wallet TRX (SUN):', await c.trxBalance(process.env.TRON_HOT_WALLET_ADDRESS))
"
```

Expected: a plausible Nile height and two balances. A `RPC_FAILED` here means the API key or
host is wrong — fix it before continuing.

- [ ] **Step 5: Assign a deposit address and fund it**

Start the app, sign up, visit `/deposit`, and click through to reveal the address. Send Nile
USDT to it from the faucet or another Nile wallet. Also send a little TRX to that deposit
address — sweeping needs energy and bandwidth, and without TRX the sweep will fail with
`INSUFFICIENT_ENERGY`, which is itself worth observing once.

- [ ] **Step 6: Run the worker and watch the deposit credit**

```bash
pnpm worker
```

Record: the head block, the cycle at which `new=1` appears, and the cycle at which
`credited=1` appears. Then confirm in the UI that the account balance rose, and in the
database that exactly one deposit row exists:

```bash
docker compose exec -T db psql -U botsbattle -d botsbattle -c \
  "SELECT tx_hash, log_index, amount, status FROM deposits;"
```

- [ ] **Step 7: Restart the worker and confirm nothing double-credits**

Stop the worker, start it again, let it run two full cycles, and re-check the balance and the
deposit row count. Both must be unchanged. This is the idempotency claim under real chain
data rather than fake data.

- [ ] **Step 8: Run the signer and watch the sweep**

In a shell that has `TRON_MNEMONIC` set:

```bash
pnpm signer
```

Record the broadcast transaction hash, then verify on <https://nile.tronscan.org> that the
USDT moved from the deposit address to the hot wallet. Confirm the job row:

```bash
docker compose exec -T db psql -U botsbattle -d botsbattle -c \
  "SELECT kind, status, attempts, tx_hash, last_error FROM signer_jobs;"
```

- [ ] **Step 9: Reconcile against the live chain**

```bash
pnpm reconcile
```

Expected: `balanced`, with `on chain` equal to `ledger custody` minus any admin credits. If it
reports a difference, stop — that is the failure mode this whole slice exists to prevent, and
the walkthrough must record the actual numbers rather than being adjusted until it passes.

- [ ] **Step 10: Write up the walkthrough**

Create `docs/superpowers/plans/slice-2-walkthrough.md` recording, as observed values: the Nile
addresses used, the deposit transaction hash, the block it landed in, the head block at which
it credited, the sweep transaction hash, the `pnpm reconcile` output, and anything that
behaved differently from this plan. Follow the structure of `slice-1-walkthrough.md`.

**Do not put the mnemonic in the walkthrough**, or anywhere else in the repository.

- [ ] **Step 11: Restore production thresholds**

Set `TRON_CONFIRMATIONS=19` and `TRON_SWEEP_MIN_MICROS=20000000` back in `.env.example`, and
confirm `.env` is still gitignored:

```bash
git check-ignore -v .env
```

Expected: it prints the matching `.gitignore` rule. If it prints nothing, `.env` is tracked —
stop and fix that before committing anything.

- [ ] **Step 12: Commit and push**

```bash
git add docs/superpowers/plans/slice-2-walkthrough.md .env.example
git commit -m "docs: Slice 2 live Nile testnet walkthrough"
git push origin main
```

---

## Done when

- `pnpm test` is green, including the xpub/private-key cross-check over 20 indices and the
  concurrent index-allocation tests
- `pnpm typecheck` and `pnpm build` are clean
- A real Nile deposit credited exactly once across a worker restart
- A real sweep moved funds to the hot wallet, verified on Tronscan
- `pnpm reconcile` reports `balanced` against the live chain
- No file in the repository contains a mnemonic, and the worker refuses to start if one is
  present in its environment

## Deliberately not in this slice

Withdrawals, the admin approval queue, TOTP enrolment, `balance_cache` and its reconciliation
job, visual design, and deployment. Slices 3 and 4 cover them.

## Note for whoever writes Slices 3 and 4

Slice 1 was planned in full and then executed, and execution surfaced five real defects the
plan could not have predicted — including one, `postTransaction` not being atomic, that was a
genuine money bug. Expect the same here. The Slice 3 plan should be re-read against the
interfaces this slice actually produces before it is executed, not merely against what this
plan says they will be.
