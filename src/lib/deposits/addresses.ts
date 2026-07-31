import { eq, sql } from 'drizzle-orm'
import type { Db, Executor } from '@/lib/db/client'
import { depositAddresses } from '@/lib/db/schema'
import { deriveAddress } from '@/lib/tron/address'

/** Arbitrary constant identifying the index-allocation lock. */
const INDEX_LOCK_KEY = 8_112_026

export type AssignedAddress = { address: string; derivationIndex: number; created: boolean }

export async function getDepositAddress(
  x: Executor,
  userId: string,
): Promise<{ address: string; derivationIndex: number } | null> {
  const rows = await x
    .select({
      address: depositAddresses.address,
      derivationIndex: depositAddresses.derivationIndex,
    })
    .from(depositAddresses)
    .where(eq(depositAddresses.userId, userId))
    .limit(1)
  return rows.length ? rows[0] : null
}

/**
 * Assign this user their permanent deposit address, or return the existing one.
 *
 * Allocation takes a transaction-scoped advisory lock so `MAX(index) + 1` cannot race.
 * Handing two users the same index would point both at one address and make deposits
 * indistinguishable, so the lock is correctness, not throughput tuning.
 */
export async function assignDepositAddress(
  db: Db,
  args: { userId: string; xpub: string },
): Promise<AssignedAddress> {
  const existing = await getDepositAddress(db, args.userId)
  if (existing) return { ...existing, created: false }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INDEX_LOCK_KEY})`)

    // Re-check under the lock: a racing call may have assigned it since our first read.
    const raced = await getDepositAddress(tx, args.userId)
    if (raced) return { ...raced, created: false }

    // Index 0 is reserved for the hot wallet (TRON_HOT_WALLET_INDEX), so user deposit
    // addresses start at 1. Handing index 0 to the first user would make their deposit
    // address *be* the hot wallet: their deposit would be indistinguishable from float,
    // and `enqueueSweeps` -- which sweeps every row in deposit_addresses without excluding
    // the hot wallet -- would queue a sweep from the hot wallet to itself.
    const [{ next }] = await tx
      .execute<{ next: number }>(
        sql`SELECT GREATEST(COALESCE(MAX(derivation_index) + 1, 1), 1)::int AS next
            FROM deposit_addresses`,
      )
      .then((r) => r.rows)

    const address = deriveAddress(args.xpub, next)

    await tx
      .insert(depositAddresses)
      .values({ userId: args.userId, derivationIndex: next, address })

    return { address, derivationIndex: next, created: true }
  })
}

export async function listDepositAddresses(
  x: Executor,
): Promise<Array<{ userId: string; derivationIndex: number; address: string }>> {
  return x
    .select({
      userId: depositAddresses.userId,
      derivationIndex: depositAddresses.derivationIndex,
      address: depositAddresses.address,
    })
    .from(depositAddresses)
    .orderBy(depositAddresses.derivationIndex)
}
