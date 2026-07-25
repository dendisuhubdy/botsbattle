import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/http/auth'
import { getDb } from '@/lib/db/client'
import { listFights, lockDueFights, poolTotals, estimatedPayoutPerUsdt } from '@/lib/fights/repo'
import { Money, Multiplier } from '@/components/Money'
import styles from './page.module.css'

export const dynamic = 'force-dynamic'

function ArenaMark() {
  return (
    <svg
      className={styles.heroArt}
      viewBox="0 0 400 400"
      role="img"
      aria-label="Stylised diagram of an octagonal fight arena with a robot emblem at its centre"
    >
      <polygon
        points="200,20 320,80 360,200 320,320 200,380 80,320 40,200 80,80"
        fill="none"
        stroke="#232327"
        strokeWidth="2"
      />
      <polygon
        points="200,60 296,108 328,200 296,292 200,340 104,292 72,200 104,108"
        fill="none"
        stroke="#f4c518"
        strokeWidth="1.5"
        strokeDasharray="6 10"
      />
      {/* red corner */}
      <path d="M40,200 L80,80 L120,110 Z" fill="#e2402c" opacity="0.85" />
      {/* yellow corner */}
      <path d="M360,200 L320,320 L280,290 Z" fill="#f4c518" opacity="0.9" />
      {/* robot head emblem, centred */}
      <g transform="translate(200,200)">
        <rect x="-60" y="-50" width="120" height="90" rx="10" fill="#131316" stroke="#f3efe6" strokeWidth="3" />
        <rect x="-38" y="-28" width="34" height="20" rx="3" fill="#f4c518" />
        <rect x="4" y="-28" width="34" height="20" rx="3" fill="#e2402c" />
        <rect x="-30" y="12" width="60" height="8" rx="4" fill="#f3efe6" />
        <line x1="-60" y1="-10" x2="-84" y2="-10" stroke="#f3efe6" strokeWidth="3" />
        <line x1="60" y1="-10" x2="84" y2="-10" stroke="#f3efe6" strokeWidth="3" />
        <circle cx="-84" cy="-10" r="7" fill="#e2402c" />
        <circle cx="84" cy="-10" r="7" fill="#f4c518" />
      </g>
    </svg>
  )
}

