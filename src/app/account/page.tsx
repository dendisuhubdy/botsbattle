import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { userBalance } from '@/lib/ledger/accounts'
import { listUserBets } from '@/lib/bets/place'
import { Money } from '@/components/Money'

export const dynamic = 'force-dynamic'

export default async function AccountPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const db = getDb()
  const [balance, bets] = await Promise.all([userBalance(db, user.id), listUserBets(db, user.id)])

  return (
    <>
      <h1>Account</h1>
      <p>
        Balance: <Money micros={balance} />
      </p>

      <h2>Bets</h2>
      {bets.length === 0 ? (
        <p>No bets yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Fight</th>
              <th>Side</th>
              <th>Stake</th>
              <th>Status</th>
              <th>Payout</th>
            </tr>
          </thead>
          <tbody>
            {bets.map((bet) => (
              <tr key={bet.id}>
                <td>
                  <Link href={`/fights/${bet.fightId}`}>
                    {bet.fighterA} vs {bet.fighterB}
                  </Link>
                </td>
                <td>{bet.side}</td>
                <td>
                  <Money micros={bet.stake} />
                </td>
                <td>
                  {bet.fightStatus}
                  {bet.outcome ? ` (${bet.outcome})` : ''}
                </td>
                <td>
                  <Money micros={bet.payout} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
