import { getDb } from '@/lib/db/client'
import { listFights, lockDueFights, poolTotals, estimatedPayoutPerUsdt } from '@/lib/fights/repo'
import { handle, ok } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    const db = getDb()
    // Lazy lock backstop: cheap enough at this scale to avoid needing a scheduler.
    await lockDueFights(db)

    const fights = await listFights(db, ['OPEN', 'LOCKED', 'SETTLED', 'VOIDED'])
    const summaries = await Promise.all(
      fights.map(async (fight) => {
        const totals = await poolTotals(db, fight.id)
        return { fight, totals, estimated: estimatedPayoutPerUsdt(totals, fight.rakeBps) }
      }),
    )

    return ok({ fights: summaries })
  })
}
