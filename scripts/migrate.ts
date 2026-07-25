import 'dotenv/config'
import { runMigrations } from '../src/lib/db/migrate'

const url = process.argv[2] ?? process.env.DATABASE_URL
if (!url) {
  console.error('no connection string: pass one as argv[2] or set DATABASE_URL')
  process.exit(1)
}

const applied = await runMigrations(url)
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date')