export default async function LandingPage() {
  const user = await currentUser()
  if (user) redirect('/fights')

  const db = getDb()
  await lockDueFights(db)

  const openFights = await listFights(db, ['OPEN'])
  const featured = await Promise.all(
    openFights.map(async (fight) => {
      const totals = await poolTotals(db, fight.id)
      return { fight, totals, estimated: estimatedPayoutPerUsdt(totals, fight.rakeBps) }
    }),
  )

  const totalPoolMicros = featured.reduce((sum, row) => sum + row.totals.total, 0n)
  const openCount = featured.length

  return (
    <div className={styles.landing}>
      <div className={styles.tape} />

      <section className={styles.hero}>
        <div>
          <span className={styles.kicker}>Live pari-mutuel betting · Robot MMA</span>
          <h1 className={styles.title}>
            Back your bot. <span className={styles.titleAccent}>Split the pool.</span>
          </h1>
          <p className={styles.lede}>
            botsfight.com runs pari-mutuel betting on combat robot fights. Every stake on a fight
            goes into one pool; the house takes a fixed 5% rake and never takes the other side of
            your bet. Everyone who backed the winner splits what&apos;s left, in proportion to
            their stake. Settled in <strong>USDT on Tron</strong>.
          </p>
          <div className={styles.ctaRow}>
            <Link href="/signup" className={`${styles.btn} ${styles.btnPrimary}`}>
              Create account
            </Link>
            <Link href="/fights" className={`${styles.btn} ${styles.btnGhost}`}>
              Browse open fights
            </Link>
          </div>
        </div>
        <ArenaMark />
      </section>

      <section className={styles.stats} aria-label="Current platform activity">
        <div className={styles.statTile}>
          <span className={`${styles.statValue} ${styles.mono}`}>{openCount}</span>
          <span className={styles.statLabel}>
            {openCount === 1 ? 'Fight open now' : 'Fights open now'}
          </span>
        </div>
        <div className={styles.statTile}>
          <span className={`${styles.statValue} ${styles.mono}`}>
            <Money micros={totalPoolMicros} />
          </span>
          <span className={styles.statLabel}>Pooled in open fights</span>
        </div>
        <div className={styles.statTile}>
          <span className={`${styles.statValue} ${styles.mono}`}>5%</span>
          <span className={styles.statLabel}>Default house rake</span>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="fights-heading">
        <div className={styles.sectionHead}>
          <h2 id="fights-heading" className={styles.sectionTitle}>
            Open right now
          </h2>
          <p className={styles.sectionNote}>
            Multipliers are live estimates from the current pool — they move as more bets come in
            and are not fixed until betting locks.
          </p>
        </div>

        {featured.length === 0 ? (
          <div className={styles.emptyState}>
            <p>
              <strong>No fights are open right now.</strong> New cards are scheduled regularly —
              check{' '}
              <Link href="/fights" className={styles.mono}>
                /fights
              </Link>{' '}
              shortly, or create an account so you&apos;re ready to bet the moment one opens.
            </p>
          </div>
        ) : (
          <div className={styles.fightGrid}>
            {featured.map(({ fight, totals, estimated }) => (
              <Link key={fight.id} href={`/fights/${fight.id}`} className={styles.fightCard}>
                <span className={styles.liveBadge}>
                  <span className={styles.liveDot} aria-hidden="true" />
                  Open
                </span>
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
                    <dt>Locks</dt>
                    <dd>{fight.lockAt.toISOString().replace('T', ' ').slice(0, 16)} UTC</dd>
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
      </section>

      <section className={styles.section} aria-labelledby="how-heading">
        <div className={styles.sectionHead}>
          <h2 id="how-heading" className={styles.sectionTitle}>
            How the pool works
          </h2>
        </div>
        <div className={styles.steps}>
          <div className={styles.step}>
            <h3>Pick a side, set a stake</h3>
            <p>Every open fight has two sides. Stake USDT on the one you think wins.</p>
          </div>
          <div className={styles.step}>
            <h3>Stakes combine into one pool</h3>
            <p>
              Your stake joins everyone else&apos;s on both sides. There is no bookmaker odds-setter
              on the other side of your bet — you&apos;re betting against other bettors, not the
              house.
            </p>
          </div>
          <div className={styles.step}>
            <h3>The house takes its rake</h3>
            <p>
              A fixed rake — 5% by default — is taken from the total pool once the fight is
              settled. It never changes based on who wins.
            </p>
          </div>
          <div className={styles.step}>
            <h3>Winners split what&apos;s left</h3>
            <p>
              Everyone who backed the winning side splits the remaining pool in proportion to
              their stake. Displayed multipliers are estimates and move until the fight locks.
            </p>
          </div>
        </div>
        <p className={styles.rakeStrip}>
          <strong>Note:</strong> if one side of a fight gets zero bets, or a fight is voided,
          stakes are refunded at face value — the house takes no rake on a refund.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="funding-heading">
        <div className={styles.sectionHead}>
          <h2 id="funding-heading" className={styles.sectionTitle}>
            Deposits &amp; withdrawals
          </h2>
        </div>
        <div className={styles.fundingGrid}>
          <div className={styles.fundingCard}>
            <h3>USDT-TRC20 on Tron, only</h3>
            <p>
              Deposit by sending <code>USDT-TRC20</code> on the Tron network to your account
              address. Funds sent on any other network or in any other token cannot be recovered.
            </p>
          </div>
          <div className={styles.fundingCard}>
            <h3>Credited after 19 confirmations</h3>
            <p>
              Your balance updates automatically once your deposit reaches 19 confirmations on
              chain — no support ticket needed.
            </p>
          </div>
          <div className={styles.fundingCard}>
            <h3>Withdrawals are reviewed by a person</h3>
            <p>
              Withdrawal requests go through TOTP confirmation and a human review before anything
              is broadcast. This adds friction on purpose, to protect your funds.
            </p>
          </div>
        </div>
      </section>

      <section className={styles.notice} aria-labelledby="risk-heading">
        <div className={styles.noticeInner}>
          <h2 id="risk-heading" className={styles.noticeTitle}>
            Before you bet
          </h2>
          <ul className={styles.noticeList}>
            <li>This is real-money betting. You can lose the full amount you stake.</li>
            <li>You must be 18 or older to hold an account or place a bet.</li>
            <li>
              Availability depends on your local laws. It is your responsibility to confirm that
              betting on this platform is legal where you live before you deposit.
            </li>
            <li>
              Nothing on this page is investment advice. Pool multipliers are not a return on
              investment — they are what other bettors are staking, minus rake.
            </li>
            <li>
              Payout estimates move with the pool and are not fixed until the fight locks — no
              outcome or return here is assured.
            </li>
          </ul>
          <p className={styles.responsible}>
            Betting should stay entertainment, not a way to make money. Set a limit before you
            start, only stake what you can afford to lose, and stop if it stops being fun.
          </p>
        </div>
      </section>

      <section className={styles.finalCta}>
        <h2>Ready to back a bot?</h2>
        <div className={styles.ctaRow}>
          <Link href="/signup" className={`${styles.btn} ${styles.btnPrimary}`}>
            Create account
          </Link>
          <Link href="/fights" className={`${styles.btn} ${styles.btnGhost}`}>
            Browse open fights
          </Link>
        </div>
      </section>
    </div>
  )
}
