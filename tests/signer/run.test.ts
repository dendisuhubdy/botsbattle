import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mnemonicToSeedSync } from '@scure/bip39'
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
