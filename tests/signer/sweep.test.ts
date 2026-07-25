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
    expect(plans).toEqual([{ derivationIndex: 0, address, amountMicros: (20n * USDT).toString() }])
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
