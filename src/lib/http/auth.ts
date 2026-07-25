import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/client'
import { resolveSession, SESSION_COOKIE, type SessionUser } from '@/lib/auth/session'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies()
  return resolveSession(getDb(), jar.get(SESSION_COOKIE)?.value)
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser()
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'sign in to continue')
  return user
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser()
  if (!user.isAdmin) throw new HttpError(403, 'FORBIDDEN', 'admin access required')
  return user
}
