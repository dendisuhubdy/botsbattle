import { eq } from 'drizzle-orm'
import type { Executor } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import { signup } from '@/lib/auth/session'

let counter = 0

/** The password every fixture user is created with. */
export const FIXTURE_PASSWORD = 'a-good-password'

/**
 * A real, pre-computed Argon2id hash of `FIXTURE_PASSWORD` — verified against
 * `verifyPassword`, so fixture users can log in.
 *
 * Fixtures insert users directly rather than going through `signup`: at 19 MiB memory
 * cost, hashing several passwords per test adds seconds across the suite.
 */
const CANNED_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$JIDTUWsRUQajxQIHCIyaFw$EgPu2Va+2q6AkCmV7diSqKkeWsReeOruvzxtMR49nUo'

export async function makeUser(x: Executor, opts: { admin?: boolean } = {}): Promise<string> {
  const [created] = await x
    .insert(users)
    .values({
      email: `user${counter++}@example.com`,
      passwordHash: CANNED_HASH,
      isAdmin: opts.admin ?? false,
    })
    .returning({ id: users.id })
  return created.id
}

export async function makeAdmin(x: Executor): Promise<string> {
  return makeUser(x, { admin: true })
}

/** Create a user through the real signup path, then promote them. */
export async function makeRealAdmin(x: Executor, email: string, password: string): Promise<string> {
  const user = await signup(x, email, password)
  await x.update(users).set({ isAdmin: true }).where(eq(users.id, user.id))
  return user.id
}
