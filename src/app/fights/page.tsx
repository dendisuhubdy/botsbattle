import Link from 'next/link'
import { getDb } from '@/lib/db/client'
import { listFights, lockDueFights, poolTotals, estimatedPayoutPerUsdt } from '@/lib/fights/repo'
import { Money, Multiplier } from '@/components/Money'
import { EmptyState } from '@/components/ui'
import styles from './fights.module.css'

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

  return (
    <>
      <h1>Fights</h1>

      {rows.length === 0 ? (
        <EmptyState>No fights are open right now.</EmptyState>
      ) : (
        <div className={styles.fightGrid}>
          {rows.map(({ fight, totals, estimated }) => (
            <Link key={fight.id} href={`/fights/${fight.id}`} className={styles.fightCard}>
              {fight.status === 'OPEN' && (
                <span className={styles.liveBadge}>
                  <span className={styles.liveDot} aria-hidden="true" />
                  Open
                </span>
              )}
              <span className={styles.fightLeague}>{fight.leagueName}</span>
              <h3 className={styles.fightNames}>
                {fight.fighterA} <span aria-hidden="true">vs</span> {fight.fighterB}
              </h3>
              <dl className={styles.fightMeta}>
                <div>
                  <dt>Pool</dt>
                  <dd>
                    <Money micros={totals.total} />
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    {fight.status}
                    {fight.outcome ? ` (${fight.outcome})` : ''}
                  </dd>
                </div>
                <div>
                  <dt>Locks</dt>
                  <dd>{fight.lockAt.toISOString().replace('T', ' ').slice(0, 16)}</dd>
                </div>
                <div>
                  <dt>Est. {fight.fighterA}</dt>
                  <dd>
                    <Multiplier micros={estimated.a} />
                  </dd>
                </div>
                <div>
                  <dt>Est. {fight.fighterB}</dt>
                  <dd>
                    <Multiplier micros={estimated.b} />
                  </dd>
                </div>
              </dl>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
