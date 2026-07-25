import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { testDb, truncateAll, errorChain } from '../helpers/db'
import type { Db } from '@/lib/db/client'

describe('database', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('applies migrations and seeds the house accounts', async () => {
    // Sorted in JS: Postgres orders ENUMs by declaration order and text by collation,
    // neither of which is worth encoding in an assertion about set membership.
    const result = await db.execute<{ kind: string }>(sql`SELECT kind FROM accounts`)
    expect(result.rows.map((r) => r.kind).sort()).toEqual(
      ['house_rake', 'house_dust', 'hot_wallet'].sort(),
    )
  })

  it('rejects a ledger transaction whose entries do not sum to zero', async () => {
    const error = await db
      .transaction(async (tx) => {
        const [{ id: txId }] = await tx
          .execute<{ id: string }>(
            sql`INSERT INTO ledger_transactions (kind, idempotency_key)
                VALUES ('test', 'unbalanced-1') RETURNING id`,
          )
          .then((r) => r.rows)

        const [{ id: accountId }] = await tx
          .execute<{ id: string }>(sql`SELECT id FROM accounts WHERE kind = 'house_rake'`)
          .then((r) => r.rows)

        await tx.execute(
          sql`INSERT INTO ledger_entries (tx_id, account_id, amount)
              VALUES (${txId}, ${accountId}, 100)`,
        )
      })
      .catch((e: unknown) => e)

    expect(errorChain(error)).toMatch(/does not sum to zero/)
  })
})
