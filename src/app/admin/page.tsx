import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { listFights, poolTotals } from '@/lib/fights/repo'
import { CreateFightForm } from '@/components/CreateFightForm'
import { CreditForm } from '@/components/CreditForm'
import { Money } from '@/components/Money'
import { DataTable, EmptyState, Panel } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const user = await currentUser()
  if (!user?.isAdmin) notFound()

  const db = getDb()
  const fights = await listFights(db, ['DRAFT', 'OPEN', 'LOCKED', 'SETTLED', 'VOIDED'])
  const rows = await Promise.all(
    fights.map(async (fight) => ({ fight, totals: await poolTotals(db, fight.id) })),
  )
  const users = await db.execute<{ id: string; email: string }>(
    sql`SELECT id, email FROM users ORDER BY created_at DESC`,
  )

  return (
    <>
      <h1>Admin</h1>
      <p>
        <Link href="/admin/withdrawals">Withdrawal queue</Link>
      </p>

      <Panel title="New fight">
        <CreateFightForm />
      </Panel>

      <Panel title="Credit a balance">
        <CreditForm users={users.rows} />
      </Panel>

      <Panel title="Fights">
        {rows.length === 0 ? (
          <EmptyState>No fights yet.</EmptyState>
        ) : (
          <DataTable headers={['Fight', 'Status', 'Pool']}>
            {rows.map(({ fight, totals }) => (
              <tr key={fight.id}>
                <td>
                  <Link href={`/admin/fights/${fight.id}`}>
                    {fight.fighterA} vs {fight.fighterB}
                  </Link>
                </td>
                <td>
                  {fight.status}
                  {fight.outcome ? ` (${fight.outcome})` : ''}
                </td>
                <td>
                  <Money micros={totals.total} />
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
    </>
  )
}
