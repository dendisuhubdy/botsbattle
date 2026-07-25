import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import { makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import {
  createFight,
  getFight,
  publishFight,
  lockFight,
  lockDueFights,
  listFights,
  poolTotals,
  estimatedPayoutPerUsdt,
  FightError,
} from '@/lib/fights/repo'

const HOUR = 60 * 60 * 1000

describe('fights repo', () => {
  let db: Db
  let admin: string

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
  })

  const base = () => ({
    leagueName: 'Robot League',
    fighterA: 'Crusher',
    fighterB: 'Bolt',
    streamEmbedUrl: 'https://player.twitch.tv/?channel=example',
    lockAt: new Date(Date.now() + HOUR),
    createdBy: admin,
  })

  it('creates a fight in DRAFT with the default rake', async () => {
    const fight = await createFight(db, base())
    expect(fight.status).toBe('DRAFT')
    expect(fight.rakeBps).toBe(500)
    expect(fight.outcome).toBeNull()
  })

  it('accepts a per-fight rake override', async () => {
    const fight = await createFight(db, { ...base(), rakeBps: 250 })
    expect(fight.rakeBps).toBe(250)
  })

  it('rejects a rake outside 0..2000 bps', async () => {
    await expect(createFight(db, { ...base(), rakeBps: 2001 })).rejects.toMatchObject({
      code: 'INVALID_RAKE',
    })
    await expect(createFight(db, { ...base(), rakeBps: -1 })).rejects.toMatchObject({
      code: 'INVALID_RAKE',
    })
  })

  it('rejects a lock time in the past', async () => {
    await expect(
      createFight(db, { ...base(), lockAt: new Date(Date.now() - HOUR) }),
    ).rejects.toMatchObject({ code: 'LOCK_IN_PAST' })
  })

  it('walks DRAFT -> OPEN -> LOCKED', async () => {
    const fight = await createFight(db, base())
    expect((await publishFight(db, fight.id)).status).toBe('OPEN')
    expect((await lockFight(db, fight.id)).status).toBe('LOCKED')
  })

  it('refuses illegal transitions', async () => {
    const fight = await createFight(db, base())
    await expect(lockFight(db, fight.id)).rejects.toMatchObject({ code: 'BAD_TRANSITION' })

    await publishFight(db, fight.id)
    await expect(publishFight(db, fight.id)).rejects.toMatchObject({ code: 'BAD_TRANSITION' })
  })

  it('throws NOT_FOUND for an unknown fight', async () => {
    await expect(getFight(db, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      FightError,
    )
  })

  it('lockDueFights locks only OPEN fights past their lock time', async () => {
    const due = await createFight(db, base())
    const notDue = await createFight(db, { ...base(), lockAt: new Date(Date.now() + 5 * HOUR) })
    const stillDraft = await createFight(db, base())

    await publishFight(db, due.id)
    await publishFight(db, notDue.id)
    await db.execute(
      sql`UPDATE fights SET lock_at = now() - interval '1 minute' WHERE id = ${due.id}`,
    )

    expect(await lockDueFights(db)).toBe(1)
    expect((await getFight(db, due.id)).status).toBe('LOCKED')
    expect((await getFight(db, notDue.id)).status).toBe('OPEN')
    expect((await getFight(db, stillDraft.id)).status).toBe('DRAFT')
  })

  it('lists fights filtered by status', async () => {
    const open = await createFight(db, base())
    await createFight(db, base())
    await publishFight(db, open.id)

    const listed = await listFights(db, ['OPEN'])
    expect(listed.map((f) => f.id)).toEqual([open.id])
  })

  it('reports zero pool totals for a fight with no bets', async () => {
    const fight = await createFight(db, base())
    expect(await poolTotals(db, fight.id)).toEqual({ total: 0n, a: 0n, b: 0n })
  })
})

describe('estimatedPayoutPerUsdt', () => {
  it('returns null for a side with no stake', () => {
    const odds = estimatedPayoutPerUsdt({ total: 100_000_000n, a: 100_000_000n, b: 0n }, 500)
    expect(odds.b).toBeNull()
  })

  it('divides the distributable pool across the backing side', () => {
    // 100 USDT total, 25 on A, 5% rake -> distributable 95 -> 3.8 USDT per USDT on A
    const odds = estimatedPayoutPerUsdt(
      { total: 100_000_000n, a: 25_000_000n, b: 75_000_000n },
      500,
    )
    expect(odds.a).toBe(3_800_000n)
  })

  it('returns face value when all stake is on one side', () => {
    // Everyone on A means a refund at settlement, so the estimate must show 1.00x, not 0.95x.
    const odds = estimatedPayoutPerUsdt({ total: 40_000_000n, a: 40_000_000n, b: 0n }, 500)
    expect(odds.a).toBe(1_000_000n)
  })
})
