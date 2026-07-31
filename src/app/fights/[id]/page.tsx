import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getDb } from '@/lib/db/client'
import {
  getFight,
  lockDueFights,
  poolTotals,
  estimatedPayoutPerUsdt,
  FightError,
} from '@/lib/fights/repo'
import { BetForm, type FightView } from '@/components/BetForm'
import { currentUser } from '@/lib/http/auth'
import { Money, Multiplier } from '@/components/Money'
import { Panel, Stat } from '@/components/ui'
import styles from '../fights.module.css'

export const dynamic = 'force-dynamic'

export default async function FightPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getDb()
  await lockDueFights(db)

  const fight = await getFight(db, id).catch((err) => {
    if (err instanceof FightError && err.code === 'NOT_FOUND') notFound()
    throw err
  })

  if (fight.status === 'DRAFT') notFound()

  const totals = await poolTotals(db, id)
  const estimated = estimatedPayoutPerUsdt(totals, fight.rakeBps)
  const user = await currentUser()

  const initial: FightView = {
    fight: {
      id: fight.id,
      fighterA: fight.fighterA,
      fighterB: fight.fighterB,
      status: fight.status,
      outcome: fight.outcome,
    },
    totals: { total: totals.total.toString(), a: totals.a.toString(), b: totals.b.toString() },
    estimated: {
      a: estimated.a === null ? null : estimated.a.toString(),
      b: estimated.b === null ? null : estimated.b.toString(),
    },
  }

  return (
    <>
      <h1>
        {fight.fighterA} vs {fight.fighterB}
      </h1>
      <p>
        {fight.leagueName} · rake {(fight.rakeBps / 100).toFixed(2)}%
      </p>

      <div className={styles.statRow}>
        <Stat label="Pool">
          <Money micros={totals.total} />
        </Stat>
        <Stat label={`Est. ${fight.fighterA}`}>
          <Multiplier micros={estimated.a} />
        </Stat>
        <Stat label={`Est. ${fight.fighterB}`}>
          <Multiplier micros={estimated.b} />
        </Stat>
      </div>

      {fight.streamEmbedUrl && (
        <iframe
          src={fight.streamEmbedUrl}
          title="Live stream"
          width="640"
          height="360"
          allowFullScreen
        />
      )}

      <Panel title="Place a bet">
        {user ? (
          <BetForm fightId={fight.id} initial={initial} />
        ) : (
          <p>
            <Link href="/login">Log in</Link> to place a bet.
          </p>
        )}
      </Panel>
    </>
  )
}
