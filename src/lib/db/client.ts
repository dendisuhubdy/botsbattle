import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema'

export type Db = NodePgDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type Executor = Db | Tx

// Headroom matters: the concurrency test in Task 7 holds one connection per in-flight
// transaction while they queue on the same fight row lock.
export function createDb(connectionString: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString, max: 30 })
  return { db: drizzle(pool, { schema }), pool }
}

let singleton: { db: Db; pool: Pool } | null = null

/** Process-wide database handle for the Next.js app. */
export function getDb(): Db {
  if (!singleton) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    singleton = createDb(url)
  }
  return singleton.db
}
