import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import type { Db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { signup, login, resolveSession, destroySession, AuthError } from '@/lib/auth/session'
import { makeUser, FIXTURE_PASSWORD } from '../helpers/fixtures'

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).not.toContain('correct horse')
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true)
    expect(await verifyPassword(hash, 'wrong password')).toBe(false)
  })

  it('produces a different hash each time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })
})

describe('signup and login', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('creates a user and a resolvable session', async () => {
    await signup(db, 'a@example.com', 'a-good-password')
    const { user, sessionId } = await login(db, 'a@example.com', 'a-good-password')

    expect(user.email).toBe('a@example.com')
    expect(user.isAdmin).toBe(false)

    const resolved = await resolveSession(db, sessionId)
    expect(resolved).toMatchObject({ id: user.id, email: 'a@example.com' })
  })

  it('normalises the email to lower case', async () => {
    await signup(db, 'MiXeD@Example.COM', 'a-good-password')
    const { user } = await login(db, 'mixed@example.com', 'a-good-password')
    expect(user.email).toBe('mixed@example.com')
  })

  it('rejects a duplicate email', async () => {
    await signup(db, 'dup@example.com', 'a-good-password')
    await expect(signup(db, 'dup@example.com', 'another-password')).rejects.toMatchObject({
      code: 'EMAIL_TAKEN',
    })
  })

  it('rejects a password shorter than 10 characters', async () => {
    await expect(signup(db, 'short@example.com', 'nine char')).rejects.toMatchObject({
      code: 'WEAK_PASSWORD',
    })
  })

  it('rejects a wrong password with the same error as an unknown email', async () => {
    await signup(db, 'real@example.com', 'a-good-password')
    const wrongPassword = await login(db, 'real@example.com', 'nope-nope-nope').catch((e) => e)
    const unknownEmail = await login(db, 'ghost@example.com', 'a-good-password').catch((e) => e)

    expect(wrongPassword).toBeInstanceOf(AuthError)
    expect(unknownEmail).toBeInstanceOf(AuthError)
    expect(wrongPassword.code).toBe('BAD_CREDENTIALS')
    expect(unknownEmail.code).toBe('BAD_CREDENTIALS')
  })

  it('returns null for an unknown, missing, or destroyed session', async () => {
    await signup(db, 'x@example.com', 'a-good-password')
    const { sessionId } = await login(db, 'x@example.com', 'a-good-password')

    expect(await resolveSession(db, undefined)).toBeNull()
    expect(await resolveSession(db, 'not-a-uuid')).toBeNull()

    await destroySession(db, sessionId)
    expect(await resolveSession(db, sessionId)).toBeNull()
  })

  it('lets a fixture user log in, pinning the canned hash to the real verifier', async () => {
    const userId = await makeUser(db)
    const email = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .then((r) => r[0].email)

    const { user } = await login(db, email, FIXTURE_PASSWORD)
    expect(user.id).toBe(userId)
  })

  it('returns null for an expired session', async () => {
    await signup(db, 'exp@example.com', 'a-good-password')
    const { sessionId } = await login(db, 'exp@example.com', 'a-good-password')

    await db.execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${sessionId}`,
    )

    expect(await resolveSession(db, sessionId)).toBeNull()
  })
})
