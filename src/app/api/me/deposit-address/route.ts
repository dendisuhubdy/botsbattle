import { getDb } from '@/lib/db/client'
import { loadTronConfig } from '@/lib/tron/config'
import { assignDepositAddress, getDepositAddress } from '@/lib/deposits/addresses'
import { handle, ok } from '@/lib/http/respond'
import { requireUser } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    return ok({ depositAddress: await getDepositAddress(getDb(), user.id) })
  })
}

export async function POST(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const config = loadTronConfig()
    const assigned = await assignDepositAddress(getDb(), { userId: user.id, xpub: config.xpub })
    return ok(assigned, { status: assigned.created ? 201 : 200 })
  })
}
