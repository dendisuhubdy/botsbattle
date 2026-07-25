import type { Outcome, Side } from '@/lib/fights/repo'

export type SettlementBet = { id: string; side: Side; stake: bigint }

export type SettlementInput = {
  outcome: Outcome
  rakeBps: number
  bets: SettlementBet[]
}

export type Payout = { betId: string; amount: bigint }

export type SettlementResult = {
  refunded: boolean
  poolTotal: bigint
  winningPool: bigint
  rake: bigint
  dust: bigint
  payouts: Payout[]
}

export class SettlementMathError extends Error {
  constructor(
    message: string,
    readonly code: 'INVARIANT_VIOLATED' | 'INVALID_RAKE' | 'INVALID_STAKE',
  ) {
    super(message)
    this.name = 'SettlementMathError'
  }
}

/**
 * Pari-mutuel settlement, integer arithmetic only. Every division operates on
 * non-negative operands, so BigInt truncation is a floor.
 *
 * The pool-conservation invariant is asserted before returning rather than left to
 * the caller: a settlement that does not conserve the pool must never reach the ledger.
 */
export function computeSettlement(input: SettlementInput): SettlementResult {
  if (!Number.isInteger(input.rakeBps) || input.rakeBps < 0 || input.rakeBps > 2000) {
    throw new SettlementMathError(
      `rake_bps must be an integer in 0..2000, got ${input.rakeBps}`,
      'INVALID_RAKE',
    )
  }
  for (const b of input.bets) {
    if (b.stake <= 0n) {
      throw new SettlementMathError(`bet ${b.id} has non-positive stake ${b.stake}`, 'INVALID_STAKE')
    }
  }

  const poolTotal = input.bets.reduce((acc, b) => acc + b.stake, 0n)
  const winners = input.outcome === 'VOID' ? [] : input.bets.filter((b) => b.side === input.outcome)
  const winningPool = winners.reduce((acc, b) => acc + b.stake, 0n)

  // Three cases collapse to a full refund at face value with no rake.
  const refunded = input.outcome === 'VOID' || winningPool === 0n || winningPool === poolTotal

  const result: SettlementResult = refunded
    ? {
        refunded: true,
        poolTotal,
        winningPool,
        rake: 0n,
        dust: 0n,
        payouts: input.bets.map((b) => ({ betId: b.id, amount: b.stake })),
      }
    : (() => {
        const rake = (poolTotal * BigInt(input.rakeBps)) / 10000n
        const distributable = poolTotal - rake
        const payouts = winners.map((b) => ({
          betId: b.id,
          amount: (distributable * b.stake) / winningPool,
        }))
        const paid = payouts.reduce((acc, p) => acc + p.amount, 0n)
        return { refunded: false, poolTotal, winningPool, rake, dust: distributable - paid, payouts }
      })()

  const total = result.payouts.reduce((acc, p) => acc + p.amount, 0n) + result.rake + result.dust
  if (total !== poolTotal) {
    throw new SettlementMathError(
      `settlement does not conserve the pool: paid+rake+dust=${total}, poolTotal=${poolTotal}`,
      'INVARIANT_VIOLATED',
    )
  }

  return result
}
