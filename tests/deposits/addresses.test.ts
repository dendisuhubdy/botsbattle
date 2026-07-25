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
