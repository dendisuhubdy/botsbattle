import * as z from 'zod'
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/client'
import { login, SESSION_COOKIE, SESSION_TTL_DAYS } from '@/lib/auth/session'
import { handle, ok } from '@/lib/http/respond'
import { HttpError } from '@/lib/http/auth'

const Body = z.object({ email: z.email(), password: z.string().min(1) })

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    const { user, sessionId } = await login(getDb(), parsed.data.email, parsed.data.password)

    const jar = await cookies()
    jar.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    })

    return ok({ user })
  })
}
