import { and, eq, sql } from 'drizzle-orm'
import type { Executor } from '@/lib/db/client'
import { accounts, ledgerEntries } from '@/lib/db/schema'

type AccountKind = (typeof accounts.$inferInsert)['kind']
type HouseKind = 'house_rake' | 'house_dust' | 'hot_wallet'

/**
 * Get-or-create relies on the partial unique indexes from migration 0001;
 * `onConflictDoNothing` plus a follow-up select makes it safe under concurrency.
 */
async function getOrCreate(
  x: Executor,
  match: { kind: AccountKind; userId?: string; fightId?: string },
): Promise<string> {
  const where = and(
    eq(accounts.kind, match.kind),
    match.userId ? eq(accounts.userId, match.userId) : sql`user_id IS NULL`,
    match.fightId ? eq(accounts.fightId, match.fightId) : sql`fight_id IS NULL`,
  )

  const existing = await x.select({ id: accounts.id }).from(accounts).where(where).limit(1)
  if (existing.length) return existing[0].id

  const inserted = await x
    .insert(accounts)
    .values({ kind: match.kind, userId: match.userId ?? null, fightId: match.fightId ?? null })
    .onConflictDoNothing()
    .returning({ id: accounts.id })
  if (inserted.length) return inserted[0].id

  const raced = await x.select({ id: accounts.id }).from(accounts).where(where).limit(1)
  if (!raced.length) throw new Error(`could not resolve account ${JSON.stringify(match)}`)
  return raced[0].id
}

export function userAvailableAccount(x: Executor, userId: string): Promise<string> {
  return getOrCreate(x, { kind: 'user_available', userId })
}

export function userPendingWithdrawalAccount(x: Executor, userId: string): Promise<string> {
  return getOrCreate(x, { kind: 'user_pending_withdrawal', userId })
}

export function poolAccount(x: Executor, fightId: string): Promise<string> {
  return getOrCreate(x, { kind: 'pool', fightId })
}

export function houseAccount(x: Executor, kind: HouseKind): Promise<string> {
  return getOrCreate(x, { kind })
}

export async function balanceOf(x: Executor, accountId: string): Promise<bigint> {
  const rows = await x
    .select({ balance: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId))
  return BigInt(rows[0]?.balance ?? '0')
}

export async function userBalance(x: Executor, userId: string): Promise<bigint> {
  return balanceOf(x, await userAvailableAccount(x, userId))
}
