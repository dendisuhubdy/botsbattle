import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { withdrawalRequests } from '@/lib/db/schema'
import { creditUser } from '@/lib/admin/credit'
import { beginEnrolment, confirmEnrolment } from '@/lib/auth/totp'
import { requestWithdrawal } from '@/lib/withdrawals/request'
import { approveWithdrawal } from '@/lib/withdrawals/review'
import { markBroadcast } from '@/lib/withdrawals/settle'
import { pollWithdrawals } from '@/lib/withdrawals/poller'
import { FakeTron } from '@/lib/tron/fake'
import type { TronClient } from '@/lib/tron/client'
import { balanceOf, houseAccount, userPendingWithdrawalAccount } from '@/lib/ledger/accounts'

const USDT = 1_000_000n
const DEST_A = 'TEnzFm6jmsVnizS7RSuBr7H6zzn4e7H7Pb'
const DEST_B = 'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9'
const DEST_C = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const CONFIRMATIONS = 19

describe('pollWithdrawals', () => {
  let db: Db
  let admin: string

  beforeAll(async () => {
    ;({ db } = await testDb())
    process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64)
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
  })

  /** Fund a fresh user, request a withdrawal to `address`, and get it admin-approved. */
  async function approvedWithdrawal(
    address: string,
    amountMicros: bigint,
  ): Promise<{ userId: string; requestId: string }> {
    const userId = await makeUser(db)
    await creditUser(db, {
      userId,
      amount: amountMicros + 60n * USDT,
      // Idempotency key is per-reference, not per-user — each fixture user needs its own so
      // one user's seed credit doesn't silently no-op as a "duplicate" of another's.
      reference: `seed-${userId}`,
      creditedBy: admin,
    })
    const { secret } = await beginEnrolment(db, userId)
    const code = () => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
    await confirmEnrolment(db, userId, code())
    const { requestId } = await requestWithdrawal(db, {
      userId,
      address,
      amountMicros,
      totpCode: code(),
    })
    await approveWithdrawal(db, { requestId, adminId: admin })
    return { userId, requestId }
  }

  async function statusOf(requestId: string): Promise<string> {
    const [row] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
    return row.status
  }

  it('confirms a broadcast withdrawal once its transfer is buried deep enough, closing out the ledger', async () => {
    const { userId, requestId } = await approvedWithdrawal(DEST_A, 40n * USDT)
    const hotBefore = await balanceOf(db, await houseAccount(db, 'hot_wallet'))

    const tron = new FakeTron()
    const transfer = tron.deposit({ to: DEST_A, amountMicros: 40n * USDT, blockNumber: 1000 })
    await markBroadcast(db, { requestId, txHash: transfer.txHash })
    // head - blockNumber + 1 = 1018 - 1000 + 1 = 19 = CONFIRMATIONS: exactly deep enough.
    tron.setHead(1018)

    const result = await pollWithdrawals(db, tron, { confirmations: CONFIRMATIONS })

    expect(result.confirmed).toEqual([requestId])
    expect(await statusOf(requestId)).toBe('CONFIRMED')
    expect(await balanceOf(db, await userPendingWithdrawalAccount(db, userId))).toBe(0n)
    expect(await balanceOf(db, await houseAccount(db, 'hot_wallet'))).toBe(hotBefore + 40n * USDT)
  })

  it('leaves a withdrawal BROADCAST when its transfer is not buried deep enough yet', async () => {
    const { requestId } = await approvedWithdrawal(DEST_A, 40n * USDT)

    const tron = new FakeTron()
    const transfer = tron.deposit({ to: DEST_A, amountMicros: 40n * USDT, blockNumber: 1000 })
    await markBroadcast(db, { requestId, txHash: transfer.txHash })
    // head - blockNumber + 1 = 1000 - 1000 + 1 = 1, far short of 19.
    tron.setHead(1000)

    const result = await pollWithdrawals(db, tron, { confirmations: CONFIRMATIONS })

    expect(result.confirmed).toEqual([])
    expect(await statusOf(requestId)).toBe('BROADCAST')
  })

  it('does not confirm on a false positive: a deep transfer whose hash does not match', async () => {
    const { requestId } = await approvedWithdrawal(DEST_A, 40n * USDT)

    const tron = new FakeTron()
    // A real, deep transfer lands at the address, but under a different tx hash than the
    // one this withdrawal actually broadcast.
    tron.deposit({ to: DEST_A, amountMicros: 40n * USDT, blockNumber: 1000, txHash: 'someone-elses-tx' })
    await markBroadcast(db, { requestId, txHash: 'our-actual-broadcast-hash' })
    tron.setHead(1018)

    const result = await pollWithdrawals(db, tron, { confirmations: CONFIRMATIONS })

    expect(result.confirmed).toEqual([])
    expect(await statusOf(requestId)).toBe('BROADCAST')
  })

  it('does not confirm on a false positive: matching hash but a different amount', async () => {
    const { requestId } = await approvedWithdrawal(DEST_A, 40n * USDT)

    const tron = new FakeTron()
    // Same hash, but the transfer that actually landed carries a different amount than the
    // withdrawal requested — must not be treated as the same event.
    const transfer = tron.deposit({ to: DEST_A, amountMicros: 39n * USDT, blockNumber: 1000 })
    await markBroadcast(db, { requestId, txHash: transfer.txHash })
    tron.setHead(1018)

    const result = await pollWithdrawals(db, tron, { confirmations: CONFIRMATIONS })

    expect(result.confirmed).toEqual([])
    expect(await statusOf(requestId)).toBe('BROADCAST')
  })

  it('a read failure on one withdrawal does not prevent others from confirming', async () => {
    const { requestId: brokenId } = await approvedWithdrawal(DEST_B, 40n * USDT)
    const { requestId: okId } = await approvedWithdrawal(DEST_C, 25n * USDT)

    const inner = new FakeTron()
    const brokenTransfer = inner.deposit({ to: DEST_B, amountMicros: 40n * USDT, blockNumber: 1000 })
    const okTransfer = inner.deposit({ to: DEST_C, amountMicros: 25n * USDT, blockNumber: 1000 })
    await markBroadcast(db, { requestId: brokenId, txHash: brokenTransfer.txHash })
    await markBroadcast(db, { requestId: okId, txHash: okTransfer.txHash })
    inner.setHead(1018)

    // A client that throws for exactly the address of the "broken" withdrawal.
    const flaky: TronClient = {
      headBlock: () => inner.headBlock(),
      incomingTransfers: (address) => {
        if (address === DEST_B) return Promise.reject(new Error('rpc exploded'))
        return inner.incomingTransfers(address)
      },
      trc20Balance: (a) => inner.trc20Balance(a),
      trxBalance: (a) => inner.trxBalance(a),
      sendTrc20: (a) => inner.sendTrc20(a),
    }

    const result = await pollWithdrawals(db, flaky, { confirmations: CONFIRMATIONS })

    expect(result.confirmed).toEqual([okId])
    expect(await statusOf(okId)).toBe('CONFIRMED')
    // The broken one was never reached to conclusion, so it stays put rather than being
    // marked FAILED or otherwise mishandled.
    expect(await statusOf(brokenId)).toBe('BROADCAST')
  })
})
