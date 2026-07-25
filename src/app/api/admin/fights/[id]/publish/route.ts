import { getDb } from '@/lib/db/client'
import { publishFight } from '@/lib/fights/repo'
import { handle, ok } from '@/lib/http/respond'
import { requireAdmin } from '@/lib/http/auth'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    await requireAdmin()
    const { id } = await params
    return ok({ fight: await publishFight(getDb(), id) })
  })
}
