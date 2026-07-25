import { desc, eq, sql } from 'drizzle-orm'
import type { Db, Executor } from '@/lib/db/client'
import { bets, fights } from '@/lib/db/schema'
import { MIN_STAKE_MICROS } from '@/lib/money/units'
import { balanceOf, poolAccount, userAvailableAccount } from '@/lib/ledger/accounts'
import { postTransaction } from '@/lib/ledger/post'
import type { Side, FightStatus, Outcome } from '@/lib/fights/repo'

export class BetError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'FIGHT_NOT_FOUND'
      | 'FIGHT_NOT_OPEN'
      | 'FIGHT_LOCKED'
      | 'INSUFFICIENT_FUNDS'
      | 'STAKE_BELOW_MINIMUM',
  ) {
    super(message)
    this.name = 'BetError'
  }
}

export type PlaceBetArgs = {
  userId: string
  fightId: string
  side: Side
  stake: bigint
  idempotencyKey: string
}

export type PlaceBetResult = { betId: string; replayed: boolean }

/**
 * The order inside the transaction is the whole point of this module: take the fight row
 * lock first, re-check status and time under that lock, then check the balance from the
 * ledger, then write. A bet accepted a moment after the outcome becomes knowable is free
 * money taken from other users.
 */
export async function placeBet(db: Db, args: PlaceBetArgs): Promise<PlaceBetResult> {
  if (args.stake < MIN_STAKE_MICROS) {
    throw new BetError(
      `stake ${args.stake} is below the ${MIN_STAKE_MICROS} micro-unit minimum`,
      'STAKE_BELOW_MINIMUM',
    )
  }

  return db.transaction(async (tx) => {
    // Replay check before anything else: a retried request must not re-lock or re-charge.
    const existing = await tx
      .select({ id: bets.id })
      .from(bets)
      .where(eq(bets.idempotencyKey, args.idempotencyKey))
      .limit(1)
    if (existing.length) return { betId: existing[0].id, replayed: true }

    // Serialise every bet on this fight against every other one. The lock-time comparison
    // happens in SQL so it uses the database clock and needs no extra round trip.
    const locked = await tx
      .select({
        id: fights.id,
        status: fights.status,
        lockAt: fights.lockAt,
        pastLock: sql<boolean>`${fights.lockAt} <= now()`,
      })
      .from(fights)
      .where(eq(fights.id, args.fightId))
      .for('update')
      .limit(1)

    if (!locked.length) throw new BetError(`fight ${args.fightId} not found`, 'FIGHT_NOT_FOUND')
    const fight = locked[0]

    if (fight.status !== 'OPEN') {
      throw new BetError(`fight ${args.fightId} is ${fight.status}, not OPEN`, 'FIGHT_NOT_OPEN')
    }

    if (fight.pastLock) {
      throw new BetError(`fight ${args.fightId} locked at ${fight.lockAt}`, 'FIGHT_LOCKED')
    }

    const userAccount = await userAvailableAccount(tx, args.userId)
    const available = await balanceOf(tx, userAccount)
    if (available < args.stake) {
      throw new BetError(`balance ${available} is less than stake ${args.stake}`, 'INSUFFICIENT_FUNDS')
    }

    const pool = await poolAccount(tx, args.fightId)
    await postTransaction(tx, {
      kind: 'BET',
      idempotencyKey: `bet:${args.idempotencyKey}`,
      metadata: { userId: args.userId, fightId: args.fightId, side: args.side },
      legs: [
        { accountId: userAccount, amount: -args.stake },
        { accountId: pool, amount: args.stake },
      ],
    })

    const [created] = await tx
      .insert(bets)
      .values({
        fightId: args.fightId,
        userId: args.userId,
        side: args.side,
        stake: args.stake,
        idempotencyKey: args.idempotencyKey,
      })
      .returning({ id: bets.id })

    return { betId: created.id, replayed: false }
  })
}

export type UserBet = {
  id: string
  fightId: string
  leagueName: string
  fighterA: string
  fighterB: string
  side: Side
  stake: bigint
  payout: bigint | null
  fightStatus: FightStatus
  outcome: Outcome | null
  createdAt: Date
}

export async function listUserBets(x: Executor, userId: string): Promise<UserBet[]> {
  const rows = await x
    .select({
      id: bets.id,
      fightId: bets.fightId,
      leagueName: fights.leagueName,
      fighterA: fights.fighterA,
      fighterB: fights.fighterB,
      side: bets.side,
      stake: bets.stake,
      payout: bets.payout,
      fightStatus: fights.status,
      outcome: fights.outcome,
      createdAt: bets.createdAt,
    })
    .from(bets)
    .innerJoin(fights, eq(fights.id, bets.fightId))
    .where(eq(bets.userId, userId))
    .orderBy(desc(bets.createdAt))

  return rows as UserBet[]
}
