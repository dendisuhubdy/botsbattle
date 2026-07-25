import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'

const MIGRATIONS_DIR = join(process.cwd(), 'migrations')

export async function runMigrations(connectionString: string): Promise<string[]> {
  const pool = new Pool({ connectionString })
  const client = await pool.connect()
  const applied: string[] = []

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      const existing = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file])
      if (existing.rowCount) continue

      const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(body)
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        applied.push(file)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err })
      }
    }
  } finally {
    client.release()
    await pool.end()
  }

  return applied
}
