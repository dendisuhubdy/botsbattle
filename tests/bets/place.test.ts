import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { createFight, publishFight, poolTotals, type Fight } from '@/lib/fights/repo'
import { creditUser } from '@/lib/admin/credit'
import { placeBet, listUserBets } from '@/lib/bets/place'
import { userBalance, balanceOf, poolAccount } from '@/lib/ledger/accounts'

const HOUR = 60 * 60 * 1000
const USDT = 1_000_000n

describe('placeBet', () => {
  let db: Db
  let user: string
  let admin: string
  let fight: Fight

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })
    fight = await createFight(db, {
      leagueName: 'Robot League',
      fighterA: 'Crusher',
      fighterB: 'Bolt',
      lockAt: new Date(Date.now() + HOUR),
      createdBy: admin,
    })
    await publishFight(db, fight.id)
  })

  it('moves stake from the user to the pool', async () => {
    await placeBet(db, {
      userId: user,
      fightId: fight.id,
      side: 'A',
      stake: 25n * USDT,
      idempotencyKey: 'b1',
    })

    expect(await userBalance(db, user)).toBe(75n * USDT)
    expect(await balanceOf(db, await poolAccount(db, fight.id))).toBe(25n * USDT)
    expect(await poolTotals(db, fight.id)).toEqual({ total: 25n * USDT, a: 25n * USDT, b: 0n })
  })

  it('is idempotent on the client key', async () => {
    const first = await placeBet(db, {
      userId: user,
      fightId: fight.id,
      side: 'A',
      stake: 10n * USDT,
      idempotencyKey: 'same',
    })
    const second = await placeBet(db, {
      userId: user,
      fightId: fight.id,
      side: 'A',
      stake: 10n * USDT,
      idempotencyKey: 'same',
    })

    expect(second.replayed).toBe(true)
    expect(second.betId).toBe(first.betId)
    expect(await userBalance(db, user)).toBe(90n * USDT)
  })

  it('rejects a stake below the 1 USDT minimum', async () => {
    await expect(
      placeBet(db, {
        userId: user,
        fightId: fight.id,
        side: 'A',
        stake: 999_999n,
        idempotencyKey: 'small',
      }),
    ).rejects.toMatchObject({ code: 'STAKE_BELOW_MINIMUM' })
    expect(await userBalance(db, user)).toBe(100n * USDT)
  })

  it('rejects a stake larger than the balance', async () => {
    await expect(
      placeBet(db, {
        userId: user,
        fightId: fight.id,
        side: 'B',
        stake: 101n * USDT,
        idempotencyKey: 'big',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' })
    expect(await userBalance(db, user)).toBe(100n * USDT)
  })

  it('rejects a bet on a DRAFT fight', async () => {
    const draft = await createFight(db, {
      leagueName: 'L',
      fighterA: 'A',
      fighterB: 'B',
      lockAt: new Date(Date.now() + HOUR),
      createdBy: admin,
    })
    await expect(
      placeBet(db, {
        userId: user,
        fightId: draft.id,
        side: 'A',
        stake: 5n * USDT,
        idempotencyKey: 'draft',
      }),
    ).rejects.toMatchObject({ code: 'FIGHT_NOT_OPEN' })
  })

  it('rejects a bet once lock_at has passed, even while status is still OPEN', async () => {
    await db.execute(
      sql`UPDATE fights SET lock_at = now() - interval '1 second' WHERE id = ${fight.id}`,
    )

    await expect(
      placeBet(db, {
        userId: user,
        fightId: fight.id,
        side: 'A',
        stake: 5n * USDT,
        idempotencyKey: 'late',
      }),
    ).rejects.toMatchObject({ code: 'FIGHT_LOCKED' })
    expect(await userBalance(db, user)).toBe(100n * USDT)
  })

  it('rejects a bet on an unknown fight', async () => {
    await expect(
      placeBet(db, {
        userId: user,
        fightId: '00000000-0000-0000-0000-000000000000',
        side: 'A',
        stake: 5n * USDT,
        idempotencyKey: 'ghost',
      }),
    ).rejects.toMatchObject({ code: 'FIGHT_NOT_FOUND' })
  })

  it('never overdrafts under concurrent bets', async () => {
    // 100 USDT of balance, 20 concurrent attempts at 10 USDT: exactly 10 may succeed.
    const attempts = Array.from({ length: 20 }, (_, i) =>
      placeBet(db, {
        userId: user,
        fightId: fight.id,
        side: i % 2 === 0 ? 'A' : 'B',
        stake: 10n * USDT,
        idempotencyKey: `race-${i}`,
      }).then(
        () => 'ok' as const,
        () => 'rejected' as const,
      ),
    )

    const results = await Promise.all(attempts)
    expect(results.filter((r) => r === 'ok')).toHaveLength(10)
    expect(await userBalance(db, user)).toBe(0n)
    expect((await poolTotals(db, fight.id)).total).toBe(100n * USDT)
  })

  it("lists a user's bets with fight context", async () => {
    await placeBet(db, {
      userId: user,
      fightId: fight.id,
      side: 'B',
      stake: 3n * USDT,
      idempotencyKey: 'hist',
    })
    const listed = await listUserBets(db, user)

    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      fightId: fight.id,
      side: 'B',
      stake: 3n * USDT,
      payout: null,
      fightStatus: 'OPEN',
      fighterA: 'Crusher',
    })
  })
})
