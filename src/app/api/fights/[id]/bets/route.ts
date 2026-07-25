import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { placeBet } from '@/lib/bets/place'
import { parseUsdt } from '@/lib/money/units'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireUser } from '@/lib/http/auth'

const Body = z.object({
  side: z.enum(['A', 'B']),
  stake: z.string(),
  idempotencyKey: z.string().min(8).max(64),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const { id } = await params

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    // The stake arrives as a decimal USDT string, so no float ever touches the request path.
    let stake: bigint
    try {
      stake = parseUsdt(parsed.data.stake)
    } catch {
      throw new HttpError(422, 'INVALID_STAKE', `not a valid USDT amount: ${parsed.data.stake}`)
    }

    const result = await placeBet(getDb(), {
      userId: user.id,
      fightId: id,
      side: parsed.data.side,
      stake,
      // Namespaced by user so one client cannot replay another's key.
      idempotencyKey: `${user.id}:${parsed.data.idempotencyKey}`,
    })

    return ok(result, { status: result.replayed ? 200 : 201 })
  })
}
