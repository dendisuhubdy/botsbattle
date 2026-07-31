import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { getFight, poolTotals, FightError } from '@/lib/fights/repo'
import { FightAdminControls } from '@/components/FightAdminControls'
import { Money } from '@/components/Money'
import { Panel, Stat } from '@/components/ui'

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

      <Panel title="Fight details">
        <Stat label="Status">
          {fight.status}
          {fight.outcome ? ` (${fight.outcome})` : ''}
        </Stat>
        <Stat label="Locks at">{fight.lockAt.toISOString()}</Stat>
        <Stat label="Rake">{(fight.rakeBps / 100).toFixed(2)}%</Stat>
        <Stat label="Pool">
          <Money micros={totals.total} /> (A <Money micros={totals.a} />, B{' '}
          <Money micros={totals.b} />)
        </Stat>
      </Panel>

      <FightAdminControls
        fightId={fight.id}
        status={fight.status}
        fighterA={fight.fighterA}
        fighterB={fight.fighterB}
      />
    </>
  )
}
