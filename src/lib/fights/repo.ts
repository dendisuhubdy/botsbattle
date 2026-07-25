import { and, eq, inArray, lte, sql, desc } from 'drizzle-orm'
import type { Executor } from '@/lib/db/client'
import { bets, fights } from '@/lib/db/schema'
import { MICRO } from '@/lib/money/units'
import { poolAccount } from '@/lib/ledger/accounts'

export type FightStatus = 'DRAFT' | 'OPEN' | 'LOCKED' | 'SETTLED' | 'VOIDED'
export type Side = 'A' | 'B'
export type Outcome = 'A' | 'B' | 'VOID'

export type Fight = {
  id: string
  leagueName: string
  fighterA: string
  fighterB: string
  streamEmbedUrl: string | null
  status: FightStatus
  lockAt: Date
  rakeBps: number
  outcome: Outcome | null
  createdBy: string
  settledAt: Date | null
}

export type CreateFightInput = {
  leagueName: string
  fighterA: string
  fighterB: string
  streamEmbedUrl?: string | null
  lockAt: Date
  rakeBps?: number
  createdBy: string
}

export class FightError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'BAD_TRANSITION' | 'INVALID_RAKE' | 'LOCK_IN_PAST',
  ) {
    super(message)
    this.name = 'FightError'
  }
}

const COLUMNS = {
  id: fights.id,
  leagueName: fights.leagueName,
  fighterA: fights.fighterA,
  fighterB: fights.fighterB,
  streamEmbedUrl: fights.streamEmbedUrl,
  status: fights.status,
  lockAt: fights.lockAt,
  rakeBps: fights.rakeBps,
  outcome: fights.outcome,
  createdBy: fights.createdBy,
  settledAt: fights.settledAt,
}

export async function createFight(x: Executor, input: CreateFightInput): Promise<Fight> {
  const rakeBps = input.rakeBps ?? 500
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > 2000) {
    throw new FightError(`rake_bps must be an integer in 0..2000, got ${rakeBps}`, 'INVALID_RAKE')
  }
  if (input.lockAt.getTime() <= Date.now()) {
    throw new FightError('lock_at must be in the future', 'LOCK_IN_PAST')
  }

  const [created] = await x
    .insert(fights)
    .values({
      leagueName: input.leagueName,
      fighterA: input.fighterA,
      fighterB: input.fighterB,
      streamEmbedUrl: input.streamEmbedUrl ?? null,
      lockAt: input.lockAt,
      rakeBps,
      createdBy: input.createdBy,
    })
    .returning(COLUMNS)

  // Create the pool account up front so settlement never has to.
  await poolAccount(x, created.id)
  return created as Fight
}

export async function getFight(x: Executor, fightId: string): Promise<Fight> {
  const rows = await x.select(COLUMNS).from(fights).where(eq(fights.id, fightId)).limit(1)
  if (!rows.length) throw new FightError(`fight ${fightId} not found`, 'NOT_FOUND')
  return rows[0] as Fight
}

async function transition(
  x: Executor,
  fightId: string,
  from: FightStatus,
  to: FightStatus,
): Promise<Fight> {
  const updated = await x
    .update(fights)
    .set({ status: to })
    .where(and(eq(fights.id, fightId), eq(fights.status, from)))
    .returning(COLUMNS)

  if (updated.length) return updated[0] as Fight

  const current = await getFight(x, fightId) // throws NOT_FOUND if it does not exist
  throw new FightError(
    `cannot move fight ${fightId} from ${current.status} to ${to}`,
    'BAD_TRANSITION',
  )
}

export function publishFight(x: Executor, fightId: string): Promise<Fight> {
  return transition(x, fightId, 'DRAFT', 'OPEN')
}

export function lockFight(x: Executor, fightId: string): Promise<Fight> {
  return transition(x, fightId, 'OPEN', 'LOCKED')
}

/** Backstop for fights whose lock time passed without a bet arriving to enforce it. */
export async function lockDueFights(x: Executor): Promise<number> {
  const locked = await x
    .update(fights)
    .set({ status: 'LOCKED' })
    .where(and(eq(fights.status, 'OPEN'), lte(fights.lockAt, sql`now()`)))
    .returning({ id: fights.id })
  return locked.length
}

export async function listFights(x: Executor, statuses: FightStatus[]): Promise<Fight[]> {
  if (!statuses.length) return []
  const rows = await x
    .select(COLUMNS)
    .from(fights)
    .where(inArray(fights.status, statuses))
    .orderBy(desc(fights.lockAt))
  return rows as Fight[]
}

export type PoolTotals = { total: bigint; a: bigint; b: bigint }

export async function poolTotals(x: Executor, fightId: string): Promise<PoolTotals> {
  const rows = await x
    .select({
      side: bets.side,
      total: sql<string>`COALESCE(SUM(${bets.stake}), 0)`,
    })
    .from(bets)
    .where(eq(bets.fightId, fightId))
    .groupBy(bets.side)

  const a = BigInt(rows.find((r) => r.side === 'A')?.total ?? '0')
  const b = BigInt(rows.find((r) => r.side === 'B')?.total ?? '0')
  return { total: a + b, a, b }
}

/**
 * Estimated payout in micro-units per 1 USDT staked, for each side.
 * `null` means nobody has backed that side yet, so no estimate exists.
 * When one side holds the entire pool the settlement will refund, so the estimate is 1.00x.
 */
export function estimatedPayoutPerUsdt(
  totals: PoolTotals,
  rakeBps: number,
): { a: bigint | null; b: bigint | null } {
  const forSide = (sideTotal: bigint): bigint | null => {
    if (sideTotal === 0n) return null
    if (sideTotal === totals.total) return MICRO
    const distributable = totals.total - (totals.total * BigInt(rakeBps)) / 10000n
    return (distributable * MICRO) / sideTotal
  }
  return { a: forSide(totals.a), b: forSide(totals.b) }
}
