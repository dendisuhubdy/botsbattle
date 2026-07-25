import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/client'
import { destroySession, SESSION_COOKIE } from '@/lib/auth/session'
import { handle, ok } from '@/lib/http/respond'

export async function POST(): Promise<Response> {
  return handle(async () => {
    const jar = await cookies()
    const sessionId = jar.get(SESSION_COOKIE)?.value
    if (sessionId) await destroySession(getDb(), sessionId)
    jar.delete(SESSION_COOKIE)
    return ok({ ok: true })
  })
}
