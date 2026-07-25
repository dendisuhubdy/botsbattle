import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { creditUser } from '@/lib/admin/credit'
import { parseUsdt } from '@/lib/money/units'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireAdmin } from '@/lib/http/auth'

const Body = z.object({
  userId: z.uuid(),
  amount: z.string(),
  reference: z.string().min(4).max(64),
})

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const admin = await requireAdmin()

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    let amount: bigint
    try {
      amount = parseUsdt(parsed.data.amount)
    } catch {
      throw new HttpError(422, 'INVALID_AMOUNT', `not a valid USDT amount: ${parsed.data.amount}`)
    }

    const result = await creditUser(getDb(), {
      userId: parsed.data.userId,
      amount,
      reference: parsed.data.reference,
      creditedBy: admin.id,
    })

    return ok(result, { status: 201 })
  })
}
