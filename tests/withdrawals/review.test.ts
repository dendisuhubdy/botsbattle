import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { signerJobs, withdrawalRequests } from '@/lib/db/schema'
import { creditUser } from '@/lib/admin/credit'
import { beginEnrolment, confirmEnrolment } from '@/lib/auth/totp'
import { requestWithdrawal } from '@/lib/withdrawals/request'
import {
  listPendingWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
} from '@/lib/withdrawals/review'
import { balanceOf, userAvailableAccount, userPendingWithdrawalAccount } from '@/lib/ledger/accounts'

const USDT = 1_000_000n
const DEST = 'TEnzFm6jmsVnizS7RSuBr7H6zzn4e7H7Pb'

describe('withdrawal review', () => {
  let db: Db
  let user: string
  let admin: string
  let secret: string
  let requestId: string

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
    requestId = (
      await requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 40n * USDT,
        totpCode: code(),
      })
    ).requestId
  })

  function code(): string {
    return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
  }

  it('lists a requested withdrawal for review with the user email', async () => {
    const pending = await listPendingWithdrawals(db)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: requestId, address: DEST, amount: 40n * USDT })
    expect(pending[0].email).toContain('@example.com')
  })

  it('approving enqueues a signer job and moves no money', async () => {
    const { jobId } = await approveWithdrawal(db, { requestId, adminId: admin })

    const [job] = await db.select().from(signerJobs).where(eq(signerJobs.id, jobId))
    expect(job.kind).toBe('WITHDRAW')
    expect(job.status).toBe('PENDING')

    // Funds stay ring-fenced; nothing returns to available.
    expect(await balanceOf(db, await userAvailableAccount(db, user))).toBe(60n * USDT)
    expect(await balanceOf(db, await userPendingWithdrawalAccount(db, user))).toBe(40n * USDT)

    const [row] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('APPROVED')
    expect(row.reviewedBy).toBe(admin)
    expect(row.reviewedAt).not.toBeNull()
    expect(row.signerJobId).toBe(jobId)
  })

  it('double-clicking approve produces exactly one job', async () => {
    const first = await approveWithdrawal(db, { requestId, adminId: admin })
    const second = await approveWithdrawal(db, { requestId, adminId: admin })

    expect(second.jobId).toBe(first.jobId)
    expect(await db.select().from(signerJobs)).toHaveLength(1)
  })

  it('two concurrent approvals produce exactly one job', async () => {
    const results = await Promise.allSettled([
      approveWithdrawal(db, { requestId, adminId: admin }),
      approveWithdrawal(db, { requestId, adminId: admin }),
    ])
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    expect(await db.select().from(signerJobs)).toHaveLength(1)
  })

  it('rejecting returns the funds', async () => {
    await rejectWithdrawal(db, { requestId, adminId: admin, note: 'suspicious pattern' })

    expect(await balanceOf(db, await userAvailableAccount(db, user))).toBe(100n * USDT)
    expect(await balanceOf(db, await userPendingWithdrawalAccount(db, user))).toBe(0n)

    const [row] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('REJECTED')
    expect(row.reviewNote).toBe('suspicious pattern')
  })

  it('rejecting twice returns the funds once', async () => {
    await rejectWithdrawal(db, { requestId, adminId: admin, note: 'no' })
    await rejectWithdrawal(db, { requestId, adminId: admin, note: 'no' })
    expect(await balanceOf(db, await userAvailableAccount(db, user))).toBe(100n * USDT)
  })

  it('cannot reject an already approved withdrawal', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    await expect(
      rejectWithdrawal(db, { requestId, adminId: admin, note: 'changed my mind' }),
    ).rejects.toMatchObject({ code: 'NOT_REVIEWABLE' })
  })

  it('cannot approve an already rejected withdrawal', async () => {
    await rejectWithdrawal(db, { requestId, adminId: admin, note: 'no' })
    await expect(approveWithdrawal(db, { requestId, adminId: admin })).rejects.toMatchObject({
      code: 'NOT_REVIEWABLE',
    })
  })

  it('drops a reviewed withdrawal off the pending list', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    expect(await listPendingWithdrawals(db)).toEqual([])
  })
})
