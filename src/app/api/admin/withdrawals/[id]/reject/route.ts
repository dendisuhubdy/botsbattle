import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { rejectWithdrawal } from '@/lib/withdrawals/review'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireAdmin } from '@/lib/http/auth'

const Body = z.object({ note: z.string().min(1).max(500) })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const admin = await requireAdmin()
    const { id } = await params

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', 'a rejection note is required')

    await rejectWithdrawal(getDb(), { requestId: id, adminId: admin.id, note: parsed.data.note })
    return ok({ ok: true })
  })
}
