import { getDb } from '@/lib/db/client'
import { cancelWithdrawal } from '@/lib/withdrawals/request'
import { handle, ok } from '@/lib/http/respond'
import { requireUser } from '@/lib/http/auth'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const { id } = await params
    await cancelWithdrawal(getDb(), { userId: user.id, requestId: id })
    return ok({ ok: true })
  })
}
