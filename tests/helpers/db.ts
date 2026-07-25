import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { createDb, type Db } from '@/lib/db/client'
import { runMigrations } from '@/lib/db/migrate'

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://botsbattle:botsbattle@localhost:5434/botsbattle_test'

let handle: { db: Db; pool: Pool } | null = null

async function ensureDatabaseExists(): Promise<void> {
  const dbName = new URL(TEST_URL).pathname.slice(1)
  const adminUrl = new URL(TEST_URL)
  adminUrl.pathname = '/postgres'

  const admin = new Pool({ connectionString: adminUrl.toString() })
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
    if (!existing.rowCount) {
      await admin.query(`CREATE DATABASE "${dbName}"`)
    }
  } finally {
    await admin.end()
  }
}

export async function testDb(): Promise<{ db: Db; pool: Pool }> {
  if (handle) return handle
  await ensureDatabaseExists()
  await runMigrations(TEST_URL)
  handle = createDb(TEST_URL)
  return handle
}

/**
 * Flatten an error and its `cause` chain into one string.
 *
 * Drizzle reports a failed COMMIT as `Failed query: commit` and hangs the real
 * Postgres error off `cause`, so deferred-constraint failures are invisible to a
 * plain `.toThrow(/message/)` assertion.
 */
export function errorChain(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  while (current instanceof Error) {
    parts.push(current.message)
    current = current.cause
  }
  return parts.join(' | ')
}

/** Wipe all data and restore the seeded singleton house accounts. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`
    TRUNCATE ledger_entries, ledger_transactions, accounts RESTART IDENTITY CASCADE
  `)
  await db.execute(sql`
    INSERT INTO accounts (kind) VALUES ('house_rake'), ('house_dust'), ('hot_wallet')
  `)
}
