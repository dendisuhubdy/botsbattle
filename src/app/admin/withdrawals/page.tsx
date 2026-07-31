import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { listPendingWithdrawals } from '@/lib/withdrawals/review'
import { WithdrawalReviewControls } from '@/components/WithdrawalReviewControls'
import { formatUsdt } from '@/lib/money/units'
import { DataTable, EmptyState } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function AdminWithdrawalsPage() {
  const user = await currentUser()
  if (!user?.isAdmin) notFound()

  const pending = await listPendingWithdrawals(getDb())

  return (
    <>
      <h1>Withdrawal queue</h1>
      {pending.length === 0 ? (
        <EmptyState>Nothing awaiting review.</EmptyState>
      ) : (
        <DataTable headers={['Requested by', 'Requested at', 'Amount', 'Destination', 'Review']}>
          {pending.map((w) => (
            <tr key={w.id}>
              <td>{w.email}</td>
              <td>{w.requestedAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
              <td className="mono">{formatUsdt(w.amount)} USDT</td>
              <td className="mono">{w.address}</td>
              <td>
                <WithdrawalReviewControls
                  requestId={w.id}
                  address={w.address}
                  amountLabel={`${formatUsdt(w.amount)} USDT`}
                />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  )
}
