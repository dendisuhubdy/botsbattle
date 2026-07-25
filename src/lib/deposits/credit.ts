import { and, eq, lte, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { depositAddresses, deposits } from '@/lib/db/schema'
import { houseAccount, userAvailableAccount } from '@/lib/ledger/accounts'
import { postTransaction } from '@/lib/ledger/post'
import type { Trc20Transfer } from '@/lib/tron/client'

export class DepositError extends Error {
  constructor(
    message: string,
    readonly code: 'UNKNOWN_ADDRESS',
  ) {
    super(message)
    this.name = 'DepositError'
  }
}

export type RecordResult = { depositId: string; alreadyKnown: boolean }

/**
 * Persist a transfer we have observed on chain. Does not move money — crediting waits
 * for confirmations. Returns `null` when the destination is not one of our addresses,
 * which is normal: TronGrid can return transfers we never asked about.
 */
export async function recordSeenTransfer(
  db: Db,
  transfer: Trc20Transfer,
): Promise<RecordResult | null> {
  const owned = await db
    .select({ address: depositAddresses.address })
    .from(depositAddresses)
    .where(eq(depositAddresses.address, transfer.to))
    .limit(1)
  if (!owned.length) return null

  const inserted = await db
    .insert(deposits)
    .values({
      txHash: transfer.txHash,
      logIndex: transfer.logIndex,
      address: transfer.to,
      fromAddress: transfer.from,
      amount: transfer.amountMicros,
      blockNumber: BigInt(transfer.blockNumber),
    })
    .onConflictDoNothing({ target: [deposits.txHash, deposits.logIndex] })
    .returning({ id: deposits.id })

  if (inserted.length) return { depositId: inserted[0].id, alreadyKnown: false }

  const existing = await db
    .select({ id: deposits.id })
    .from(deposits)
    .where(and(eq(deposits.txHash, transfer.txHash), eq(deposits.logIndex, transfer.logIndex)))
    .limit(1)
  return { depositId: existing[0].id, alreadyKnown: true }
}

/**
 * Credit every PENDING deposit buried at least `confirmations` blocks deep.
 *
 * Each deposit is its own transaction: one failure must not roll back the others, and the
 * ledger idempotency key means a retry after a partial run is safe.
 */
export async function creditConfirmedDeposits(
  db: Db,
  headBlock: number,
  confirmations: number,
): Promise<string[]> {
  const maxBlock = BigInt(headBlock - confirmations + 1)

  const ready = await db
    .select({
      id: deposits.id,
      txHash: deposits.txHash,
      logIndex: deposits.logIndex,
      amount: deposits.amount,
      userId: depositAddresses.userId,
    })
    .from(deposits)
    .innerJoin(depositAddresses, eq(depositAddresses.address, deposits.address))
    .where(and(eq(deposits.status, 'PENDING'), lte(deposits.blockNumber, maxBlock)))

  const credited: string[] = []

  for (const deposit of ready) {
    await db.transaction(async (tx) => {
      // Re-read under the row lock so two workers cannot both credit this deposit.
      const locked = await tx
        .select({ status: deposits.status })
        .from(deposits)
        .where(eq(deposits.id, deposit.id))
        .for('update')
        .limit(1)
      if (!locked.length || locked[0].status !== 'PENDING') return

      const [userAccount, hotWallet] = await Promise.all([
        userAvailableAccount(tx, deposit.userId),
        houseAccount(tx, 'hot_wallet'),
      ])

      const posted = await postTransaction(tx, {
        kind: 'DEPOSIT',
        idempotencyKey: `deposit:${deposit.txHash}:${deposit.logIndex}`,
        metadata: {
          depositId: deposit.id,
          userId: deposit.userId,
          txHash: deposit.txHash,
          logIndex: deposit.logIndex,
        },
        legs: [
          { accountId: hotWallet, amount: -deposit.amount },
          { accountId: userAccount, amount: deposit.amount },
        ],
      })

      await tx
        .update(deposits)
        .set({ status: 'CREDITED', ledgerTxId: posted.txId, creditedAt: sql`now()` })
        .where(eq(deposits.id, deposit.id))

      credited.push(deposit.id)
    })
  }

  return credited
}
