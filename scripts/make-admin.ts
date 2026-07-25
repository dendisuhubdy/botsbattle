import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/lib/db/client'
import { users } from '../src/lib/db/schema'

const email = process.argv[2]?.trim().toLowerCase()
if (!email) {
  console.error('usage: pnpm make-admin <email>')
  process.exit(1)
}

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const { db, pool } = createDb(url)
const updated = await db
  .update(users)
  .set({ isAdmin: true })
  .where(eq(users.email, email))
  .returning({ id: users.id, email: users.email })
await pool.end()

if (!updated.length) {
  console.error(`no user with email ${email}`)
  process.exit(1)
}
console.log(`${updated[0].email} is now an admin`)
