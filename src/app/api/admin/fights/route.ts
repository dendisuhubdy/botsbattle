import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { createFight, listFights, poolTotals } from '@/lib/fights/repo'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireAdmin } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

const Body = z.object({
  leagueName: z.string().min(1).max(120),
  fighterA: z.string().min(1).max(120),
  fighterB: z.string().min(1).max(120),
  streamEmbedUrl: z.url().nullish(),
  lockAt: z.iso.datetime(),
  rakeBps: z.number().int().min(0).max(2000).optional(),
})

export async function GET(): Promise<Response> {
  return handle(async () => {
    await requireAdmin()
    const db = getDb()
    const fights = await listFights(db, ['DRAFT', 'OPEN', 'LOCKED', 'SETTLED', 'VOIDED'])
    const withTotals = await Promise.all(
      fights.map(async (fight) => ({ fight, totals: await poolTotals(db, fight.id) })),
    )
    return ok({ fights: withTotals })
  })
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const admin = await requireAdmin()

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    const fight = await createFight(getDb(), {
      leagueName: parsed.data.leagueName,
      fighterA: parsed.data.fighterA,
      fighterB: parsed.data.fighterB,
      streamEmbedUrl: parsed.data.streamEmbedUrl ?? null,
      lockAt: new Date(parsed.data.lockAt),
      rakeBps: parsed.data.rakeBps,
      createdBy: admin.id,
    })

    return ok({ fight }, { status: 201 })
  })
}
