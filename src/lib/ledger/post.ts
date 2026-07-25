import { eq } from 'drizzle-orm'
import type { Db, Executor, Tx } from '@/lib/db/client'
import { ledgerEntries, ledgerTransactions } from '@/lib/db/schema'

export type Leg = { accountId: string; amount: bigint }

export type PostArgs = {
  kind: string
  idempotencyKey: string
  legs: Leg[]
  metadata?: Record<string, unknown>
}

export type PostResult = { txId: string; replayed: boolean }

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: 'UNBALANCED' | 'EMPTY',
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}

/** A `Tx` carries a rollback handle; a pooled `Db` does not. */
function isTx(x: Executor): x is Tx {
  return 'rollback' in x
}

/**
 * Write one balanced ledger transaction.
 * Replaying an `idempotencyKey` is a no-op that returns the original transaction id.
 *
 * The header row and its entries must land in the same database transaction: the
 * `ledger_transactions_nonempty` constraint trigger fires at COMMIT, so an autocommitted
 * header with no entries yet is a constraint violation. When handed a pooled `Db` this
 * opens its own transaction; when handed a `Tx` it joins the caller's.
 */
export async function postTransaction(x: Executor, args: PostArgs): Promise<PostResult> {
  const legs = args.legs.filter((leg) => leg.amount !== 0n)
  if (legs.length === 0) {
    throw new LedgerError(`transaction ${args.idempotencyKey} has no non-zero legs`, 'EMPTY')
  }

  const sum = legs.reduce((acc, leg) => acc + leg.amount, 0n)
  if (sum !== 0n) {
    throw new LedgerError(
      `transaction ${args.idempotencyKey} does not sum to zero (sum = ${sum})`,
      'UNBALANCED',
    )
  }

  if (isTx(x)) return write(x, args, legs)
  return (x as Db).transaction((tx) => write(tx, args, legs))
}

async function write(x: Executor, args: PostArgs, legs: Leg[]): Promise<PostResult> {
  const inserted = await x
    .insert(ledgerTransactions)
    .values({
      kind: args.kind,
      idempotencyKey: args.idempotencyKey,
      metadata: args.metadata ?? {},
    })
    .onConflictDoNothing({ target: ledgerTransactions.idempotencyKey })
    .returning({ id: ledgerTransactions.id })

  if (!inserted.length) {
    const existing = await x
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, args.idempotencyKey))
      .limit(1)
    return { txId: existing[0].id, replayed: true }
  }

  const txId = inserted[0].id
  await x
    .insert(ledgerEntries)
    .values(legs.map((leg) => ({ txId, accountId: leg.accountId, amount: leg.amount })))

  return { txId, replayed: false }
}
