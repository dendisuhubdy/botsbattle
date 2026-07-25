import { getDb } from '@/lib/db/client'
import { getFight, lockDueFights, poolTotals, estimatedPayoutPerUsdt } from '@/lib/fights/repo'
import { handle, ok } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await params
    const db = getDb()
    await lockDueFights(db)

    const fight = await getFight(db, id)
    const totals = await poolTotals(db, id)
    return ok({ fight, totals, estimated: estimatedPayoutPerUsdt(totals, fight.rakeBps) })
  })
}
