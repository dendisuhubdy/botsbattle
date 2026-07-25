import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { approveWithdrawal } from '@/lib/withdrawals/review'
import { handle, ok } from '@/lib/http/respond'
import { requireAdmin } from '@/lib/http/auth'

const Body = z.object({ note: z.string().max(500).optional() })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const admin = await requireAdmin()
    const { id } = await params
    const parsed = Body.safeParse(await request.json().catch(() => ({})))

    const result = await approveWithdrawal(getDb(), {
      requestId: id,
      adminId: admin.id,
      note: parsed.success ? parsed.data.note : undefined,
    })
    return ok(result)
  })
}
