import { eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { bets, fights, settlements } from '@/lib/db/schema'
import { balanceOf, houseAccount, poolAccount, userAvailableAccount } from '@/lib/ledger/accounts'
import { postTransaction, type Leg } from '@/lib/ledger/post'
import type { Outcome, Side } from '@/lib/fights/repo'
import { computeSettlement, type SettlementResult } from './math'

export class SettleError extends Error {
  constructor(
    message: string,
    readonly code: 'FIGHT_NOT_FOUND' | 'NOT_SETTLEABLE' | 'POOL_NOT_DRAINED',
  ) {
    super(message)
    this.name = 'SettleError'
  }
}

export type SettleArgs = { fightId: string; outcome: Outcome; settledBy: string }

/**
 * Settle one fight in one database transaction, keyed by `fight_id` with a unique
 * constraint on `settlements` so a double-click cannot double-pay.
 *
 * Rules enforced here rather than in the API layer:
 * - an outcome of 'A' or 'B' requires the fight to be LOCKED
 * - an outcome of 'VOID' is allowed from OPEN or LOCKED
 * - the fight row is taken FOR UPDATE so no bet can slip in beside a settlement
 * - after posting, the pool account must be exactly zero or the transaction aborts
 */
export async function settleFight(
  db: Db,
  args: SettleArgs,
): Promise<SettlementResult & { replayed: boolean }> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: fights.id, status: fights.status, rakeBps: fights.rakeBps })
      .from(fights)
      .where(eq(fights.id, args.fightId))
      .for('update')
      .limit(1)

    if (!locked.length) throw new SettleError(`fight ${args.fightId} not found`, 'FIGHT_NOT_FOUND')
    const fight = locked[0]

    // Replay: the settlements table is uniquely keyed by fight_id.
    const prior = await tx
      .select()
      .from(settlements)
      .where(eq(settlements.fightId, args.fightId))
      .limit(1)

    if (prior.length) {
      const paid = await tx
        .select({ id: bets.id, payout: bets.payout })
        .from(bets)
        .where(eq(bets.fightId, args.fightId))
        .orderBy(bets.createdAt, bets.id)
      return {
        replayed: true,
        refunded: prior[0].refunded,
        poolTotal: prior[0].poolTotal,
        winningPool: prior[0].winningPool,
        rake: prior[0].rake,
        dust: prior[0].dust,
        payouts: paid
          .filter((b) => (b.payout ?? 0n) > 0n)
          .map((b) => ({ betId: b.id, amount: b.payout as bigint })),
      }
    }

    const settleable =
      args.outcome === 'VOID'
        ? fight.status === 'OPEN' || fight.status === 'LOCKED'
        : fight.status === 'LOCKED'

    if (!settleable) {
      throw new SettleError(
        `fight ${args.fightId} is ${fight.status}; cannot settle with outcome ${args.outcome}`,
        'NOT_SETTLEABLE',
      )
    }

    // Ordered so a replay returns payouts in the same order as the original call.
    const placed = await tx
      .select({ id: bets.id, userId: bets.userId, side: bets.side, stake: bets.stake })
      .from(bets)
      .where(eq(bets.fightId, args.fightId))
      .orderBy(bets.createdAt, bets.id)

    const result = computeSettlement({
      outcome: args.outcome,
      rakeBps: fight.rakeBps,
      bets: placed.map((b) => ({ id: b.id, side: b.side as Side, stake: b.stake })),
    })

    // Aggregate payouts per user account; per-bet detail is written to bets.payout below.
    const userOf = new Map(placed.map((b) => [b.id, b.userId]))
    const perUser = new Map<string, bigint>()
    for (const p of result.payouts) {
      const userId = userOf.get(p.betId)!
      perUser.set(userId, (perUser.get(userId) ?? 0n) + p.amount)
    }

    const pool = await poolAccount(tx, args.fightId)
    const legs: Leg[] = [{ accountId: pool, amount: -result.poolTotal }]

    for (const [userId, amount] of perUser) {
      legs.push({ accountId: await userAvailableAccount(tx, userId), amount })
    }
    if (result.rake > 0n) {
      legs.push({ accountId: await houseAccount(tx, 'house_rake'), amount: result.rake })
    }
    if (result.dust > 0n) {
      legs.push({ accountId: await houseAccount(tx, 'house_dust'), amount: result.dust })
    }

    if (result.poolTotal > 0n) {
      await postTransaction(tx, {
        kind: 'SETTLEMENT',
        idempotencyKey: `settle:${args.fightId}`,
        metadata: { fightId: args.fightId, outcome: args.outcome, settledBy: args.settledBy },
        legs,
      })
    }

    // Per-bet payouts: winners get their computed amount, everyone else an explicit zero.
    const payoutById = new Map(result.payouts.map((p) => [p.betId, p.amount]))
    for (const b of placed) {
      await tx
        .update(bets)
        .set({ payout: payoutById.get(b.id) ?? 0n })
        .where(eq(bets.id, b.id))
    }

    await tx.insert(settlements).values({
      fightId: args.fightId,
      outcome: args.outcome,
      poolTotal: result.poolTotal,
      winningPool: result.winningPool,
      rake: result.rake,
      dust: result.dust,
      refunded: result.refunded,
      settledBy: args.settledBy,
    })

    await tx
      .update(fights)
      .set({
        status: args.outcome === 'VOID' ? 'VOIDED' : 'SETTLED',
        outcome: args.outcome,
        settledAt: sql`now()`,
      })
      .where(eq(fights.id, args.fightId))

    const remaining = await balanceOf(tx, pool)
    if (remaining !== 0n) {
      throw new SettleError(
        `pool for fight ${args.fightId} still holds ${remaining} after settlement`,
        'POOL_NOT_DRAINED',
      )
    }

    return { ...result, replayed: false }
  })
}
