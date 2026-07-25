import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { confirmEnrolment } from '@/lib/auth/totp'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireUser } from '@/lib/http/auth'

const Body = z.object({ code: z.string().regex(/^\d{6}$/) })

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', 'code must be six digits')

    await confirmEnrolment(getDb(), user.id, parsed.data.code)
    return ok({ enabled: true })
  })
}
