import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { getDepositAddress } from '@/lib/deposits/addresses'
import { loadTronConfig } from '@/lib/tron/config'
import { formatUsdt } from '@/lib/money/units'
import { DepositAddressPanel } from '@/components/DepositAddressPanel'

export const dynamic = 'force-dynamic'

export default async function DepositPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const config = loadTronConfig()
  const existing = await getDepositAddress(getDb(), user.id)

  return (
    <>
      <h1>Deposit USDT</h1>
      <p>
        Send <strong>USDT-TRC20</strong> on the Tron {config.network} network only. Funds sent on
        any other network or in any other token are unrecoverable.
      </p>
      <p className="estimate">
        Deposits are credited after {config.confirmations} confirmations. Amounts below{' '}
        {formatUsdt(config.sweepMinMicros)} USDT remain at your deposit address until it is
        economical to consolidate them — your balance is credited either way.
      </p>
      <DepositAddressPanel initialAddress={existing?.address ?? null} />
    </>
  )
}
