import { and, desc, eq } from 'drizzle-orm'
import type { Db, Executor } from '@/lib/db/client'
import { users, withdrawalRequests } from '@/lib/db/schema'
import {
  balanceOf,
  userAvailableAccount,
  userPendingWithdrawalAccount,
} from '@/lib/ledger/accounts'
import { postTransaction } from '@/lib/ledger/post'
import { verifyTotp } from '@/lib/auth/totp'
import { isTronAddress } from '@/lib/tron/address'

export const MIN_WITHDRAWAL_MICROS = 10_000_000n

export class WithdrawalError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INSUFFICIENT_FUNDS'
      | 'BELOW_MINIMUM'
      | 'INVALID_ADDRESS'
      | 'LOCKED'
      | 'NOT_FOUND'
      | 'NOT_CANCELLABLE',
  ) {
    super(message)
    this.name = 'WithdrawalError'
  }
}

export type UserWithdrawal = {
  id: string
  address: string
  amount: bigint
  status: string
  requestedAt: Date
  txHash: string | null
  failureReason: string | null
}

/**
 * Create a withdrawal request and ring-fence its funds in the same transaction.
 *
 * The ledger move happens before any human or chain involvement: a request that exists
 * without its funds moved out of `user_available` is a double-spend waiting to happen,
 * because the user could stake the same money while an admin reviews the withdrawal.
 */
export async function requestWithdrawal(
  db: Db,
  args: { userId: string; address: string; amountMicros: bigint; totpCode: string },
): Promise<{ requestId: string }> {
  if (!isTronAddress(args.address)) {
    throw new WithdrawalError(`not a valid Tron address: ${args.address}`, 'INVALID_ADDRESS')
  }
  if (args.amountMicros < MIN_WITHDRAWAL_MICROS) {
    throw new WithdrawalError(
      `minimum withdrawal is ${MIN_WITHDRAWAL_MICROS} micro-units`,
      'BELOW_MINIMUM',
    )
  }

  // TOTP is checked before the lock so a wrong code costs nothing.
  await verifyTotp(db, args.userId, args.totpCode)

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, locked: users.withdrawalLocked })
      .from(users)
      .where(eq(users.id, args.userId))
      .for('update')
      .limit(1)

    if (!user) throw new WithdrawalError(`no user ${args.userId}`, 'NOT_FOUND')
    if (user.locked) {
      throw new WithdrawalError('withdrawals are locked on this account', 'LOCKED')
    }

    const availableAccount = await userAvailableAccount(tx, args.userId)
    const available = await balanceOf(tx, availableAccount)
    if (available < args.amountMicros) {
      throw new WithdrawalError(
        `balance ${available} is less than ${args.amountMicros}`,
        'INSUFFICIENT_FUNDS',
      )
    }

    const [created] = await tx
      .insert(withdrawalRequests)
      .values({ userId: args.userId, address: args.address, amount: args.amountMicros })
      .returning({ id: withdrawalRequests.id })

    const pendingAccount = await userPendingWithdrawalAccount(tx, args.userId)
    await postTransaction(tx, {
      kind: 'WITHDRAWAL_REQUESTED',
      idempotencyKey: `withdrawal:request:${created.id}`,
      metadata: { userId: args.userId, requestId: created.id, address: args.address },
      legs: [
        { accountId: availableAccount, amount: -args.amountMicros },
        { accountId: pendingAccount, amount: args.amountMicros },
      ],
    })

    return { requestId: created.id }
  })
}

/** Return ring-fenced funds to the user. Only a REQUESTED withdrawal can be cancelled. */
export async function cancelWithdrawal(
  db: Db,
  args: { userId: string; requestId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: withdrawalRequests.id,
        amount: withdrawalRequests.amount,
        status: withdrawalRequests.status,
      })
      .from(withdrawalRequests)
      .where(
        and(
          eq(withdrawalRequests.id, args.requestId),
          eq(withdrawalRequests.userId, args.userId),
        ),
      )
      .for('update')
      .limit(1)

    if (!request) throw new WithdrawalError(`no withdrawal ${args.requestId}`, 'NOT_FOUND')
    if (request.status === 'CANCELLED') return // already returned; replaying is a no-op
    if (request.status !== 'REQUESTED') {
      throw new WithdrawalError(`withdrawal is ${request.status}`, 'NOT_CANCELLABLE')
    }

    const [availableAccount, pendingAccount] = await Promise.all([
      userAvailableAccount(tx, args.userId),
      userPendingWithdrawalAccount(tx, args.userId),
    ])

    await postTransaction(tx, {
      kind: 'WITHDRAWAL_CANCELLED',
      idempotencyKey: `withdrawal:cancel:${request.id}`,
      metadata: { userId: args.userId, requestId: request.id },
      legs: [
        { accountId: pendingAccount, amount: -request.amount },
        { accountId: availableAccount, amount: request.amount },
      ],
    })

    await tx
      .update(withdrawalRequests)
      .set({ status: 'CANCELLED' })
      .where(eq(withdrawalRequests.id, request.id))
  })
}

export async function listUserWithdrawals(
  x: Executor,
  userId: string,
): Promise<UserWithdrawal[]> {
  const rows = await x
    .select({
      id: withdrawalRequests.id,
      address: withdrawalRequests.address,
      amount: withdrawalRequests.amount,
      status: withdrawalRequests.status,
      requestedAt: withdrawalRequests.requestedAt,
      txHash: withdrawalRequests.txHash,
      failureReason: withdrawalRequests.failureReason,
    })
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.userId, userId))
    .orderBy(desc(withdrawalRequests.requestedAt))
  return rows as UserWithdrawal[]
}
