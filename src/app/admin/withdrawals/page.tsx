import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { listPendingWithdrawals } from '@/lib/withdrawals/review'
import { WithdrawalReviewControls } from '@/components/WithdrawalReviewControls'
import { formatUsdt } from '@/lib/money/units'

export const dynamic = 'force-dynamic'

export default async function AdminWithdrawalsPage() {
  const user = await currentUser()
  if (!user?.isAdmin) notFound()

  const pending = await listPendingWithdrawals(getDb())

  return (
    <>
      <h1>Withdrawal queue</h1>
      {pending.length === 0 ? (
        <p>Nothing awaiting review.</p>
      ) : (
        pending.map((w) => (
          <div key={w.id}>
            <p>
              {w.email} · requested {w.requestedAt.toISOString().replace('T', ' ').slice(0, 16)}
            </p>
            <WithdrawalReviewControls
              requestId={w.id}
              address={w.address}
              amountLabel={`${formatUsdt(w.amount)} USDT`}
            />
          </div>
        ))
      )}
    </>
  )
}
