import { eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { withdrawalRequests } from '@/lib/db/schema'
import type { TronClient } from '@/lib/tron/client'
import { confirmWithdrawal } from './settle'

/**
 * Confirm broadcast withdrawals once the destination shows the transfer buried deep enough.
 *
 * The check is deliberately "did a transfer of this amount to this address land in a block
 * at least N deep", rather than trusting the broadcast receipt: a receipt says the node
 * accepted the transaction, not that it survived.
 */
export async function pollWithdrawals(
  db: Db,
  tron: TronClient,
  opts: { confirmations: number },
): Promise<{ confirmed: string[] }> {
  const head = await tron.headBlock()
  const confirmed: string[] = []

  const broadcast = await db
    .select({
      id: withdrawalRequests.id,
      address: withdrawalRequests.address,
      amount: withdrawalRequests.amount,
      txHash: withdrawalRequests.txHash,
    })
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.status, 'BROADCAST'))

  for (const request of broadcast) {
    try {
      const transfers = await tron.incomingTransfers(request.address)
      const landed = transfers.find(
        (t) =>
          t.txHash === request.txHash &&
          t.amountMicros === request.amount &&
          head - t.blockNumber + 1 >= opts.confirmations,
      )
      if (!landed) continue

      await confirmWithdrawal(db, request.id)
      confirmed.push(request.id)
    } catch (err) {
      console.error(`[withdrawals] failed to check ${request.id}:`, err)
    }
  }

  return { confirmed }
}
