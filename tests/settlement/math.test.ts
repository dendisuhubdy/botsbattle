import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { computeSettlement, type SettlementBet } from '@/lib/settlement/math'
import type { Outcome, Side } from '@/lib/fights/repo'

const USDT = 1_000_000n
const bet = (id: string, side: Side, stake: bigint): SettlementBet => ({ id, side, stake })

describe('computeSettlement — worked examples', () => {
  it('splits the distributable pool in proportion to winning stake', () => {
    // 100 USDT pool: 25 on A (winner), 75 on B. 5% rake -> 95 distributable.
    const result = computeSettlement({
      outcome: 'A',
      rakeBps: 500,
      bets: [bet('a1', 'A', 10n * USDT), bet('a2', 'A', 15n * USDT), bet('b1', 'B', 75n * USDT)],
    })

    expect(result.refunded).toBe(false)
    expect(result.poolTotal).toBe(100n * USDT)
    expect(result.winningPool).toBe(25n * USDT)
    expect(result.rake).toBe(5n * USDT)
    expect(result.payouts).toEqual([
      { betId: 'a1', amount: 38n * USDT },
      { betId: 'a2', amount: 57n * USDT },
    ])
    expect(result.dust).toBe(0n)
  })

  it('sends integer-division remainder to dust', () => {
    // 10 USDT pool, zero rake, 3 equal winning stakes of 1 USDT -> 10_000_000 / 3 each.
    const result = computeSettlement({
      outcome: 'A',
      rakeBps: 0,
      bets: [
        bet('a1', 'A', 1n * USDT),
        bet('a2', 'A', 1n * USDT),
        bet('a3', 'A', 1n * USDT),
        bet('b1', 'B', 7n * USDT),
      ],
    })

    expect(result.payouts.map((p) => p.amount)).toEqual([3_333_333n, 3_333_333n, 3_333_333n])
    expect(result.dust).toBe(1n)
    expect(result.rake).toBe(0n)
  })

  it('refunds every stake on VOID', () => {
    const result = computeSettlement({
      outcome: 'VOID',
      rakeBps: 500,
      bets: [bet('a1', 'A', 10n * USDT), bet('b1', 'B', 40n * USDT)],
    })

    expect(result.refunded).toBe(true)
    expect(result.rake).toBe(0n)
    expect(result.dust).toBe(0n)
    expect(result.payouts).toEqual([
      { betId: 'a1', amount: 10n * USDT },
      { betId: 'b1', amount: 40n * USDT },
    ])
  })

  it('refunds when nobody backed the winner', () => {
    const result = computeSettlement({
      outcome: 'A',
      rakeBps: 500,
      bets: [bet('b1', 'B', 40n * USDT), bet('b2', 'B', 10n * USDT)],
    })

    expect(result.refunded).toBe(true)
    expect(result.winningPool).toBe(0n)
    expect(result.payouts.map((p) => p.amount)).toEqual([40n * USDT, 10n * USDT])
  })

  it('refunds when every stake was on the winning side', () => {
    // Without this case the winners would be paid 0.95x their own money back.
    const result = computeSettlement({
      outcome: 'A',
      rakeBps: 500,
      bets: [bet('a1', 'A', 30n * USDT), bet('a2', 'A', 10n * USDT)],
    })

    expect(result.refunded).toBe(true)
    expect(result.rake).toBe(0n)
    expect(result.payouts).toEqual([
      { betId: 'a1', amount: 30n * USDT },
      { betId: 'a2', amount: 10n * USDT },
    ])
  })

  it('handles a fight with no bets at all', () => {
    const result = computeSettlement({ outcome: 'A', rakeBps: 500, bets: [] })
    expect(result).toEqual({
      refunded: true,
      poolTotal: 0n,
      winningPool: 0n,
      rake: 0n,
      dust: 0n,
      payouts: [],
    })
  })

  it('rejects a stake below 1 micro-unit', () => {
    expect(() =>
      computeSettlement({ outcome: 'A', rakeBps: 500, bets: [bet('x', 'A', 0n)] }),
    ).toThrow(/stake/)
  })

  it('rejects a rake outside 0..2000 bps', () => {
    expect(() => computeSettlement({ outcome: 'A', rakeBps: 2001, bets: [] })).toThrow(/rake/)
  })
})

