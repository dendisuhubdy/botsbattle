import type { Db } from '@/lib/db/client'
import type { TronClient } from '@/lib/tron/client'
import { listDepositAddresses } from './addresses'
import { creditConfirmedDeposits, recordSeenTransfer } from './credit'

export type PollResult = {
  headBlock: number
  addressesScanned: number
  newTransfers: number
  credited: string[]
}

/**
 * One poll cycle. A read failure on a single address is logged and skipped rather than
 * aborting the cycle: one unlucky address must not stall every other user's deposits.
 */
export async function pollDeposits(
  db: Db,
  tron: TronClient,
  opts: { confirmations: number },
): Promise<PollResult> {
  const headBlock = await tron.headBlock()
  const addresses = await listDepositAddresses(db)
  let newTransfers = 0

  for (const { address } of addresses) {
    try {
      for (const transfer of await tron.incomingTransfers(address)) {
        const recorded = await recordSeenTransfer(db, transfer)
        if (recorded && !recorded.alreadyKnown) newTransfers++
      }
    } catch (err) {
      console.error(`[poller] failed to read ${address}:`, err)
    }
  }

  const credited = await creditConfirmedDeposits(db, headBlock, opts.confirmations)
  return { headBlock, addressesScanned: addresses.length, newTransfers, credited }
}
