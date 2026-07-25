import Link from 'next/link'
import { getDb } from '@/lib/db/client'
import { listFights, lockDueFights, poolTotals, estimatedPayoutPerUsdt } from '@/lib/fights/repo'
import { Money, Multiplier } from '@/components/Money'

export const dynamic = 'force-dynamic'

export default async function FightsPage() {
  const db = getDb()
  await lockDueFights(db)

  const fights = await listFights(db, ['OPEN', 'LOCKED', 'SETTLED', 'VOIDED'])
  const rows = await Promise.all(
    fights.map(async (fight) => {
      const totals = await poolTotals(db, fight.id)
      return { fight, totals, estimated: estimatedPayoutPerUsdt(totals, fight.rakeBps) }
    }),
  )

  if (!rows.length) return <p>No fights are open right now.</p>

  return (
    <table>
      <thead>
        <tr>
          <th>Fight</th>
          <th>Status</th>
          <th>Pool</th>
          <th>Est. A</th>
          <th>Est. B</th>
          <th>Locks</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ fight, totals, estimated }) => (
          <tr key={fight.id}>
            <td>
              <Link href={`/fights/${fight.id}`}>
                {fight.fighterA} vs {fight.fighterB}
              </Link>
              <div className="estimate">{fight.leagueName}</div>
            </td>
            <td>
              {fight.status}
              {fight.outcome ? ` (${fight.outcome})` : ''}
            </td>
            <td>
              <Money micros={totals.total} />
            </td>
            <td>
              <Multiplier micros={estimated.a} />
            </td>
            <td>
              <Multiplier micros={estimated.b} />
            </td>
            <td>{fight.lockAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