describe('computeSettlement — properties', () => {
  const arbBets = fc.array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 8 }),
      side: fc.constantFrom<Side>('A', 'B'),
      stake: fc.bigInt({ min: 1n, max: 10n ** 15n }),
    }),
    { maxLength: 60 },
  )

  const arbInput = fc.record({
    outcome: fc.constantFrom<Outcome>('A', 'B', 'VOID'),
    rakeBps: fc.integer({ min: 0, max: 2000 }),
    bets: arbBets,
  })

  it('conserves the pool exactly: sum(payouts) + rake + dust === poolTotal', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const r = computeSettlement({
          ...input,
          bets: input.bets.map((b, i) => ({ ...b, id: `${i}` })),
        })
        const paid = r.payouts.reduce((acc, p) => acc + p.amount, 0n)
        expect(paid + r.rake + r.dust).toBe(r.poolTotal)
      }),
      { numRuns: 2000 },
    )
  })

  it('never produces a negative payout, rake, or dust', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const r = computeSettlement({
          ...input,
          bets: input.bets.map((b, i) => ({ ...b, id: `${i}` })),
        })
        expect(r.rake >= 0n).toBe(true)
        expect(r.dust >= 0n).toBe(true)
        for (const p of r.payouts) expect(p.amount >= 0n).toBe(true)
      }),
      { numRuns: 2000 },
    )
  })

  it('pays only bets on the winning side, unless refunding', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const bets = input.bets.map((b, i) => ({ ...b, id: `${i}` }))
        const r = computeSettlement({ ...input, bets })
        if (r.refunded) {
          expect(r.payouts.map((p) => p.betId)).toEqual(bets.map((b) => b.id))
        } else {
          const winners = new Set(bets.filter((b) => b.side === input.outcome).map((b) => b.id))
          for (const p of r.payouts) expect(winners.has(p.betId)).toBe(true)
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('refunds exactly the three specified cases', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const bets = input.bets.map((b, i) => ({ ...b, id: `${i}` }))
        const r = computeSettlement({ ...input, bets })
        const expectRefund =
          input.outcome === 'VOID' || r.winningPool === 0n || r.winningPool === r.poolTotal
        expect(r.refunded).toBe(expectRefund)
      }),
      { numRuns: 2000 },
    )
  })

  it('returns every stake at face value when refunding', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const bets = input.bets.map((b, i) => ({ ...b, id: `${i}` }))
        const r = computeSettlement({ ...input, bets })
        fc.pre(r.refunded)
        const byId = new Map(bets.map((b) => [b.id, b.stake]))
        for (const p of r.payouts) expect(p.amount).toBe(byId.get(p.betId))
        expect(r.rake).toBe(0n)
        expect(r.dust).toBe(0n)
      }),
      { numRuns: 2000 },
    )
  })

  it('leaves dust strictly smaller than the number of winning bets', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const bets = input.bets.map((b, i) => ({ ...b, id: `${i}` }))
        const r = computeSettlement({ ...input, bets })
        fc.pre(!r.refunded)
        expect(r.dust < BigInt(r.payouts.length)).toBe(true)
      }),
      { numRuns: 2000 },
    )
  })

  it('pays a winner less than their stake only when rake exceeds the losing pool', () => {
    // The single accepted way a winner can lose money — see "Known property" in the plan.
    fc.assert(
      fc.property(arbInput, (input) => {
        const bets = input.bets.map((b, i) => ({ ...b, id: `${i}` }))
        const r = computeSettlement({ ...input, bets })
        fc.pre(!r.refunded)
        const byId = new Map(bets.map((b) => [b.id, b.stake]))
        const shortfall = r.payouts.some((p) => p.amount < byId.get(p.betId)!)
        if (shortfall) {
          const losingPool = r.poolTotal - r.winningPool
          expect(r.rake >= losingPool || r.dust > 0n).toBe(true)
        }
      }),
      { numRuns: 2000 },
    )
  })
})
