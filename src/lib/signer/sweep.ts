import type { Db } from '@/lib/db/client'
import type { TronClient } from '@/lib/tron/client'
import { listDepositAddresses } from '@/lib/deposits/addresses'
import { enqueueJob } from './jobs'

export type SweepPayload = {
  derivationIndex: number
  address: string
  /** Serialised because JSONB cannot hold a bigint. */
  amountMicros: string
}

/**
 * Sweeping costs TRX for energy and bandwidth, so it is only economical above a threshold.
 * Funds below it stay at the deposit address; the user's ledger balance is already credited
 * and spendable, so this is expected behaviour rather than a stuck deposit.
 */
export async function planSweeps(
  db: Db,
  tron: TronClient,
  opts: { minMicros: bigint },
): Promise<SweepPayload[]> {
  const addresses = await listDepositAddresses(db)
  const plans: SweepPayload[] = []

  for (const { address, derivationIndex } of addresses) {
    try {
      const balance = await tron.trc20Balance(address)
      if (balance < opts.minMicros) continue
      plans.push({ derivationIndex, address, amountMicros: balance.toString() })
    } catch (err) {
      console.error(`[sweep] failed to read balance for ${address}:`, err)
    }
  }

  return plans
}

export async function enqueueSweeps(
  db: Db,
  tron: TronClient,
  opts: { minMicros: bigint },
): Promise<number> {
  let created = 0

  for (const plan of await planSweeps(db, tron, opts)) {
    // Keying on the amount means an unchanged balance re-plans to the same job, while a
    // genuinely larger balance later produces a new one.
    const result = await enqueueJob(db, {
      kind: 'SWEEP',
      idempotencyKey: `sweep:${plan.address}:${plan.amountMicros}`,
      payload: plan as unknown as Record<string, unknown>,
    })
    if (result.created) created++
  }

  return created
}
