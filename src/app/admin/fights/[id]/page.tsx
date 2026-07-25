import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { getFight, poolTotals, FightError } from '@/lib/fights/repo'
import { FightAdminControls } from '@/components/FightAdminControls'
import { Money } from '@/components/Money'

export const dynamic = 'force-dynamic'

export default async function AdminFightPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user?.isAdmin) notFound()

  const { id } = await params
  const db = getDb()

  const fight = await getFight(db, id).catch((err) => {
    if (err instanceof FightError && err.code === 'NOT_FOUND') notFound()
    throw err
  })
  const totals = await poolTotals(db, id)

  return (
    <>
      <h1>
        {fight.fighterA} vs {fight.fighterB}
      </h1>
      <table>
        <tbody>
          <tr>
            <th>Status</th>
            <td>
              {fight.status}
              {fight.outcome ? ` (${fight.outcome})` : ''}
            </td>
          </tr>
          <tr>
            <th>Locks at</th>
            <td>{fight.lockAt.toISOString()}</td>
          </tr>
          <tr>
            <th>Rake</th>
            <td>{(fight.rakeBps / 100).toFixed(2)}%</td>
          </tr>
          <tr>
            <th>Pool</th>
            <td>
              <Money micros={totals.total} /> (A <Money micros={totals.a} />, B{' '}
              <Money micros={totals.b} />)
            </td>
          </tr>
        </tbody>
      </table>

      <FightAdminControls
        fightId={fight.id}
        status={fight.status}
        fighterA={fight.fighterA}
        fighterB={fight.fighterB}
      />
    </>
  )
}
