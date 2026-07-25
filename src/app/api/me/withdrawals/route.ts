import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { parseUsdt } from '@/lib/money/units'
import { requestWithdrawal, listUserWithdrawals } from '@/lib/withdrawals/request'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireUser } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

const Body = z.object({
  address: z.string().min(30).max(50),
  amount: z.string(),
  totpCode: z.string().regex(/^\d{6}$/),
})

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    return ok({ withdrawals: await listUserWithdrawals(getDb(), user.id) })
  })
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    let amountMicros: bigint
    try {
      amountMicros = parseUsdt(parsed.data.amount)
    } catch {
      throw new HttpError(422, 'INVALID_AMOUNT', `not a valid USDT amount: ${parsed.data.amount}`)
    }

    const result = await requestWithdrawal(getDb(), {
      userId: user.id,
      address: parsed.data.address,
      amountMicros,
      totpCode: parsed.data.totpCode,
    })

    return ok(result, { status: 201 })
  })
}
