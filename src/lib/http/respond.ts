import { NextResponse } from 'next/server'
import { jsonSafe } from './serialize'
import { HttpError } from './auth'
import { AuthError } from '@/lib/auth/session'
import { BetError } from '@/lib/bets/place'
import { FightError } from '@/lib/fights/repo'
import { SettleError } from '@/lib/settlement/settle'
import { SettlementMathError } from '@/lib/settlement/math'
import { CreditError } from '@/lib/admin/credit'
import { LedgerError } from '@/lib/ledger/post'
import { TotpError } from '@/lib/auth/totp'
import { WithdrawalError } from '@/lib/withdrawals/request'

export function ok<T>(data: T, init?: ResponseInit): Response {
  return NextResponse.json({ data: jsonSafe(data) }, init)
}

export function fail(status: number, code: string, message: string): Response {
  return NextResponse.json({ error: { code, message } }, { status })
}

const STATUS_BY_CODE: Record<string, number> = {
  // auth
  EMAIL_TAKEN: 409,
  BAD_CREDENTIALS: 401,
  WEAK_PASSWORD: 422,
  // fights
  NOT_FOUND: 404,
  BAD_TRANSITION: 409,
  INVALID_RAKE: 422,
  LOCK_IN_PAST: 422,
  // bets
  FIGHT_NOT_FOUND: 404,
  FIGHT_NOT_OPEN: 409,
  FIGHT_LOCKED: 409,
  INSUFFICIENT_FUNDS: 402,
  STAKE_BELOW_MINIMUM: 422,
  // settlement
  NOT_SETTLEABLE: 409,
  POOL_NOT_DRAINED: 500,
  INVARIANT_VIOLATED: 500,
  INVALID_STAKE: 422,
  // credit / ledger
  NON_POSITIVE: 422,
  UNBALANCED: 500,
  EMPTY: 500,
  // totp
  NOT_ENROLLED: 428,
  ALREADY_ENROLLED: 409,
  INVALID_CODE: 401,
  NO_KEY: 500,
  // withdrawals
  BELOW_MINIMUM: 422,
  INVALID_ADDRESS: 422,
  LOCKED: 403,
  NOT_REVIEWABLE: 409,
  NOT_CANCELLABLE: 409,
}

/** Single place where domain errors become HTTP status codes. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.code, err.message)

    if (
      err instanceof AuthError ||
      err instanceof BetError ||
      err instanceof FightError ||
      err instanceof SettleError ||
      err instanceof SettlementMathError ||
      err instanceof CreditError ||
      err instanceof LedgerError ||
      err instanceof TotpError ||
      err instanceof WithdrawalError
    ) {
      const status = STATUS_BY_CODE[err.code] ?? 400
      if (status >= 500) console.error('[api] domain failure', err)
      return fail(status, err.code, err.message)
    }

    console.error('[api] unhandled', err)
    return fail(500, 'INTERNAL', 'something went wrong')
  }
}
