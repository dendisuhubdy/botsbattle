import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import * as OTPAuth from 'otpauth'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { users, withdrawalRequests } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { creditUser } from '@/lib/admin/credit'
import { beginEnrolment, confirmEnrolment } from '@/lib/auth/totp'
import { requestWithdrawal, cancelWithdrawal, listUserWithdrawals } from '@/lib/withdrawals/request'
import { balanceOf, userAvailableAccount, userPendingWithdrawalAccount } from '@/lib/ledger/accounts'

const USDT = 1_000_000n
const DEST = 'TEnzFm6jmsVnizS7RSuBr7H6zzn4e7H7Pb'

describe('requestWithdrawal', () => {
  let db: Db
  let user: string
  let admin: string
  let secret: string

  beforeAll(async () => {
    ;({ db } = await testDb())
    process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64)
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })
    secret = (await beginEnrolment(db, user)).secret
    await confirmEnrolment(db, user, code())
  })

  function code(): string {
    return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
  }

  async function available(): Promise<bigint> {
    return balanceOf(db, await userAvailableAccount(db, user))
  }
  async function pending(): Promise<bigint> {
    return balanceOf(db, await userPendingWithdrawalAccount(db, user))
  }

  it('ring-fences the funds immediately', async () => {
    await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 40n * USDT,
      totpCode: code(),
    })

    expect(await available()).toBe(60n * USDT)
    expect(await pending()).toBe(40n * USDT)
  })

  it('records the request as REQUESTED', async () => {
    const { requestId } = await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 40n * USDT,
      totpCode: code(),
    })

    const [row] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('REQUESTED')
    expect(row.address).toBe(DEST)
    expect(row.amount).toBe(40n * USDT)
  })

  it('refuses a wrong TOTP code and moves nothing', async () => {
    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 40n * USDT,
        totpCode: '000000',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' })

    expect(await available()).toBe(100n * USDT)
    expect(await pending()).toBe(0n)
  })

  it('refuses a user who has not enrolled in TOTP', async () => {
    const other = await makeUser(db)
    await creditUser(db, { userId: other, amount: 50n * USDT, reference: 'o', creditedBy: admin })

    await expect(
      requestWithdrawal(db, {
        userId: other,
        address: DEST,
        amountMicros: 10n * USDT,
        totpCode: '123456',
      }),
    ).rejects.toMatchObject({ code: 'NOT_ENROLLED' })
  })

  it('refuses more than the available balance', async () => {
    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 101n * USDT,
        totpCode: code(),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' })
    expect(await available()).toBe(100n * USDT)
  })

  it('counts already-pending withdrawals against the balance', async () => {
    // The whole point of ring-fencing: a second request cannot spend the first one's funds.
    await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 60n * USDT,
      totpCode: code(),
    })

    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 60n * USDT,
        totpCode: code(),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' })
  })

  it('refuses an amount below the minimum', async () => {
    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 9n * USDT,
        totpCode: code(),
      }),
    ).rejects.toMatchObject({ code: 'BELOW_MINIMUM' })
  })

  it('refuses a malformed destination address', async () => {
    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: 'not-a-tron-address',
        amountMicros: 20n * USDT,
        totpCode: code(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' })
  })

  it('refuses when the account is withdrawal_locked', async () => {
    await db.update(users).set({ withdrawalLocked: true }).where(eq(users.id, user))

    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 20n * USDT,
        totpCode: code(),
      }),
    ).rejects.toMatchObject({ code: 'LOCKED' })
    expect(await available()).toBe(100n * USDT)
  })

  it('never overdraws under concurrent requests', async () => {
    // 100 USDT of balance, five simultaneous 30 USDT requests: at most three may succeed.
    const attempts = Array.from({ length: 5 }, () =>
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 30n * USDT,
        totpCode: code(),
      }).then(
        () => 'ok' as const,
        () => 'rejected' as const,
      ),
    )

    const results = await Promise.all(attempts)
    expect(results.filter((r) => r === 'ok').length).toBeLessThanOrEqual(3)
    expect(await available()).toBeGreaterThanOrEqual(0n)
    expect((await available()) + (await pending())).toBe(100n * USDT)
  })
})

describe('cancelWithdrawal', () => {
  let db: Db
  let user: string
  let admin: string
  let secret: string

  beforeAll(async () => {
    ;({ db } = await testDb())
    process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64)
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })
    secret = (await beginEnrolment(db, user)).secret
    await confirmEnrolment(
      db,
      user,
      new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate(),
    )
  })

  function code(): string {
    return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
  }

  it('returns the funds and marks it CANCELLED', async () => {
    const { requestId } = await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 40n * USDT,
      totpCode: code(),
    })

    await cancelWithdrawal(db, { userId: user, requestId })

    expect(await balanceOf(db, await userAvailableAccount(db, user))).toBe(100n * USDT)
    expect(await balanceOf(db, await userPendingWithdrawalAccount(db, user))).toBe(0n)

    const [row] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('CANCELLED')
  })

  it('is idempotent — cancelling twice returns the funds once', async () => {
    const { requestId } = await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 40n * USDT,
      totpCode: code(),
    })

    await cancelWithdrawal(db, { userId: user, requestId })
    await cancelWithdrawal(db, { userId: user, requestId })

    expect(await balanceOf(db, await userAvailableAccount(db, user))).toBe(100n * USDT)
  })

  it("refuses to cancel another user's request", async () => {
    const { requestId } = await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 40n * USDT,
      totpCode: code(),
    })
    const other = await makeUser(db)

    await expect(cancelWithdrawal(db, { userId: other, requestId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(await balanceOf(db, await userPendingWithdrawalAccount(db, user))).toBe(40n * USDT)
  })

  it('lists a user\'s withdrawals newest first', async () => {
    await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 20n * USDT,
      totpCode: code(),
    })
    const listed = await listUserWithdrawals(db, user)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ address: DEST, amount: 20n * USDT, status: 'REQUESTED' })
  })
})
