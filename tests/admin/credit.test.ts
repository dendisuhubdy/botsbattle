import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { creditUser } from '@/lib/admin/credit'
import { userBalance, houseAccount, balanceOf } from '@/lib/ledger/accounts'

describe('creditUser', () => {
  let db: Db
  let user: string
  let admin: string

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
    user = await makeUser(db)
    admin = await makeAdmin(db)
  })

  it('credits the user and debits the hot wallet', async () => {
    await creditUser(db, {
      userId: user,
      amount: 100_000_000n,
      reference: 'seed-1',
      creditedBy: admin,
    })

    expect(await userBalance(db, user)).toBe(100_000_000n)
    expect(await balanceOf(db, await houseAccount(db, 'hot_wallet'))).toBe(-100_000_000n)
  })

  it('is idempotent on the reference', async () => {
    const first = await creditUser(db, {
      userId: user,
      amount: 5_000_000n,
      reference: 'dup',
      creditedBy: admin,
    })
    const second = await creditUser(db, {
      userId: user,
      amount: 5_000_000n,
      reference: 'dup',
      creditedBy: admin,
    })

    expect(second.replayed).toBe(true)
    expect(second.txId).toBe(first.txId)
    expect(await userBalance(db, user)).toBe(5_000_000n)
  })

  it('rejects a zero or negative amount', async () => {
    for (const amount of [0n, -1n]) {
      await expect(
        creditUser(db, { userId: user, amount, reference: `bad-${amount}`, creditedBy: admin }),
      ).rejects.toMatchObject({ code: 'NON_POSITIVE' })
    }
    expect(await userBalance(db, user)).toBe(0n)
  })
})
