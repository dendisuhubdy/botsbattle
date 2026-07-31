import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import { currentUser } from '@/lib/http/auth'
import { userBalance } from '@/lib/ledger/accounts'
import { listUserWithdrawals, MIN_WITHDRAWAL_MICROS } from '@/lib/withdrawals/request'
import { TotpEnrolment } from '@/components/TotpEnrolment'
import { WithdrawForm } from '@/components/WithdrawForm'
import { Money } from '@/components/Money'
import { Callout, DataTable, EmptyState, Panel, Stat } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function WithdrawPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const db = getDb()
  const [row] = await db
    .select({ enabled: users.totpEnabled, locked: users.withdrawalLocked })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  const [balance, withdrawals] = await Promise.all([
    userBalance(db, user.id),
    listUserWithdrawals(db, user.id),
  ])

  return (
    <>
      <h1>Withdraw</h1>

      <Stat label="Available">
        <Money micros={balance} />
      </Stat>

      {row.locked ? (
        <Callout tone="danger" title="Withdrawals locked">
          Withdrawals are currently locked on this account. Contact support.
        </Callout>
      ) : row.enabled ? (
        <Panel title="Request a withdrawal">
          <WithdrawForm
            availableMicros={balance.toString()}
            minimumMicros={MIN_WITHDRAWAL_MICROS.toString()}
          />
        </Panel>
      ) : (
        <Panel title="Two-factor required">
          <TotpEnrolment />
        </Panel>
      )}

      <Panel title="History">
        {withdrawals.length === 0 ? (
          <EmptyState>No withdrawals yet.</EmptyState>
        ) : (
          <DataTable headers={['Requested', 'Amount', 'Destination', 'Status', 'Transaction']}>
            {withdrawals.map((w) => (
              <tr key={w.id}>
                <td>{w.requestedAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
                <td>
                  <Money micros={w.amount} />
                </td>
                <td>
                  <span className="mono">{w.address}</span>
                </td>
                <td>
                  {w.status}
                  {w.failureReason ? ` — ${w.failureReason}` : ''}
                </td>
                <td>{w.txHash ? <span className="mono">{w.txHash.slice(0, 16)}…</span> : '—'}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
    </>
  )
}
