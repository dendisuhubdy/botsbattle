import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { settleFight } from '@/lib/settlement/settle'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireAdmin } from '@/lib/http/auth'

const Body = z.object({ outcome: z.enum(['A', 'B', 'VOID']) })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const admin = await requireAdmin()
    const { id } = await params

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    const settlement = await settleFight(getDb(), {
      fightId: id,
      outcome: parsed.data.outcome,
      settledBy: admin.id,
    })

    return ok({ settlement })
  })
}
