import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { bets as betsTable } from '@/lib/db/schema'
import { createFight, publishFight, lockFight, getFight, type Fight } from '@/lib/fights/repo'
import { creditUser } from '@/lib/admin/credit'
import { placeBet } from '@/lib/bets/place'
import { settleFight } from '@/lib/settlement/settle'
import { userBalance, balanceOf, poolAccount, houseAccount } from '@/lib/ledger/accounts'

const HOUR = 60 * 60 * 1000
const USDT = 1_000_000n

describe('settleFight', () => {
  let db: Db
  let admin: string
  let alice: string
  let bob: string
  let fight: Fight

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    alice = await makeUser(db)
    bob = await makeUser(db)
    await creditUser(db, { userId: alice, amount: 100n * USDT, reference: 'a', creditedBy: admin })
    await creditUser(db, { userId: bob, amount: 100n * USDT, reference: 'b', creditedBy: admin })

    fight = await createFight(db, {
      leagueName: 'Robot League',
      fighterA: 'Crusher',
      fighterB: 'Bolt',
      lockAt: new Date(Date.now() + HOUR),
      createdBy: admin,
    })
    await publishFight(db, fight.id)
  })

  async function lockNow() {
    await db.execute(
      sql`UPDATE fights SET lock_at = now() - interval '1 second' WHERE id = ${fight.id}`,
    )
    await lockFight(db, fight.id)
  }

  it('pays winners, takes rake, drains the pool, and marks the fight SETTLED', async () => {
    await placeBet(db, {
      userId: alice,
      fightId: fight.id,
      side: 'A',
      stake: 25n * USDT,
      idempotencyKey: 'a1',
    })
    await placeBet(db, {
      userId: bob,
      fightId: fight.id,
      side: 'B',
      stake: 75n * USDT,
      idempotencyKey: 'b1',
    })
    await lockNow()

    const result = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    expect(result.refunded).toBe(false)
    expect(result.rake).toBe(5n * USDT)
    expect(await userBalance(db, alice)).toBe(75n * USDT + 95n * USDT)
    expect(await userBalance(db, bob)).toBe(25n * USDT)
    expect(await balanceOf(db, await poolAccount(db, fight.id))).toBe(0n)
    expect(await balanceOf(db, await houseAccount(db, 'house_rake'))).toBe(5n * USDT)

    const settled = await getFight(db, fight.id)
    expect(settled.status).toBe('SETTLED')
    expect(settled.outcome).toBe('A')
    expect(settled.settledAt).not.toBeNull()
  })

  it('records the payout on each winning bet and zero on each losing bet', async () => {
    await placeBet(db, {
      userId: alice,
      fightId: fight.id,
      side: 'A',
      stake: 25n * USDT,
      idempotencyKey: 'a1',
    })
    await placeBet(db, {
      userId: bob,
      fightId: fight.id,
      side: 'B',
      stake: 75n * USDT,
      idempotencyKey: 'b1',
    })
    await lockNow()
    await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    const rows = await db.select().from(betsTable).where(eq(betsTable.fightId, fight.id))
    const byKey = new Map(rows.map((r) => [r.idempotencyKey, r.payout]))
    expect(byKey.get('a1')).toBe(95n * USDT)
    expect(byKey.get('b1')).toBe(0n)
  })

  it('refunds everyone and takes no rake on VOID', async () => {
    await placeBet(db, {
      userId: alice,
      fightId: fight.id,
      side: 'A',
      stake: 25n * USDT,
      idempotencyKey: 'a1',
    })
    await placeBet(db, {
      userId: bob,
      fightId: fight.id,
      side: 'B',
      stake: 75n * USDT,
      idempotencyKey: 'b1',
    })
    await lockNow()

    const result = await settleFight(db, { fightId: fight.id, outcome: 'VOID', settledBy: admin })

    expect(result.refunded).toBe(true)
    expect(await userBalance(db, alice)).toBe(100n * USDT)
    expect(await userBalance(db, bob)).toBe(100n * USDT)
    expect(await balanceOf(db, await houseAccount(db, 'house_rake'))).toBe(0n)
    expect((await getFight(db, fight.id)).status).toBe('VOIDED')
  })

  it('voids an OPEN fight without locking it first', async () => {
    await placeBet(db, {
      userId: alice,
      fightId: fight.id,
      side: 'A',
      stake: 10n * USDT,
      idempotencyKey: 'a1',
    })

    await settleFight(db, { fightId: fight.id, outcome: 'VOID', settledBy: admin })

    expect(await userBalance(db, alice)).toBe(100n * USDT)
    expect((await getFight(db, fight.id)).status).toBe('VOIDED')
  })

  it('refunds when every stake was on the winning side', async () => {
    await placeBet(db, {
      userId: alice,
      fightId: fight.id,
      side: 'A',
      stake: 30n * USDT,
      idempotencyKey: 'a1',
    })
    await placeBet(db, {
      userId: bob,
      fightId: fight.id,
      side: 'A',
      stake: 10n * USDT,
      idempotencyKey: 'b1',
    })
    await lockNow()

    const result = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    expect(result.refunded).toBe(true)
    expect(await userBalance(db, alice)).toBe(100n * USDT)
    expect(await userBalance(db, bob)).toBe(100n * USDT)
    expect(await balanceOf(db, await houseAccount(db, 'house_rake'))).toBe(0n)
  })

  it('refunds when nobody backed the winner', async () => {
    await placeBet(db, {
      userId: alice,
      fightId: fight.id,
      side: 'B',
      stake: 30n * USDT,
      idempotencyKey: 'a1',
    })
    await lockNow()

    const result = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    expect(result.refunded).toBe(true)
    expect(await userBalance(db, alice)).toBe(100n * USDT)
  })

  it('settles a fight with no bets at all', async () => {
    await lockNow()
    const result = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })
    expect(result.poolTotal).toBe(0n)
    expect((await getFight(db, fight.id)).status).toBe('SETTLED')
  })

  it('is idempotent: a second settle pays nothing more', async () => {
    await placeBet(db, {
      userId: alice,
      fightId: fight.id,
      side: 'A',
      stake: 25n * USDT,
      idempotencyKey: 'a1',
    })
    await placeBet(db, {
      userId: bob,
      fightId: fight.id,
      side: 'B',
      stake: 75n * USDT,
      idempotencyKey: 'b1',
    })
    await lockNow()

    const first = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })
    const second = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    expect(second.replayed).toBe(true)
    expect(second.payouts).toEqual(first.payouts)
    expect(await userBalance(db, alice)).toBe(170n * USDT)
  })

  it('is idempotent under two concurrent settle calls', async () => {
    await placeBet(db, {
      userId: alice,
      fightId: fight.id,
      side: 'A',
      stake: 25n * USDT,
      idempotencyKey: 'a1',
    })
    await placeBet(db, {
      userId: bob,
      fightId: fight.id,
      side: 'B',
      stake: 75n * USDT,
      idempotencyKey: 'b1',
    })
    await lockNow()

    const both = await Promise.allSettled([
      settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin }),
      settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin }),
    ])

    expect(both.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    expect(await userBalance(db, alice)).toBe(170n * USDT)
    expect(await balanceOf(db, await poolAccount(db, fight.id))).toBe(0n)
  })

  it('refuses to settle an OPEN fight with a real outcome', async () => {
    await expect(
      settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin }),
    ).rejects.toMatchObject({ code: 'NOT_SETTLEABLE' })
  })

  it('refuses to settle a DRAFT fight', async () => {
    const draft = await createFight(db, {
      leagueName: 'L',
      fighterA: 'A',
      fighterB: 'B',
      lockAt: new Date(Date.now() + HOUR),
      createdBy: admin,
    })
    await expect(
      settleFight(db, { fightId: draft.id, outcome: 'VOID', settledBy: admin }),
    ).rejects.toMatchObject({ code: 'NOT_SETTLEABLE' })
  })

  it('refuses an unknown fight', async () => {
    await expect(
      settleFight(db, {
        fightId: '00000000-0000-0000-0000-000000000000',
        outcome: 'VOID',
        settledBy: admin,
      }),
    ).rejects.toMatchObject({ code: 'FIGHT_NOT_FOUND' })
  })

  it('leaves the ledger balanced across the whole lifecycle', async () => {
    await placeBet(db, {
      userId: alice,
      fightId: fight.id,
      side: 'A',
      stake: 33n * USDT,
      idempotencyKey: 'a1',
    })
    await placeBet(db, {
      userId: bob,
      fightId: fight.id,
      side: 'B',
      stake: 67n * USDT,
      idempotencyKey: 'b1',
    })
    await lockNow()
    await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    const unbalanced = await db.execute<{ tx_id: string }>(sql`
      SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0
    `)
    expect(unbalanced.rows).toEqual([])

    const grandTotal = await db.execute<{ total: string }>(
      sql`SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries`,
    )
    expect(BigInt(grandTotal.rows[0].total)).toBe(0n)
  })
})
