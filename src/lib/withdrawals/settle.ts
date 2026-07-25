import { eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { withdrawalRequests } from '@/lib/db/schema'
import {
  houseAccount,
  userAvailableAccount,
  userPendingWithdrawalAccount,
} from '@/lib/ledger/accounts'
import { postTransaction } from '@/lib/ledger/post'
import { WithdrawalError } from './request'

export async function markBroadcast(
  db: Db,
  args: { requestId: string; txHash: string },
): Promise<void> {
  await db
    .update(withdrawalRequests)
    .set({ status: 'BROADCAST', txHash: args.txHash, broadcastAt: sql`now()` })
    .where(eq(withdrawalRequests.id, args.requestId))
}

/**
 * The money has genuinely left the platform. Close out the ring-fence against chain custody:
 * `hot_wallet` is carried with inverted sign, so a positive leg here *reduces* the custody
 * obligation by the amount that left.
 */
export async function confirmWithdrawal(db: Db, requestId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: withdrawalRequests.id,
        userId: withdrawalRequests.userId,
        amount: withdrawalRequests.amount,
        status: withdrawalRequests.status,
      })
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
      .for('update')
      .limit(1)

    if (!request) throw new WithdrawalError(`no withdrawal ${requestId}`, 'NOT_FOUND')
    if (request.status === 'CONFIRMED') return
    if (request.status !== 'BROADCAST') {
      throw new WithdrawalError(`withdrawal is ${request.status}`, 'NOT_REVIEWABLE')
    }

    const [pendingAccount, hotWallet] = await Promise.all([
      userPendingWithdrawalAccount(tx, request.userId),
      houseAccount(tx, 'hot_wallet'),
    ])

    await postTransaction(tx, {
      kind: 'WITHDRAWAL_CONFIRMED',
      idempotencyKey: `withdrawal:confirm:${request.id}`,
      metadata: { requestId: request.id, userId: request.userId },
      legs: [
        { accountId: pendingAccount, amount: -request.amount },
        { accountId: hotWallet, amount: request.amount },
      ],
    })

    await tx
      .update(withdrawalRequests)
      .set({ status: 'CONFIRMED', confirmedAt: sql`now()` })
      .where(eq(withdrawalRequests.id, request.id))
  })
}

/** The withdrawal will never land. Return the ring-fenced funds to the user. */
export async function failWithdrawal(
  db: Db,
  args: { requestId: string; reason: string },
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
    if (request.status === 'FAILED') return
    if (request.status === 'CONFIRMED') {
      throw new WithdrawalError('cannot fail a confirmed withdrawal', 'NOT_REVIEWABLE')
    }

    const [availableAccount, pendingAccount] = await Promise.all([
      userAvailableAccount(tx, request.userId),
      userPendingWithdrawalAccount(tx, request.userId),
    ])

    await postTransaction(tx, {
      kind: 'WITHDRAWAL_FAILED',
      idempotencyKey: `withdrawal:fail:${request.id}`,
      metadata: { requestId: request.id, reason: args.reason },
      legs: [
        { accountId: pendingAccount, amount: -request.amount },
        { accountId: availableAccount, amount: request.amount },
      ],
    })

    await tx
      .update(withdrawalRequests)
      .set({ status: 'FAILED', failureReason: args.reason })
      .where(eq(withdrawalRequests.id, request.id))
  })
}
