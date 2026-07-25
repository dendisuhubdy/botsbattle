import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { handle, ok } from '@/lib/http/respond'
import { requireAdmin } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    await requireAdmin()

    const rows = await getDb().execute<{ id: string; email: string; balance: string }>(sql`
      SELECT u.id,
             u.email,
             COALESCE(SUM(le.amount), 0)::text AS balance
      FROM users u
      LEFT JOIN accounts a
        ON a.user_id = u.id AND a.kind = 'user_available'
      LEFT JOIN ledger_entries le
        ON le.account_id = a.id
      GROUP BY u.id, u.email, u.created_at
      ORDER BY u.created_at DESC
    `)

    return ok({ users: rows.rows.map((r) => ({ ...r, balance: BigInt(r.balance) })) })
  })
}
