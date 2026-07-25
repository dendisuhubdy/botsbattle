import { eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { ledgerEntries, ledgerTransactions } from '@/lib/db/schema'
import { balanceOf, houseAccount } from '@/lib/ledger/accounts'
import { listDepositAddresses } from '@/lib/deposits/addresses'
import type { TronClient } from '@/lib/tron/client'

export type Reconciliation = {
  onChainMicros: bigint
  ledgerCustodyMicros: bigint
  adminCreditedMicros: bigint
  differenceMicros: bigint
  balanced: boolean
  perAddress: Array<{ address: string; onChain: bigint }>
}

/**
 * Compare what the chain holds against what the ledger says we hold.
 *
 * `hot_wallet` is a chain-custody account carried with inverted sign (see the Slice 2 plan's
 * "Ledger convention"), so the ledger's view of custody is its negated balance.
 *
 * Admin credits from Slice 1 are money that was never on chain. They are reported and
 * netted out separately, so leftover test data does not masquerade as a shortfall.
 */
export async function reconcileChain(
  db: Db,
  tron: TronClient,
  hotWalletAddress: string,
): Promise<Reconciliation> {
  const addresses = await listDepositAddresses(db)
  const perAddress: Array<{ address: string; onChain: bigint }> = []
  let onChainMicros = 0n

  for (const { address } of addresses) {
    const onChain = await tron.trc20Balance(address)
    perAddress.push({ address, onChain })
    onChainMicros += onChain
  }

  const hotOnChain = await tron.trc20Balance(hotWalletAddress)
  perAddress.push({ address: hotWalletAddress, onChain: hotOnChain })
  onChainMicros += hotOnChain

  const ledgerCustodyMicros = -(await balanceOf(db, await houseAccount(db, 'hot_wallet')))

  const adminRows = await db
    .select({ total: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txId))
    .where(
      sql`${ledgerTransactions.kind} = 'ADMIN_CREDIT' AND ${ledgerEntries.accountId} = (
        SELECT id FROM accounts WHERE kind = 'hot_wallet' LIMIT 1
      )`,
    )
  const adminCreditedMicros = -BigInt(adminRows[0]?.total ?? '0')

  const differenceMicros = onChainMicros - (ledgerCustodyMicros - adminCreditedMicros)

  return {
    onChainMicros,
    ledgerCustodyMicros,
    adminCreditedMicros,
    differenceMicros,
    balanced: differenceMicros === 0n,
    perAddress,
  }
}
