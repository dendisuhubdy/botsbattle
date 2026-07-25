import { asc, eq, sql } from 'drizzle-orm'
import type { Db, Executor } from '@/lib/db/client'
import { users, withdrawalRequests } from '@/lib/db/schema'
import { userAvailableAccount, userPendingWithdrawalAccount } from '@/lib/ledger/accounts'
import { postTransaction } from '@/lib/ledger/post'
import { enqueueJob } from '@/lib/signer/jobs'
import { WithdrawalError } from './request'

export type PendingReview = {
  id: string
  userId: string
  email: string
  address: string
  amount: bigint
  requestedAt: Date
}

export async function listPendingWithdrawals(x: Executor): Promise<PendingReview[]> {
  const rows = await x
    .select({
      id: withdrawalRequests.id,
      userId: withdrawalRequests.userId,
      email: users.email,
      address: withdrawalRequests.address,
      amount: withdrawalRequests.amount,
      requestedAt: withdrawalRequests.requestedAt,
    })
    .from(withdrawalRequests)
    .innerJoin(users, eq(users.id, withdrawalRequests.userId))
    .where(eq(withdrawalRequests.status, 'REQUESTED'))
    .orderBy(asc(withdrawalRequests.requestedAt))
  return rows as PendingReview[]
}

/**
 * Approve a withdrawal and hand it to the signer.
 *
 * No ledger movement happens here — the funds were ring-fenced at request time. The signer
 * job is keyed on the request id, so a double-clicked approve button enqueues one job. The
 * row lock (`FOR UPDATE`) means two concurrent approvals also produce exactly one job: the
 * second transaction blocks until the first commits, then sees status `APPROVED` and replays
 * the existing job id instead of enqueueing a second one.
 */
export async function approveWithdrawal(
  db: Db,
  args: { requestId: string; adminId: string; note?: string },
): Promise<{ jobId: string }> {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: withdrawalRequests.id,
        userId: withdrawalRequests.userId,
        address: withdrawalRequests.address,
        amount: withdrawalRequests.amount,
        status: withdrawalRequests.status,
        signerJobId: withdrawalRequests.signerJobId,
      })
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, args.requestId))
      .for('update')
      .limit(1)

    if (!request) throw new WithdrawalError(`no withdrawal ${args.requestId}`, 'NOT_FOUND')

    // Replaying an approval returns the original job rather than making a second one.
    if (request.status === 'APPROVED' && request.signerJobId) {
      return { jobId: request.signerJobId }
    }
    if (request.status !== 'REQUESTED') {
      throw new WithdrawalError(`withdrawal is ${request.status}`, 'NOT_REVIEWABLE')
    }

    const { jobId } = await enqueueJob(tx, {
      kind: 'WITHDRAW',
      idempotencyKey: `withdraw:${request.id}`,
      payload: {
        requestId: request.id,
        userId: request.userId,
        address: request.address,
        amountMicros: request.amount.toString(),
      },
    })

    await tx
      .update(withdrawalRequests)
      .set({
        status: 'APPROVED',
        reviewedBy: args.adminId,
        reviewedAt: sql`now()`,
        reviewNote: args.note ?? null,
        signerJobId: jobId,
      })
      .where(eq(withdrawalRequests.id, request.id))

    return { jobId }
  })
}

export async function rejectWithdrawal(
  db: Db,
  args: { requestId: string; adminId: string; note: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: withdrawalRequests.id,
        userId: withdrawalRequests.userId,
        amount: withdrawalRequests.amount,
        status: withdrawalRequests.status,
      })
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, args.requestId))
      .for('update')
      .limit(1)

    if (!request) throw new WithdrawalError(`no withdrawal ${args.requestId}`, 'NOT_FOUND')
    if (request.status === 'REJECTED') return // funds already returned
    if (request.status !== 'REQUESTED') {
      throw new WithdrawalError(`withdrawal is ${request.status}`, 'NOT_REVIEWABLE')
    }

    const [availableAccount, pendingAccount] = await Promise.all([
      userAvailableAccount(tx, request.userId),
      userPendingWithdrawalAccount(tx, request.userId),
    ])

    await postTransaction(tx, {
      kind: 'WITHDRAWAL_REJECTED',
      idempotencyKey: `withdrawal:reject:${request.id}`,
      metadata: { requestId: request.id, adminId: args.adminId },
      legs: [
        { accountId: pendingAccount, amount: -request.amount },
        { accountId: availableAccount, amount: request.amount },
      ],
    })

    await tx
      .update(withdrawalRequests)
      .set({
        status: 'REJECTED',
        reviewedBy: args.adminId,
        reviewedAt: sql`now()`,
        reviewNote: args.note,
      })
      .where(eq(withdrawalRequests.id, request.id))
  })
}
