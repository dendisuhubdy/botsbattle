import { getDb } from '@/lib/db/client'
import { beginEnrolment } from '@/lib/auth/totp'
import { handle, ok } from '@/lib/http/respond'
import { requireUser } from '@/lib/http/auth'

export async function POST(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const { secret, uri } = await beginEnrolment(getDb(), user.id)
    return ok({ secret, uri }, { status: 201 })
  })
}
