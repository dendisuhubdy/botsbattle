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

      {row.locked ? (
        <p className="error">
          Withdrawals are currently locked on this account. Contact support.
        </p>
      ) : row.enabled ? (
        <WithdrawForm
          availableMicros={balance.toString()}
          minimumMicros={MIN_WITHDRAWAL_MICROS.toString()}
        />
      ) : (
        <TotpEnrolment />
      )}

      <h2>History</h2>
      {withdrawals.length === 0 ? (
        <p>No withdrawals yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Requested</th>
              <th>Amount</th>
              <th>Destination</th>
              <th>Status</th>
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {withdrawals.map((w) => (
              <tr key={w.id}>
                <td>{w.requestedAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
                <td>
                  <Money micros={w.amount} />
                </td>
                <td>
                  <code>{w.address}</code>
                </td>
                <td>
                  {w.status}
                  {w.failureReason ? ` — ${w.failureReason}` : ''}
                </td>
                <td>{w.txHash ? <code>{w.txHash.slice(0, 16)}…</code> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
