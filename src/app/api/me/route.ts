import { getDb } from '@/lib/db/client'
import { userBalance } from '@/lib/ledger/accounts'
import { handle, ok } from '@/lib/http/respond'
import { requireUser } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    return ok({ user, balance: await userBalance(getDb(), user.id) })
  })
}
