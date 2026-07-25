import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { testDb, truncateAll } from '../helpers/db'
import type { Db } from '@/lib/db/client'
import { userAvailableAccount, houseAccount, balanceOf, userBalance } from '@/lib/ledger/accounts'
import { postTransaction, LedgerError } from '@/lib/ledger/post'

describe('ledger', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('creates a user account once and reuses it', async () => {
    const userId = randomUUID()
    const a = await userAvailableAccount(db, userId)
    const b = await userAvailableAccount(db, userId)
    expect(a).toBe(b)
  })

  it('posts a balanced transaction and moves the balance', async () => {
    const userId = randomUUID()
    const user = await userAvailableAccount(db, userId)
    const rake = await houseAccount(db, 'house_rake')

    const result = await postTransaction(db, {
      kind: 'TEST_CREDIT',
      idempotencyKey: 'credit-1',
      legs: [
        { accountId: rake, amount: -100_000_000n },
        { accountId: user, amount: 100_000_000n },
      ],
    })

    expect(result.replayed).toBe(false)
    expect(await balanceOf(db, user)).toBe(100_000_000n)
    expect(await balanceOf(db, rake)).toBe(-100_000_000n)
    expect(await userBalance(db, userId)).toBe(100_000_000n)
  })

  it('returns zero for an account with no entries', async () => {
    const user = await userAvailableAccount(db, randomUUID())
    expect(await balanceOf(db, user)).toBe(0n)
  })

  it('is idempotent: replaying the same key writes no new entries', async () => {
    const userId = randomUUID()
    const user = await userAvailableAccount(db, userId)
    const rake = await houseAccount(db, 'house_rake')
    const legs = [
      { accountId: rake, amount: -5_000_000n },
      { accountId: user, amount: 5_000_000n },
    ]

    const first = await postTransaction(db, { kind: 'TEST_CREDIT', idempotencyKey: 'dup', legs })
    const second = await postTransaction(db, { kind: 'TEST_CREDIT', idempotencyKey: 'dup', legs })

    expect(second.replayed).toBe(true)
    expect(second.txId).toBe(first.txId)
    expect(await balanceOf(db, user)).toBe(5_000_000n)
  })

  it('rejects an unbalanced transaction before touching the database', async () => {
    const user = await userAvailableAccount(db, randomUUID())
    const rake = await houseAccount(db, 'house_rake')

    await expect(
      postTransaction(db, {
        kind: 'BAD',
        idempotencyKey: 'bad-1',
        legs: [
          { accountId: rake, amount: -10n },
          { accountId: user, amount: 9n },
        ],
      }),
    ).rejects.toMatchObject({ code: 'UNBALANCED' })

    expect(await balanceOf(db, user)).toBe(0n)
  })

  it('rejects a transaction with no legs', async () => {
    await expect(
      postTransaction(db, { kind: 'BAD', idempotencyKey: 'empty-1', legs: [] }),
    ).rejects.toBeInstanceOf(LedgerError)
  })

  it('participates in a caller-supplied transaction and rolls back with it', async () => {
    const userId = randomUUID()
    const user = await userAvailableAccount(db, userId)
    const rake = await houseAccount(db, 'house_rake')

    await expect(
      db.transaction(async (tx) => {
        await postTransaction(tx, {
          kind: 'TEST_CREDIT',
          idempotencyKey: 'rollback-1',
          legs: [
            { accountId: rake, amount: -1_000_000n },
            { accountId: user, amount: 1_000_000n },
          ],
        })
        throw new Error('caller aborts')
      }),
    ).rejects.toThrow('caller aborts')

    expect(await balanceOf(db, user)).toBe(0n)
  })
})
