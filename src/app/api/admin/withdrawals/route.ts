import { getDb } from '@/lib/db/client'
import { listPendingWithdrawals } from '@/lib/withdrawals/review'
import { handle, ok } from '@/lib/http/respond'
import { requireAdmin } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    await requireAdmin()
    return ok({ pending: await listPendingWithdrawals(getDb()) })
  })
}
