# Slice 1 — Ledger, Fights, Betting, Settlement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete pari-mutuel betting engine — double-entry ledger, fight lifecycle, bet placement, and settlement — with no blockchain integration, so that money correctness is proven before any chain complexity exists.

**Architecture:** A single Next.js 15 App Router application talking to PostgreSQL 16 through Drizzle as a typed query builder. Schema is managed by hand-written SQL migrations applied by a small in-repo runner (not drizzle-kit), because the ledger's zero-sum guarantee is a deferred constraint trigger that a schema generator cannot express. All money is `BIGINT` micro-units. Business logic lives in `src/lib/` as plain functions taking a Drizzle executor, so every rule is testable without HTTP.

**Tech Stack:** Node 26, pnpm, TypeScript, Next.js 15 (App Router) + React 19, PostgreSQL 16 via Docker Compose, Drizzle ORM, `pg`, `@node-rs/argon2`, `zod`, Vitest, fast-check.

## Global Constraints

- **Integers only.** All monetary amounts are `BIGINT` micro-units; `1 USDT = 1_000_000`. No floats, no `NUMERIC`, no decimal strings in any calculation. Formatting to `"48.20"` happens only in the view layer.
- **No `balance` column.** An account's balance is `SUM(amount)` over its ledger entries. `balance_cache` and the reconciliation job are deferred out of Slice 1 (approved deviation from the spec).
- **Every ledger transaction sums to exactly zero**, enforced by a deferred constraint trigger in the database, not by application convention.
- **Idempotency keys everywhere**: settlements keyed by `fight_id`, bets by client-supplied `idempotency_key`, ledger transactions by `idempotency_key`, each with a `UNIQUE` constraint.
- **Lock is enforced at bet insert time** inside the same transaction as the balance check, under `SELECT ... FOR UPDATE` on the fight row. A scheduled/lazy lock transition is only a backstop.
- **Minimum stake is 1 USDT** (`1_000_000` micro-units).
- **Default `rake_bps` is 500** (5%), configurable per fight.
- `side` is `'A' | 'B'`. `outcome` is `'A' | 'B' | 'VOID'`. Fight status is `DRAFT | OPEN | LOCKED | SETTLED | VOIDED`.
- **No Tron, no worker, no signer in this slice.** Balances are created by an admin credit endpoint standing in for deposits.
- Sessions are server-side rows in Postgres delivered as an `httpOnly`, `Secure`, `SameSite=Lax` cookie named `bb_session` with 30-day expiry. Argon2id for passwords.
- UI in this slice is functional and unstyled. Design work is explicitly out of scope.
- **Work directly on `main`, and `git push origin main` after every task's commit.** Do not batch commits locally and do not open branches unless asked — the repository owner tracks progress from the remote.
- The production domain is **botsfight.com** (relevant to Slice 4; the spec's `sslip.io` TLS workaround is obsolete).

## File Structure

| Path | Responsibility |
|---|---|
| `docker-compose.yml` | Postgres 16 for development and tests |
| `migrations/*.sql` | Hand-written, forward-only schema migrations |
| `src/lib/db/client.ts` | `pg` Pool + Drizzle instance; `Db` / `Tx` / `Executor` types |
| `src/lib/db/schema.ts` | Drizzle table declarations mirroring the SQL |
| `src/lib/db/migrate.ts` | Migration runner (applies `migrations/*.sql` in order) |
| `src/lib/money/units.ts` | Micro-unit parsing and display formatting |
| `src/lib/ledger/accounts.ts` | Account lookup/creation, `balanceOf` |
| `src/lib/ledger/post.ts` | `postTransaction` — the only writer of ledger rows |
| `src/lib/auth/password.ts` | Argon2id hash/verify |
| `src/lib/auth/session.ts` | Session create/validate/destroy, cookie helpers |
| `src/lib/fights/repo.ts` | Fight CRUD, state transitions, pool totals, estimated odds |
| `src/lib/bets/place.ts` | `placeBet` — the locking transaction |
| `src/lib/settlement/math.ts` | Pure integer pari-mutuel math (no DB) |
| `src/lib/settlement/settle.ts` | Transactional settlement, idempotent by `fight_id` |
| `src/lib/admin/credit.ts` | Manual balance credit (deposit stand-in) |
| `src/app/api/**` | Route handlers |
| `src/app/**` | Pages |
| `tests/helpers/db.ts` | Test database connection + truncation helper |
| `tests/**` | Vitest suites mirroring `src/lib` |

## Known property (accepted, not a bug)

In a non-refund settlement where the winning pool is a large fraction of the total, winners can receive slightly **less** than their stake — e.g. `winningPool` at 99% of `poolTotal` with a 5% rake pays `95/99` of stake. This follows directly from pari-mutuel with rake and is not covered by the spec's three refund cases (which handle `VOID`, `winningPool == 0`, and `winningPool == poolTotal`). Tests assert this is the *only* circumstance in which it happens. If the product decides it is unacceptable, the fix is a fourth refund case or a rake cap — a spec change, not an implementation change.

---

## Task 1: Project scaffold, database, and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `docker-compose.yml`, `.env.example`, `.gitignore`, `.dockerignore`
- Create: `src/lib/db/client.ts`, `src/lib/db/schema.ts`, `src/lib/db/migrate.ts`, `scripts/migrate.ts`
- Create: `migrations/0001_init.sql`
- Create: `tests/helpers/db.ts`, `tests/db/connection.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `src/lib/db/client.ts`: `createDb(connectionString: string): { db: Db; pool: Pool }`, and types `Db`, `Tx`, `Executor`
  - `src/lib/db/migrate.ts`: `runMigrations(connectionString: string): Promise<string[]>` returning applied filenames
  - `tests/helpers/db.ts`: `testDb(): Promise<{ db: Db; pool: Pool }>`, `truncateAll(db: Db): Promise<void>`

- [ ] **Step 1: Initialise the package and install dependencies**

```bash
cd /Users/dendisuhubdy/Github/botsbattle
pnpm init
pnpm add next@15 react@19 react-dom@19 drizzle-orm pg zod @node-rs/argon2
pnpm add -D typescript@5 @types/node @types/react @types/react-dom @types/pg vitest fast-check tsx dotenv
```

**Pin TypeScript to 5.x.** TypeScript 7 (the Go-based compiler) changes the API that Next
uses to read `tsconfig.json`; under it, `next build` cannot resolve the `@/*` path alias and
cannot load a `.ts` config at all. `tsc --noEmit` passes either way, so the failure only
appears at build time.

**Use `next.config.mjs`, not `.ts`,** for the same reason — it removes the config loader's
dependency on the TypeScript API entirely.

pnpm skips build scripts by default; esbuild (which vitest needs) has one. Add to
`package.json` before installing:

```json
  "pnpm": { "onlyBuiltDependencies": ["esbuild", "sharp", "unrs-resolver"] }
```

- [ ] **Step 2: Write the config files**

`package.json` — replace the `scripts` block with:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "db:up": "docker compose up -d db",
    "db:down": "docker compose down",
    "db:migrate": "tsx scripts/migrate.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.mjs`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pg', '@node-rs/argon2'],
}

export default nextConfig
```

`vitest.config.ts` — tests share one Postgres instance, so they must not run in parallel:

```ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Vitest 4 removed `poolOptions`; these are top-level now.
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    setupFiles: ['dotenv/config'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
```

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: botsbattle
      POSTGRES_PASSWORD: botsbattle
      POSTGRES_DB: botsbattle
    ports:
      - "5434:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U botsbattle"]
      interval: 2s
      timeout: 3s
      retries: 30

volumes:
  pgdata:
```

`.env.example`:

```
DATABASE_URL=postgres://botsbattle:botsbattle@localhost:5434/botsbattle
TEST_DATABASE_URL=postgres://botsbattle:botsbattle@localhost:5434/botsbattle_test
```

`.gitignore`:

```
node_modules
.next
.env
*.tsbuildinfo
next-env.d.ts
```

`.dockerignore`:

```
node_modules
.next
.git
```

- [ ] **Step 3: Write the initial migration**

`migrations/0001_init.sql` — accounts, ledger, and the zero-sum trigger. Note `DEFERRABLE INITIALLY DEFERRED`: the check runs at `COMMIT`, so a transaction may transiently be unbalanced while writing its legs.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_kind AS ENUM (
  'user_available',
  'user_pending_withdrawal',
  'pool',
  'house_rake',
  'house_dust',
  'hot_wallet'
);

CREATE TABLE accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       account_kind NOT NULL,
  user_id    UUID,
  fight_id   UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One user_available / user_pending_withdrawal account per user.
CREATE UNIQUE INDEX accounts_user_kind_uq
  ON accounts (kind, user_id)
  WHERE user_id IS NOT NULL;

-- One pool account per fight.
CREATE UNIQUE INDEX accounts_pool_fight_uq
  ON accounts (fight_id)
  WHERE kind = 'pool';

-- Exactly one of each house/system account.
CREATE UNIQUE INDEX accounts_singleton_uq
  ON accounts (kind)
  WHERE kind IN ('house_rake', 'house_dust', 'hot_wallet');

CREATE TABLE ledger_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id      UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount     BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (tx_id);

CREATE FUNCTION assert_ledger_balanced() RETURNS trigger AS $$
DECLARE
  total BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO total
  FROM ledger_entries WHERE tx_id = NEW.tx_id;

  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not sum to zero (sum = %)', NEW.tx_id, total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

-- A ledger transaction with no entries at all is also invalid.
CREATE FUNCTION assert_ledger_tx_nonempty() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE tx_id = NEW.id) THEN
    RAISE EXCEPTION 'ledger transaction % has no entries', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_transactions_nonempty
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_tx_nonempty();

-- Singleton house accounts.
INSERT INTO accounts (kind) VALUES ('house_rake'), ('house_dust'), ('hot_wallet');
```

- [ ] **Step 4: Write the migration runner**

`src/lib/db/migrate.ts`:

```ts
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
```

`scripts/migrate.ts`:

```ts
import 'dotenv/config'
import { runMigrations } from '../src/lib/db/migrate'

const url = process.argv[2] ?? process.env.DATABASE_URL
if (!url) {
  console.error('no connection string: pass one as argv[2] or set DATABASE_URL')
  process.exit(1)
}

const applied = await runMigrations(url)
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date')
```

- [ ] **Step 5: Write the database client**

`src/lib/db/schema.ts` — start with accounts and ledger only; later tasks append to this file:

```ts
import { pgTable, pgEnum, uuid, text, bigint, jsonb, timestamp, index } from 'drizzle-orm/pg-core'

export const accountKind = pgEnum('account_kind', [
  'user_available',
  'user_pending_withdrawal',
  'pool',
  'house_rake',
  'house_dust',
  'hot_wallet',
])

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: accountKind('kind').notNull(),
  userId: uuid('user_id'),
  fightId: uuid('fight_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    txId: uuid('tx_id').notNull().references(() => ledgerTransactions.id),
    accountId: uuid('account_id').notNull().references(() => accounts.id),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_entries_account_idx').on(t.accountId),
    index('ledger_entries_tx_idx').on(t.txId),
  ],
)
```

`src/lib/db/client.ts`:

```ts
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
```

- [ ] **Step 6: Write the test helper**

`tests/helpers/db.ts` — creates the test database once, migrates it, and hands out a shared handle. `truncateAll` resets state between tests while preserving the seeded house accounts by re-running the seed.

```ts
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
```

- [ ] **Step 7: Write the failing connection test**

`tests/db/connection.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { testDb, truncateAll, errorChain } from '../helpers/db'
import type { Db } from '@/lib/db/client'

describe('database', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('applies migrations and seeds the house accounts', async () => {
    // Sorted in JS: Postgres orders ENUMs by declaration order and text by collation,
    // neither of which is worth encoding in an assertion about set membership.
    const result = await db.execute<{ kind: string }>(sql`SELECT kind FROM accounts`)
    expect(result.rows.map((r) => r.kind).sort()).toEqual(
      ['house_rake', 'house_dust', 'hot_wallet'].sort(),
    )
  })

  it('rejects a ledger transaction whose entries do not sum to zero', async () => {
    const error = await db
      .transaction(async (tx) => {
        const [{ id: txId }] = await tx
          .execute<{ id: string }>(
            sql`INSERT INTO ledger_transactions (kind, idempotency_key)
                VALUES ('test', 'unbalanced-1') RETURNING id`,
          )
          .then((r) => r.rows)

        const [{ id: accountId }] = await tx
          .execute<{ id: string }>(sql`SELECT id FROM accounts WHERE kind = 'house_rake'`)
          .then((r) => r.rows)

        await tx.execute(
          sql`INSERT INTO ledger_entries (tx_id, account_id, amount)
              VALUES (${txId}, ${accountId}, 100)`,
        )
      })
      .catch((e: unknown) => e)

    expect(errorChain(error)).toMatch(/does not sum to zero/)
  })
})
```

- [ ] **Step 8: Start the database and run the test to verify it fails**

```bash
pnpm db:up
docker compose ps
pnpm test tests/db/connection.test.ts
```

Expected: FAIL — the migration/test-helper wiring is what this task builds, so the first run either errors on a missing module or on a connection refusal. Fix forward until both tests pass.

- [ ] **Step 9: Run the test to verify it passes**

```bash
pnpm test tests/db/connection.test.ts
pnpm typecheck
```

Expected: PASS, 2 tests. Typecheck clean.

- [ ] **Step 10: Commit and push**

```bash
git add -A
git commit -m "feat: project scaffold, Postgres migrations, and zero-sum ledger constraint"
git push origin main
```

---

## Task 2: Money units

**Files:**
- Create: `src/lib/money/units.ts`
- Test: `tests/money/units.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `MICRO: bigint` (`1_000_000n`)
  - `MIN_STAKE_MICROS: bigint` (`1_000_000n`)
  - `parseUsdt(input: string): bigint` — throws `RangeError` on malformed input or more than 6 decimal places
  - `formatUsdt(micros: bigint): string` — always exactly 2 decimal places, e.g. `"48.20"`, `"-3.00"`
  - `formatUsdtExact(micros: bigint): string` — up to 6 decimal places, trailing zeros trimmed, e.g. `"48.2"`, `"0.000001"`

- [ ] **Step 1: Write the failing test**

`tests/money/units.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { MICRO, parseUsdt, formatUsdt, formatUsdtExact } from '@/lib/money/units'

describe('parseUsdt', () => {
  it('parses whole and fractional amounts', () => {
    expect(parseUsdt('1')).toBe(1_000_000n)
    expect(parseUsdt('48.2')).toBe(48_200_000n)
    expect(parseUsdt('48.20')).toBe(48_200_000n)
    expect(parseUsdt('0.000001')).toBe(1n)
    expect(parseUsdt('0')).toBe(0n)
  })

  it('rejects malformed input', () => {
    for (const bad of ['', ' ', 'abc', '1.2.3', '-1', '1e6', '.5', '1.']) {
      expect(() => parseUsdt(bad)).toThrow(RangeError)
    }
  })

  it('rejects more precision than USDT has', () => {
    expect(() => parseUsdt('0.0000001')).toThrow(RangeError)
  })
})

describe('formatUsdt', () => {
  it('renders two decimal places', () => {
    expect(formatUsdt(48_200_000n)).toBe('48.20')
    expect(formatUsdt(0n)).toBe('0.00')
    expect(formatUsdt(1n)).toBe('0.00')
    expect(formatUsdt(-3_000_000n)).toBe('-3.00')
  })
})

describe('formatUsdtExact', () => {
  it('trims trailing zeros but keeps significant precision', () => {
    expect(formatUsdtExact(48_200_000n)).toBe('48.2')
    expect(formatUsdtExact(1n)).toBe('0.000001')
    expect(formatUsdtExact(1_000_000n)).toBe('1')
    expect(formatUsdtExact(-1_500_000n)).toBe('-1.5')
  })
})

describe('round trip', () => {
  it('parseUsdt(formatUsdtExact(x)) === x for any micro amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (micros) => {
        expect(parseUsdt(formatUsdtExact(micros))).toBe(micros)
      }),
      { numRuns: 500 },
    )
  })
})

describe('MICRO', () => {
  it('is one million', () => {
    expect(MICRO).toBe(1_000_000n)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/money/units.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/money/units"`.

- [ ] **Step 3: Write the implementation**

`src/lib/money/units.ts`:

```ts
export const DECIMALS = 6
export const MICRO = 1_000_000n
export const MIN_STAKE_MICROS = 1_000_000n

const AMOUNT_RE = /^(\d+)(?:\.(\d+))?$/

/**
 * Parse a non-negative decimal USDT string into micro-units.
 * Rejects anything that is not a plain decimal with at most 6 fractional digits.
 */
export function parseUsdt(input: string): bigint {
  const match = AMOUNT_RE.exec(input)
  if (!match) throw new RangeError(`not a valid USDT amount: ${JSON.stringify(input)}`)

  const [, whole, fraction = ''] = match
  if (fraction.length > DECIMALS) {
    throw new RangeError(`USDT has ${DECIMALS} decimals, got ${fraction.length}`)
  }

  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(DECIMALS, '0') || '0')
}

function split(micros: bigint): { sign: string; whole: bigint; fraction: string } {
  const negative = micros < 0n
  const abs = negative ? -micros : micros
  return {
    sign: negative ? '-' : '',
    whole: abs / MICRO,
    fraction: (abs % MICRO).toString().padStart(DECIMALS, '0'),
  }
}

/** Display form with exactly two decimal places. Truncates, never rounds up. */
export function formatUsdt(micros: bigint): string {
  const { sign, whole, fraction } = split(micros)
  return `${sign}${whole}.${fraction.slice(0, 2)}`
}

/** Lossless display form: up to six decimals, trailing zeros trimmed. */
export function formatUsdtExact(micros: bigint): string {
  const { sign, whole, fraction } = split(micros)
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/money/units.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/money/units.ts tests/money/units.test.ts
git commit -m "feat: micro-unit money parsing and formatting"
git push origin main
```

---

## Task 3: Ledger accounts and the posting API

**Files:**
- Create: `src/lib/ledger/accounts.ts`, `src/lib/ledger/post.ts`
- Test: `tests/ledger/post.test.ts`

**Interfaces:**
- Consumes: `Db`, `Tx`, `Executor` from `@/lib/db/client`; `accounts`, `ledgerTransactions`, `ledgerEntries` from `@/lib/db/schema`
- Produces:
  - `src/lib/ledger/accounts.ts`:
    - `userAvailableAccount(x: Executor, userId: string): Promise<string>` — get-or-create, returns account id
    - `poolAccount(x: Executor, fightId: string): Promise<string>` — get-or-create, returns account id
    - `houseAccount(x: Executor, kind: 'house_rake' | 'house_dust' | 'hot_wallet'): Promise<string>`
    - `balanceOf(x: Executor, accountId: string): Promise<bigint>`
    - `userBalance(x: Executor, userId: string): Promise<bigint>`
  - `src/lib/ledger/post.ts`:
    - `type Leg = { accountId: string; amount: bigint }`
    - `type PostArgs = { kind: string; idempotencyKey: string; legs: Leg[]; metadata?: Record<string, unknown> }`
    - `type PostResult = { txId: string; replayed: boolean }`
    - `postTransaction(x: Executor, args: PostArgs): Promise<PostResult>`
    - `class LedgerError extends Error { code: 'UNBALANCED' | 'EMPTY' }`

- [ ] **Step 1: Write the failing test**

`tests/ledger/post.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { testDb, truncateAll } from '../helpers/db'
import type { Db } from '@/lib/db/client'
import { userAvailableAccount, houseAccount, balanceOf, userBalance } from '@/lib/ledger/accounts'
import { postTransaction, LedgerError } from '@/lib/ledger/post'

describe('ledger', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('creates a user account once and reuses it', async () => {
    const userId = randomUUID()
    const a = await userAvailableAccount(db, userId)
    const b = await userAvailableAccount(db, userId)
    expect(a).toBe(b)
  })

  it('posts a balanced transaction and moves the balance', async () => {
    const userId = randomUUID()
    const user = await userAvailableAccount(db, userId)
    const rake = await houseAccount(db, 'house_rake')

    const result = await postTransaction(db, {
      kind: 'TEST_CREDIT',
      idempotencyKey: 'credit-1',
      legs: [
        { accountId: rake, amount: -100_000_000n },
        { accountId: user, amount: 100_000_000n },
      ],
    })

    expect(result.replayed).toBe(false)
    expect(await balanceOf(db, user)).toBe(100_000_000n)
    expect(await balanceOf(db, rake)).toBe(-100_000_000n)
    expect(await userBalance(db, userId)).toBe(100_000_000n)
  })

  it('returns zero for an account with no entries', async () => {
    const user = await userAvailableAccount(db, randomUUID())
    expect(await balanceOf(db, user)).toBe(0n)
  })

  it('is idempotent: replaying the same key writes no new entries', async () => {
    const userId = randomUUID()
    const user = await userAvailableAccount(db, userId)
    const rake = await houseAccount(db, 'house_rake')
    const legs = [
      { accountId: rake, amount: -5_000_000n },
      { accountId: user, amount: 5_000_000n },
    ]

    const first = await postTransaction(db, { kind: 'TEST_CREDIT', idempotencyKey: 'dup', legs })
    const second = await postTransaction(db, { kind: 'TEST_CREDIT', idempotencyKey: 'dup', legs })

    expect(second.replayed).toBe(true)
    expect(second.txId).toBe(first.txId)
    expect(await balanceOf(db, user)).toBe(5_000_000n)
  })

  it('rejects an unbalanced transaction before touching the database', async () => {
    const user = await userAvailableAccount(db, randomUUID())
    const rake = await houseAccount(db, 'house_rake')

    await expect(
      postTransaction(db, {
        kind: 'BAD',
        idempotencyKey: 'bad-1',
        legs: [
          { accountId: rake, amount: -10n },
          { accountId: user, amount: 9n },
        ],
      }),
    ).rejects.toMatchObject({ code: 'UNBALANCED' })

    expect(await balanceOf(db, user)).toBe(0n)
  })

  it('rejects a transaction with no legs', async () => {
    await expect(
      postTransaction(db, { kind: 'BAD', idempotencyKey: 'empty-1', legs: [] }),
    ).rejects.toBeInstanceOf(LedgerError)
  })

  it('participates in a caller-supplied transaction and rolls back with it', async () => {
    const userId = randomUUID()
    const user = await userAvailableAccount(db, userId)
    const rake = await houseAccount(db, 'house_rake')

    await expect(
      db.transaction(async (tx) => {
        await postTransaction(tx, {
          kind: 'TEST_CREDIT',
          idempotencyKey: 'rollback-1',
          legs: [
            { accountId: rake, amount: -1_000_000n },
            { accountId: user, amount: 1_000_000n },
          ],
        })
        throw new Error('caller aborts')
      }),
    ).rejects.toThrow('caller aborts')

    expect(await balanceOf(db, user)).toBe(0n)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/ledger/post.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/ledger/accounts"`.

- [ ] **Step 3: Write the accounts module**

`src/lib/ledger/accounts.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm'
import type { Executor } from '@/lib/db/client'
import { accounts, ledgerEntries } from '@/lib/db/schema'

type HouseKind = 'house_rake' | 'house_dust' | 'hot_wallet'

/**
 * Get-or-create relies on the partial unique indexes from migration 0001;
 * `onConflictDoNothing` plus a follow-up select makes it safe under concurrency.
 */
async function getOrCreate(
  x: Executor,
  match: { kind: (typeof accounts.$inferInsert)['kind']; userId?: string; fightId?: string },
): Promise<string> {
  const where = and(
    eq(accounts.kind, match.kind),
    match.userId ? eq(accounts.userId, match.userId) : sql`user_id IS NULL`,
    match.fightId ? eq(accounts.fightId, match.fightId) : sql`fight_id IS NULL`,
  )

  const existing = await x.select({ id: accounts.id }).from(accounts).where(where).limit(1)
  if (existing.length) return existing[0].id

  const inserted = await x
    .insert(accounts)
    .values({ kind: match.kind, userId: match.userId ?? null, fightId: match.fightId ?? null })
    .onConflictDoNothing()
    .returning({ id: accounts.id })
  if (inserted.length) return inserted[0].id

  const raced = await x.select({ id: accounts.id }).from(accounts).where(where).limit(1)
  if (!raced.length) throw new Error(`could not resolve account ${JSON.stringify(match)}`)
  return raced[0].id
}

export function userAvailableAccount(x: Executor, userId: string): Promise<string> {
  return getOrCreate(x, { kind: 'user_available', userId })
}

export function userPendingWithdrawalAccount(x: Executor, userId: string): Promise<string> {
  return getOrCreate(x, { kind: 'user_pending_withdrawal', userId })
}

export function poolAccount(x: Executor, fightId: string): Promise<string> {
  return getOrCreate(x, { kind: 'pool', fightId })
}

export function houseAccount(x: Executor, kind: HouseKind): Promise<string> {
  return getOrCreate(x, { kind })
}

export async function balanceOf(x: Executor, accountId: string): Promise<bigint> {
  const rows = await x
    .select({ balance: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)` })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId))
  return BigInt(rows[0]?.balance ?? '0')
}

export async function userBalance(x: Executor, userId: string): Promise<bigint> {
  return balanceOf(x, await userAvailableAccount(x, userId))
}
```

- [ ] **Step 4: Write the posting module**

`src/lib/ledger/post.ts`. The database trigger is the backstop; this function fails fast so callers get a typed error instead of a Postgres exception at commit time.

```ts
import { eq } from 'drizzle-orm'
import type { Db, Executor, Tx } from '@/lib/db/client'
import { ledgerEntries, ledgerTransactions } from '@/lib/db/schema'

export type Leg = { accountId: string; amount: bigint }

export type PostArgs = {
  kind: string
  idempotencyKey: string
  legs: Leg[]
  metadata?: Record<string, unknown>
}

export type PostResult = { txId: string; replayed: boolean }

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: 'UNBALANCED' | 'EMPTY',
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}

/** A `Tx` carries a rollback handle; a pooled `Db` does not. */
function isTx(x: Executor): x is Tx {
  return 'rollback' in x
}

/**
 * Write one balanced ledger transaction.
 * Replaying an `idempotencyKey` is a no-op that returns the original transaction id.
 *
 * The header row and its entries must land in the same database transaction: the
 * `ledger_transactions_nonempty` constraint trigger fires at COMMIT, so an autocommitted
 * header with no entries yet is a constraint violation. When handed a pooled `Db` this
 * opens its own transaction; when handed a `Tx` it joins the caller's.
 */
export async function postTransaction(x: Executor, args: PostArgs): Promise<PostResult> {
  const legs = args.legs.filter((leg) => leg.amount !== 0n)
  if (legs.length === 0) {
    throw new LedgerError(`transaction ${args.idempotencyKey} has no non-zero legs`, 'EMPTY')
  }

  const sum = legs.reduce((acc, leg) => acc + leg.amount, 0n)
  if (sum !== 0n) {
    throw new LedgerError(
      `transaction ${args.idempotencyKey} does not sum to zero (sum = ${sum})`,
      'UNBALANCED',
    )
  }

  if (isTx(x)) return write(x, args, legs)
  return (x as Db).transaction((tx) => write(tx, args, legs))
}

async function write(x: Executor, args: PostArgs, legs: Leg[]): Promise<PostResult> {
  const inserted = await x
    .insert(ledgerTransactions)
    .values({
      kind: args.kind,
      idempotencyKey: args.idempotencyKey,
      metadata: args.metadata ?? {},
    })
    .onConflictDoNothing({ target: ledgerTransactions.idempotencyKey })
    .returning({ id: ledgerTransactions.id })

  if (!inserted.length) {
    const existing = await x
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, args.idempotencyKey))
      .limit(1)
    return { txId: existing[0].id, replayed: true }
  }

  const txId = inserted[0].id
  await x.insert(ledgerEntries).values(
    legs.map((leg) => ({ txId, accountId: leg.accountId, amount: leg.amount })),
  )

  return { txId, replayed: false }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/ledger/post.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit and push**

```bash
git add src/lib/ledger tests/ledger
git commit -m "feat: double-entry ledger accounts and idempotent posting"
git push origin main
```

---

## Task 4: Users, passwords, and sessions

**Files:**
- Create: `migrations/0002_users.sql`
- Modify: `src/lib/db/schema.ts` (append users and sessions tables)
- Modify: `tests/helpers/db.ts` (add the new tables to `truncateAll`)
- Create: `src/lib/auth/password.ts`, `src/lib/auth/session.ts`
- Test: `tests/auth/auth.test.ts`

**Interfaces:**
- Consumes: `Executor` from `@/lib/db/client`
- Produces:
  - `src/lib/auth/password.ts`: `hashPassword(plain: string): Promise<string>`, `verifyPassword(hash: string, plain: string): Promise<boolean>`
  - `src/lib/auth/session.ts`:
    - `SESSION_COOKIE = 'bb_session'`, `SESSION_TTL_DAYS = 30`
    - `class AuthError extends Error { code: 'EMAIL_TAKEN' | 'BAD_CREDENTIALS' | 'WEAK_PASSWORD' }`
    - `type SessionUser = { id: string; email: string; isAdmin: boolean }`
    - `signup(x: Executor, email: string, password: string): Promise<SessionUser>`
    - `login(x: Executor, email: string, password: string): Promise<{ user: SessionUser; sessionId: string }>`
    - `resolveSession(x: Executor, sessionId: string | undefined): Promise<SessionUser | null>`
    - `destroySession(x: Executor, sessionId: string): Promise<void>`

- [ ] **Step 1: Write the migration**

`migrations/0002_users.sql`. `verification_status` and `withdrawal_locked` are the compliance seam from the spec: present, defaulted, unused at launch. `is_admin` is an addition this slice needs so `fights.created_by` and the admin panel have an authority to check.

```sql
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  totp_secret_enc     TEXT,
  totp_enabled        BOOLEAN NOT NULL DEFAULT false,
  verification_status TEXT NOT NULL DEFAULT 'none',
  withdrawal_locked   BOOLEAN NOT NULL DEFAULT false,
  is_admin            BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

ALTER TABLE accounts
  ADD CONSTRAINT accounts_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
```

- [ ] **Step 2: Extend the Drizzle schema**

Append to `src/lib/db/schema.ts`:

```ts
import { boolean } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpSecretEnc: text('totp_secret_enc'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  verificationStatus: text('verification_status').notNull().default('none'),
  withdrawalLocked: boolean('withdrawal_locked').notNull().default(false),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

Add `boolean` to the existing `drizzle-orm/pg-core` import rather than writing a second import statement.

- [ ] **Step 3: Extend the truncation helper**

In `tests/helpers/db.ts`, replace the `TRUNCATE` statement with:

```ts
  await db.execute(sql`
    TRUNCATE ledger_entries, ledger_transactions, accounts, sessions, users
    RESTART IDENTITY CASCADE
  `)
```

- [ ] **Step 4: Write the failing test**

`tests/auth/auth.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import type { Db } from '@/lib/db/client'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { signup, login, resolveSession, destroySession, AuthError } from '@/lib/auth/session'

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

  it('returns null for an expired session', async () => {
    await signup(db, 'exp@example.com', 'a-good-password')
    const { sessionId } = await login(db, 'exp@example.com', 'a-good-password')

    await db.execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${sessionId}`,
    )

    expect(await resolveSession(db, sessionId)).toBeNull()
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test tests/auth/auth.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/auth/password"`.

- [ ] **Step 6: Write the password module**

`src/lib/auth/password.ts`:

```ts
import { hash, verify } from '@node-rs/argon2'

// `Algorithm.Argon2id` is an ambient const enum, which `isolatedModules` forbids importing.
// 2 is its value, and it is also this library's default — passing it explicitly documents
// that the choice is deliberate rather than inherited.
const ARGON2ID = 2

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS)
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain, OPTIONS)
  } catch {
    return false
  }
}
```

- [ ] **Step 7: Write the session module**

`src/lib/auth/session.ts`:

```ts
import { and, eq, gt, sql } from 'drizzle-orm'
import type { Executor } from '@/lib/db/client'
import { sessions, users } from '@/lib/db/schema'
import { hashPassword, verifyPassword } from './password'

export const SESSION_COOKIE = 'bb_session'
export const SESSION_TTL_DAYS = 30
const MIN_PASSWORD_LENGTH = 10

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A well-formed Argon2id hash of a value no user can supply. Verifying against it
 * keeps the unknown-email path the same cost as the wrong-password path.
 */
const DUMMY_HASH_PROMISE = hashPassword(`no-such-user:${' '.repeat(16)}`)

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: 'EMAIL_TAKEN' | 'BAD_CREDENTIALS' | 'WEAK_PASSWORD',
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export type SessionUser = { id: string; email: string; isAdmin: boolean }

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function signup(
  x: Executor,
  email: string,
  password: string,
): Promise<SessionUser> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`, 'WEAK_PASSWORD')
  }

  const normalised = normaliseEmail(email)
  const passwordHash = await hashPassword(password)

  const inserted = await x
    .insert(users)
    .values({ email: normalised, passwordHash })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id, email: users.email, isAdmin: users.isAdmin })

  if (!inserted.length) throw new AuthError('email already registered', 'EMAIL_TAKEN')
  return inserted[0]
}

export async function login(
  x: Executor,
  email: string,
  password: string,
): Promise<{ user: SessionUser; sessionId: string }> {
  const found = await x
    .select({
      id: users.id,
      email: users.email,
      isAdmin: users.isAdmin,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, normaliseEmail(email)))
    .limit(1)

  // Verify against a real hash when the user is absent, so the unknown-email path costs
  // the same as the wrong-password path. A malformed placeholder would throw inside
  // `verify` and return early, which is exactly the timing signal this exists to remove.
  const passwordHash = found.length ? found[0].passwordHash : await DUMMY_HASH_PROMISE
  const ok = await verifyPassword(passwordHash, password)
  if (!found.length || !ok) throw new AuthError('invalid email or password', 'BAD_CREDENTIALS')

  const [session] = await x
    .insert(sessions)
    .values({
      userId: found[0].id,
      expiresAt: sql`now() + interval '${sql.raw(String(SESSION_TTL_DAYS))} days'`,
    })
    .returning({ id: sessions.id })

  const { id, email: userEmail, isAdmin } = found[0]
  return { user: { id, email: userEmail, isAdmin }, sessionId: session.id }
}

export async function resolveSession(
  x: Executor,
  sessionId: string | undefined,
): Promise<SessionUser | null> {
  if (!sessionId || !UUID_RE.test(sessionId)) return null

  const rows = await x
    .select({ id: users.id, email: users.email, isAdmin: users.isAdmin })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, sql`now()`)))
    .limit(1)

  return rows.length ? rows[0] : null
}

export async function destroySession(x: Executor, sessionId: string): Promise<void> {
  if (!UUID_RE.test(sessionId)) return
  await x.delete(sessions).where(eq(sessions.id, sessionId))
}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
pnpm test tests/auth/auth.test.ts
pnpm typecheck
```

Expected: PASS, 9 tests. Typecheck clean.

- [ ] **Step 9: Commit and push**

```bash
git add migrations/0002_users.sql src/lib/db/schema.ts src/lib/auth tests/auth tests/helpers/db.ts
git commit -m "feat: users, Argon2id passwords, and server-side sessions"
git push origin main
```

---

## Task 5: Fights — schema, lifecycle, and pool totals

**Files:**
- Create: `migrations/0003_fights.sql`
- Modify: `src/lib/db/schema.ts` (append fights, bets, settlements)
- Modify: `tests/helpers/db.ts` (add the new tables to `truncateAll`)
- Create: `src/lib/fights/repo.ts`
- Test: `tests/fights/repo.test.ts`

**Interfaces:**
- Consumes: `Executor`, `poolAccount`
- Produces (`src/lib/fights/repo.ts`):
  - `type FightStatus = 'DRAFT' | 'OPEN' | 'LOCKED' | 'SETTLED' | 'VOIDED'`
  - `type Side = 'A' | 'B'`; `type Outcome = 'A' | 'B' | 'VOID'`
  - `type Fight = { id, leagueName, fighterA, fighterB, streamEmbedUrl, status, lockAt, rakeBps, outcome, createdBy, settledAt }`
  - `class FightError extends Error { code: 'NOT_FOUND' | 'BAD_TRANSITION' | 'INVALID_RAKE' | 'LOCK_IN_PAST' }`
  - `createFight(x, input: CreateFightInput): Promise<Fight>` where `CreateFightInput = { leagueName, fighterA, fighterB, streamEmbedUrl, lockAt: Date, rakeBps?: number, createdBy: string }`
  - `getFight(x, fightId): Promise<Fight>` — throws `NOT_FOUND`
  - `publishFight(x, fightId): Promise<Fight>` — `DRAFT → OPEN`
  - `lockFight(x, fightId): Promise<Fight>` — `OPEN → LOCKED`
  - `lockDueFights(x): Promise<number>` — backstop; locks every `OPEN` fight past `lock_at`, returns the count
  - `listFights(x, statuses: FightStatus[]): Promise<Fight[]>`
  - `poolTotals(x, fightId): Promise<{ total: bigint; a: bigint; b: bigint }>`
  - `estimatedPayoutPerUsdt(totals, rakeBps): { a: bigint | null; b: bigint | null }` — pure; micro-units of payout per 1 USDT staked, `null` when that side has no stake

- [ ] **Step 1: Write the migration**

`migrations/0003_fights.sql`:

```sql
CREATE TYPE fight_status  AS ENUM ('DRAFT', 'OPEN', 'LOCKED', 'SETTLED', 'VOIDED');
CREATE TYPE fight_outcome AS ENUM ('A', 'B', 'VOID');
CREATE TYPE bet_side      AS ENUM ('A', 'B');

CREATE TABLE fights (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_name      TEXT NOT NULL,
  fighter_a        TEXT NOT NULL,
  fighter_b        TEXT NOT NULL,
  stream_embed_url TEXT,
  status           fight_status NOT NULL DEFAULT 'DRAFT',
  lock_at          TIMESTAMPTZ NOT NULL,
  rake_bps         INTEGER NOT NULL DEFAULT 500 CHECK (rake_bps >= 0 AND rake_bps <= 2000),
  outcome          fight_outcome,
  created_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ,
  CONSTRAINT fights_outcome_matches_status CHECK (
    (status = 'SETTLED' AND outcome IN ('A', 'B'))
    OR (status = 'VOIDED' AND outcome = 'VOID')
    OR (status IN ('DRAFT', 'OPEN', 'LOCKED') AND outcome IS NULL)
  )
);

CREATE INDEX fights_status_idx ON fights (status, lock_at);

ALTER TABLE accounts
  ADD CONSTRAINT accounts_fight_fk FOREIGN KEY (fight_id) REFERENCES fights(id) ON DELETE RESTRICT;

CREATE TABLE bets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fight_id        UUID NOT NULL REFERENCES fights(id) ON DELETE RESTRICT,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  side            bet_side NOT NULL,
  stake           BIGINT NOT NULL CHECK (stake >= 1000000),
  idempotency_key TEXT NOT NULL UNIQUE,
  payout          BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bets_fight_idx ON bets (fight_id);
CREATE INDEX bets_user_idx  ON bets (user_id, created_at DESC);

CREATE TABLE settlements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fight_id     UUID NOT NULL UNIQUE REFERENCES fights(id) ON DELETE RESTRICT,
  outcome      fight_outcome NOT NULL,
  pool_total   BIGINT NOT NULL,
  winning_pool BIGINT NOT NULL,
  rake         BIGINT NOT NULL,
  dust         BIGINT NOT NULL,
  refunded     BOOLEAN NOT NULL,
  settled_by   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  settled_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Extend the Drizzle schema**

Append to `src/lib/db/schema.ts` (add `integer` to the `drizzle-orm/pg-core` import):

```ts
export const fightStatus = pgEnum('fight_status', ['DRAFT', 'OPEN', 'LOCKED', 'SETTLED', 'VOIDED'])
export const fightOutcome = pgEnum('fight_outcome', ['A', 'B', 'VOID'])
export const betSide = pgEnum('bet_side', ['A', 'B'])

export const fights = pgTable('fights', {
  id: uuid('id').primaryKey().defaultRandom(),
  leagueName: text('league_name').notNull(),
  fighterA: text('fighter_a').notNull(),
  fighterB: text('fighter_b').notNull(),
  streamEmbedUrl: text('stream_embed_url'),
  status: fightStatus('status').notNull().default('DRAFT'),
  lockAt: timestamp('lock_at', { withTimezone: true }).notNull(),
  rakeBps: integer('rake_bps').notNull().default(500),
  outcome: fightOutcome('outcome'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
})

export const bets = pgTable(
  'bets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fightId: uuid('fight_id').notNull().references(() => fights.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    side: betSide('side').notNull(),
    stake: bigint('stake', { mode: 'bigint' }).notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    payout: bigint('payout', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bets_fight_idx').on(t.fightId), index('bets_user_idx').on(t.userId)],
)

export const settlements = pgTable('settlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  fightId: uuid('fight_id').notNull().unique().references(() => fights.id),
  outcome: fightOutcome('outcome').notNull(),
  poolTotal: bigint('pool_total', { mode: 'bigint' }).notNull(),
  winningPool: bigint('winning_pool', { mode: 'bigint' }).notNull(),
  rake: bigint('rake', { mode: 'bigint' }).notNull(),
  dust: bigint('dust', { mode: 'bigint' }).notNull(),
  refunded: boolean('refunded').notNull(),
  settledBy: uuid('settled_by').notNull().references(() => users.id),
  settledAt: timestamp('settled_at', { withTimezone: true }).notNull().defaultNow(),
})
```

- [ ] **Step 3: Extend the truncation helper**

In `tests/helpers/db.ts`, replace the `TRUNCATE` statement with:

```ts
  await db.execute(sql`
    TRUNCATE ledger_entries, ledger_transactions, settlements, bets, accounts, fights, sessions, users
    RESTART IDENTITY CASCADE
  `)
```

- [ ] **Step 4: Write the failing test**

`tests/fights/repo.test.ts`. `makeAdmin` is defined here and reused by later tasks via `tests/helpers/fixtures.ts` — create that helper file now.

`tests/helpers/fixtures.ts`:

```ts
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
 *
 * Regenerate with:
 *   node --input-type=module -e "import {hash} from '@node-rs/argon2';
 *     console.log(await hash('a-good-password',
 *       {algorithm:2,memoryCost:19456,timeCost:2,parallelism:1}))"
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
```

**Note for Task 3's tests:** migration 0002 adds an FK from `accounts.user_id` to `users.id`, so
the ledger tests can no longer invent user UUIDs with `randomUUID()`. They must call `makeUser`.
This is why `fixtures.ts` is created here rather than in Task 5.

`tests/fights/repo.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import { makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import {
  createFight,
  getFight,
  publishFight,
  lockFight,
  lockDueFights,
  listFights,
  poolTotals,
  estimatedPayoutPerUsdt,
  FightError,
} from '@/lib/fights/repo'

const HOUR = 60 * 60 * 1000

describe('fights repo', () => {
  let db: Db
  let admin: string

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
  })

  const base = () => ({
    leagueName: 'Robot League',
    fighterA: 'Crusher',
    fighterB: 'Bolt',
    streamEmbedUrl: 'https://player.twitch.tv/?channel=example',
    lockAt: new Date(Date.now() + HOUR),
    createdBy: admin,
  })

  it('creates a fight in DRAFT with the default rake', async () => {
    const fight = await createFight(db, base())
    expect(fight.status).toBe('DRAFT')
    expect(fight.rakeBps).toBe(500)
    expect(fight.outcome).toBeNull()
  })

  it('accepts a per-fight rake override', async () => {
    const fight = await createFight(db, { ...base(), rakeBps: 250 })
    expect(fight.rakeBps).toBe(250)
  })

  it('rejects a rake outside 0..2000 bps', async () => {
    await expect(createFight(db, { ...base(), rakeBps: 2001 })).rejects.toMatchObject({
      code: 'INVALID_RAKE',
    })
    await expect(createFight(db, { ...base(), rakeBps: -1 })).rejects.toMatchObject({
      code: 'INVALID_RAKE',
    })
  })

  it('rejects a lock time in the past', async () => {
    await expect(
      createFight(db, { ...base(), lockAt: new Date(Date.now() - HOUR) }),
    ).rejects.toMatchObject({ code: 'LOCK_IN_PAST' })
  })

  it('walks DRAFT -> OPEN -> LOCKED', async () => {
    const fight = await createFight(db, base())
    expect((await publishFight(db, fight.id)).status).toBe('OPEN')
    expect((await lockFight(db, fight.id)).status).toBe('LOCKED')
  })

  it('refuses illegal transitions', async () => {
    const fight = await createFight(db, base())
    await expect(lockFight(db, fight.id)).rejects.toMatchObject({ code: 'BAD_TRANSITION' })

    await publishFight(db, fight.id)
    await expect(publishFight(db, fight.id)).rejects.toMatchObject({ code: 'BAD_TRANSITION' })
  })

  it('throws NOT_FOUND for an unknown fight', async () => {
    await expect(getFight(db, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      FightError,
    )
  })

  it('lockDueFights locks only OPEN fights past their lock time', async () => {
    const due = await createFight(db, base())
    const notDue = await createFight(db, { ...base(), lockAt: new Date(Date.now() + 5 * HOUR) })
    const stillDraft = await createFight(db, base())

    await publishFight(db, due.id)
    await publishFight(db, notDue.id)
    await db.execute(
      sql`UPDATE fights SET lock_at = now() - interval '1 minute' WHERE id = ${due.id}`,
    )

    expect(await lockDueFights(db)).toBe(1)
    expect((await getFight(db, due.id)).status).toBe('LOCKED')
    expect((await getFight(db, notDue.id)).status).toBe('OPEN')
    expect((await getFight(db, stillDraft.id)).status).toBe('DRAFT')
  })

  it('lists fights filtered by status', async () => {
    const open = await createFight(db, base())
    await createFight(db, base())
    await publishFight(db, open.id)

    const listed = await listFights(db, ['OPEN'])
    expect(listed.map((f) => f.id)).toEqual([open.id])
  })

  it('reports zero pool totals for a fight with no bets', async () => {
    const fight = await createFight(db, base())
    expect(await poolTotals(db, fight.id)).toEqual({ total: 0n, a: 0n, b: 0n })
  })
})

describe('estimatedPayoutPerUsdt', () => {
  it('returns null for a side with no stake', () => {
    const odds = estimatedPayoutPerUsdt({ total: 100_000_000n, a: 100_000_000n, b: 0n }, 500)
    expect(odds.b).toBeNull()
  })

  it('divides the distributable pool across the backing side', () => {
    // 100 USDT total, 25 on A, 5% rake -> distributable 95 -> 3.8 USDT per USDT on A
    const odds = estimatedPayoutPerUsdt({ total: 100_000_000n, a: 25_000_000n, b: 75_000_000n }, 500)
    expect(odds.a).toBe(3_800_000n)
  })

  it('returns face value when all stake is on one side', () => {
    // Everyone on A means a refund at settlement, so the estimate must show 1.00x, not 0.95x.
    const odds = estimatedPayoutPerUsdt({ total: 40_000_000n, a: 40_000_000n, b: 0n }, 500)
    expect(odds.a).toBe(1_000_000n)
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test tests/fights/repo.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/fights/repo"`.

- [ ] **Step 6: Write the repo**

`src/lib/fights/repo.ts`:

```ts
import { and, eq, inArray, lte, sql, desc } from 'drizzle-orm'
import type { Executor } from '@/lib/db/client'
import { bets, fights } from '@/lib/db/schema'
import { MICRO } from '@/lib/money/units'
import { poolAccount } from '@/lib/ledger/accounts'

export type FightStatus = 'DRAFT' | 'OPEN' | 'LOCKED' | 'SETTLED' | 'VOIDED'
export type Side = 'A' | 'B'
export type Outcome = 'A' | 'B' | 'VOID'

export type Fight = {
  id: string
  leagueName: string
  fighterA: string
  fighterB: string
  streamEmbedUrl: string | null
  status: FightStatus
  lockAt: Date
  rakeBps: number
  outcome: Outcome | null
  createdBy: string
  settledAt: Date | null
}

export type CreateFightInput = {
  leagueName: string
  fighterA: string
  fighterB: string
  streamEmbedUrl?: string | null
  lockAt: Date
  rakeBps?: number
  createdBy: string
}

export class FightError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'BAD_TRANSITION' | 'INVALID_RAKE' | 'LOCK_IN_PAST',
  ) {
    super(message)
    this.name = 'FightError'
  }
}

const COLUMNS = {
  id: fights.id,
  leagueName: fights.leagueName,
  fighterA: fights.fighterA,
  fighterB: fights.fighterB,
  streamEmbedUrl: fights.streamEmbedUrl,
  status: fights.status,
  lockAt: fights.lockAt,
  rakeBps: fights.rakeBps,
  outcome: fights.outcome,
  createdBy: fights.createdBy,
  settledAt: fights.settledAt,
}

export async function createFight(x: Executor, input: CreateFightInput): Promise<Fight> {
  const rakeBps = input.rakeBps ?? 500
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > 2000) {
    throw new FightError(`rake_bps must be an integer in 0..2000, got ${rakeBps}`, 'INVALID_RAKE')
  }
  if (input.lockAt.getTime() <= Date.now()) {
    throw new FightError('lock_at must be in the future', 'LOCK_IN_PAST')
  }

  const [created] = await x
    .insert(fights)
    .values({
      leagueName: input.leagueName,
      fighterA: input.fighterA,
      fighterB: input.fighterB,
      streamEmbedUrl: input.streamEmbedUrl ?? null,
      lockAt: input.lockAt,
      rakeBps,
      createdBy: input.createdBy,
    })
    .returning(COLUMNS)

  // Create the pool account up front so settlement never has to.
  await poolAccount(x, created.id)
  return created as Fight
}

export async function getFight(x: Executor, fightId: string): Promise<Fight> {
  const rows = await x.select(COLUMNS).from(fights).where(eq(fights.id, fightId)).limit(1)
  if (!rows.length) throw new FightError(`fight ${fightId} not found`, 'NOT_FOUND')
  return rows[0] as Fight
}

async function transition(
  x: Executor,
  fightId: string,
  from: FightStatus,
  to: FightStatus,
): Promise<Fight> {
  const updated = await x
    .update(fights)
    .set({ status: to })
    .where(and(eq(fights.id, fightId), eq(fights.status, from)))
    .returning(COLUMNS)

  if (updated.length) return updated[0] as Fight

  const current = await getFight(x, fightId) // throws NOT_FOUND if it does not exist
  throw new FightError(
    `cannot move fight ${fightId} from ${current.status} to ${to}`,
    'BAD_TRANSITION',
  )
}

export function publishFight(x: Executor, fightId: string): Promise<Fight> {
  return transition(x, fightId, 'DRAFT', 'OPEN')
}

export function lockFight(x: Executor, fightId: string): Promise<Fight> {
  return transition(x, fightId, 'OPEN', 'LOCKED')
}

/** Backstop for fights whose lock time passed without a bet arriving to enforce it. */
export async function lockDueFights(x: Executor): Promise<number> {
  const locked = await x
    .update(fights)
    .set({ status: 'LOCKED' })
    .where(and(eq(fights.status, 'OPEN'), lte(fights.lockAt, sql`now()`)))
    .returning({ id: fights.id })
  return locked.length
}

export async function listFights(x: Executor, statuses: FightStatus[]): Promise<Fight[]> {
  if (!statuses.length) return []
  const rows = await x
    .select(COLUMNS)
    .from(fights)
    .where(inArray(fights.status, statuses))
    .orderBy(desc(fights.lockAt))
  return rows as Fight[]
}

export type PoolTotals = { total: bigint; a: bigint; b: bigint }

export async function poolTotals(x: Executor, fightId: string): Promise<PoolTotals> {
  const rows = await x
    .select({
      side: bets.side,
      total: sql<string>`COALESCE(SUM(${bets.stake}), 0)`,
    })
    .from(bets)
    .where(eq(bets.fightId, fightId))
    .groupBy(bets.side)

  const a = BigInt(rows.find((r) => r.side === 'A')?.total ?? '0')
  const b = BigInt(rows.find((r) => r.side === 'B')?.total ?? '0')
  return { total: a + b, a, b }
}

/**
 * Estimated payout in micro-units per 1 USDT staked, for each side.
 * `null` means nobody has backed that side yet, so no estimate exists.
 * When one side holds the entire pool the settlement will refund, so the estimate is 1.00x.
 */
export function estimatedPayoutPerUsdt(
  totals: PoolTotals,
  rakeBps: number,
): { a: bigint | null; b: bigint | null } {
  const forSide = (sideTotal: bigint): bigint | null => {
    if (sideTotal === 0n) return null
    if (sideTotal === totals.total) return MICRO
    const distributable = totals.total - (totals.total * BigInt(rakeBps)) / 10000n
    return (distributable * MICRO) / sideTotal
  }
  return { a: forSide(totals.a), b: forSide(totals.b) }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm test tests/fights/repo.test.ts
pnpm typecheck
```

Expected: PASS, 13 tests. Typecheck clean.

- [ ] **Step 8: Commit and push**

```bash
git add migrations/0003_fights.sql src/lib/db/schema.ts src/lib/fights tests/fights tests/helpers
git commit -m "feat: fight lifecycle, pool totals, and estimated odds"
git push origin main
```

---

## Task 6: Admin credit — the deposit stand-in

Slice 2 replaces this with real Tron deposits. Until then it is the only way money enters the system, and it must be as idempotent and as auditable as the real thing.

**Files:**
- Create: `src/lib/admin/credit.ts`
- Test: `tests/admin/credit.test.ts`

**Interfaces:**
- Consumes: `postTransaction`, `userAvailableAccount`, `houseAccount`, `balanceOf`
- Produces (`src/lib/admin/credit.ts`):
  - `class CreditError extends Error { code: 'NON_POSITIVE' }`
  - `creditUser(x: Executor, args: { userId: string; amount: bigint; reference: string; creditedBy: string }): Promise<{ txId: string; replayed: boolean }>`

The credit is funded from `hot_wallet`, which therefore goes negative in Slice 1. That is correct double-entry: it records that the platform owes users money it has not yet received on chain. Slice 2's deposit crediting will move `hot_wallet` back to a true on-chain figure.

- [ ] **Step 1: Write the failing test**

`tests/admin/credit.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { creditUser } from '@/lib/admin/credit'
import { userBalance, houseAccount, balanceOf } from '@/lib/ledger/accounts'

describe('creditUser', () => {
  let db: Db
  let user: string
  let admin: string

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
    user = await makeUser(db)
    admin = await makeAdmin(db)
  })

  it('credits the user and debits the hot wallet', async () => {
    await creditUser(db, { userId: user, amount: 100_000_000n, reference: 'seed-1', creditedBy: admin })

    expect(await userBalance(db, user)).toBe(100_000_000n)
    expect(await balanceOf(db, await houseAccount(db, 'hot_wallet'))).toBe(-100_000_000n)
  })

  it('is idempotent on the reference', async () => {
    const first = await creditUser(db, { userId: user, amount: 5_000_000n, reference: 'dup', creditedBy: admin })
    const second = await creditUser(db, { userId: user, amount: 5_000_000n, reference: 'dup', creditedBy: admin })

    expect(second.replayed).toBe(true)
    expect(second.txId).toBe(first.txId)
    expect(await userBalance(db, user)).toBe(5_000_000n)
  })

  it('rejects a zero or negative amount', async () => {
    for (const amount of [0n, -1n]) {
      await expect(
        creditUser(db, { userId: user, amount, reference: `bad-${amount}`, creditedBy: admin }),
      ).rejects.toMatchObject({ code: 'NON_POSITIVE' })
    }
    expect(await userBalance(db, user)).toBe(0n)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/admin/credit.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/admin/credit"`.

- [ ] **Step 3: Write the implementation**

`src/lib/admin/credit.ts`:

```ts
import type { Executor } from '@/lib/db/client'
import { houseAccount, userAvailableAccount } from '@/lib/ledger/accounts'
import { postTransaction, type PostResult } from '@/lib/ledger/post'

export class CreditError extends Error {
  constructor(
    message: string,
    readonly code: 'NON_POSITIVE',
  ) {
    super(message)
    this.name = 'CreditError'
  }
}

export type CreditArgs = {
  userId: string
  amount: bigint
  reference: string
  creditedBy: string
}

export async function creditUser(x: Executor, args: CreditArgs): Promise<PostResult> {
  if (args.amount <= 0n) {
    throw new CreditError(`credit amount must be positive, got ${args.amount}`, 'NON_POSITIVE')
  }

  const [userAccount, hotWallet] = await Promise.all([
    userAvailableAccount(x, args.userId),
    houseAccount(x, 'hot_wallet'),
  ])

  return postTransaction(x, {
    kind: 'ADMIN_CREDIT',
    idempotencyKey: `credit:${args.reference}`,
    metadata: { userId: args.userId, creditedBy: args.creditedBy, reference: args.reference },
    legs: [
      { accountId: hotWallet, amount: -args.amount },
      { accountId: userAccount, amount: args.amount },
    ],
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/admin/credit.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/admin tests/admin
git commit -m "feat: idempotent admin credit as the deposit stand-in"
git push origin main
```

---

## Task 7: Bet placement

This is the first of the two places where getting it wrong costs users money. The row lock on the fight is what makes concurrent bets at the closing bell correct rather than approximately correct.

**Files:**
- Create: `src/lib/bets/place.ts`
- Test: `tests/bets/place.test.ts`

**Interfaces:**
- Consumes: `Db`, `getFight`, `poolAccount`, `userAvailableAccount`, `balanceOf`, `postTransaction`, `MIN_STAKE_MICROS`
- Produces (`src/lib/bets/place.ts`):
  - `class BetError extends Error { code: 'FIGHT_NOT_OPEN' | 'FIGHT_LOCKED' | 'INSUFFICIENT_FUNDS' | 'STAKE_BELOW_MINIMUM' | 'FIGHT_NOT_FOUND' }`
  - `type PlaceBetArgs = { userId: string; fightId: string; side: Side; stake: bigint; idempotencyKey: string }`
  - `type PlaceBetResult = { betId: string; replayed: boolean }`
  - `placeBet(db: Db, args: PlaceBetArgs): Promise<PlaceBetResult>` — takes a `Db`, not an `Executor`, because it opens its own transaction
  - `listUserBets(x: Executor, userId: string): Promise<UserBet[]>` where `UserBet = { id, fightId, leagueName, fighterA, fighterB, side, stake, payout, fightStatus, outcome, createdAt }`

- [ ] **Step 1: Write the failing test**

`tests/bets/place.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { createFight, publishFight, poolTotals, type Fight } from '@/lib/fights/repo'
import { creditUser } from '@/lib/admin/credit'
import { placeBet, listUserBets } from '@/lib/bets/place'
import { userBalance, balanceOf, poolAccount } from '@/lib/ledger/accounts'

const HOUR = 60 * 60 * 1000
const USDT = 1_000_000n

describe('placeBet', () => {
  let db: Db
  let user: string
  let admin: string
  let fight: Fight

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })
    fight = await createFight(db, {
      leagueName: 'Robot League',
      fighterA: 'Crusher',
      fighterB: 'Bolt',
      lockAt: new Date(Date.now() + HOUR),
      createdBy: admin,
    })
    await publishFight(db, fight.id)
  })

  it('moves stake from the user to the pool', async () => {
    await placeBet(db, { userId: user, fightId: fight.id, side: 'A', stake: 25n * USDT, idempotencyKey: 'b1' })

    expect(await userBalance(db, user)).toBe(75n * USDT)
    expect(await balanceOf(db, await poolAccount(db, fight.id))).toBe(25n * USDT)
    expect(await poolTotals(db, fight.id)).toEqual({ total: 25n * USDT, a: 25n * USDT, b: 0n })
  })

  it('is idempotent on the client key', async () => {
    const first = await placeBet(db, { userId: user, fightId: fight.id, side: 'A', stake: 10n * USDT, idempotencyKey: 'same' })
    const second = await placeBet(db, { userId: user, fightId: fight.id, side: 'A', stake: 10n * USDT, idempotencyKey: 'same' })

    expect(second.replayed).toBe(true)
    expect(second.betId).toBe(first.betId)
    expect(await userBalance(db, user)).toBe(90n * USDT)
  })

  it('rejects a stake below the 1 USDT minimum', async () => {
    await expect(
      placeBet(db, { userId: user, fightId: fight.id, side: 'A', stake: 999_999n, idempotencyKey: 'small' }),
    ).rejects.toMatchObject({ code: 'STAKE_BELOW_MINIMUM' })
    expect(await userBalance(db, user)).toBe(100n * USDT)
  })

  it('rejects a stake larger than the balance', async () => {
    await expect(
      placeBet(db, { userId: user, fightId: fight.id, side: 'B', stake: 101n * USDT, idempotencyKey: 'big' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' })
    expect(await userBalance(db, user)).toBe(100n * USDT)
  })

  it('rejects a bet on a DRAFT fight', async () => {
    const draft = await createFight(db, {
      leagueName: 'L', fighterA: 'A', fighterB: 'B',
      lockAt: new Date(Date.now() + HOUR), createdBy: admin,
    })
    await expect(
      placeBet(db, { userId: user, fightId: draft.id, side: 'A', stake: 5n * USDT, idempotencyKey: 'draft' }),
    ).rejects.toMatchObject({ code: 'FIGHT_NOT_OPEN' })
  })

  it('rejects a bet once lock_at has passed, even while status is still OPEN', async () => {
    await db.execute(sql`UPDATE fights SET lock_at = now() - interval '1 second' WHERE id = ${fight.id}`)

    await expect(
      placeBet(db, { userId: user, fightId: fight.id, side: 'A', stake: 5n * USDT, idempotencyKey: 'late' }),
    ).rejects.toMatchObject({ code: 'FIGHT_LOCKED' })
    expect(await userBalance(db, user)).toBe(100n * USDT)
  })

  it('rejects a bet on an unknown fight', async () => {
    await expect(
      placeBet(db, {
        userId: user,
        fightId: '00000000-0000-0000-0000-000000000000',
        side: 'A',
        stake: 5n * USDT,
        idempotencyKey: 'ghost',
      }),
    ).rejects.toMatchObject({ code: 'FIGHT_NOT_FOUND' })
  })

  it('never overdrafts under concurrent bets', async () => {
    // 100 USDT of balance, 20 concurrent attempts at 10 USDT: exactly 10 may succeed.
    const attempts = Array.from({ length: 20 }, (_, i) =>
      placeBet(db, {
        userId: user,
        fightId: fight.id,
        side: i % 2 === 0 ? 'A' : 'B',
        stake: 10n * USDT,
        idempotencyKey: `race-${i}`,
      }).then(
        () => 'ok' as const,
        () => 'rejected' as const,
      ),
    )

    const results = await Promise.all(attempts)
    expect(results.filter((r) => r === 'ok')).toHaveLength(10)
    expect(await userBalance(db, user)).toBe(0n)
    expect((await poolTotals(db, fight.id)).total).toBe(100n * USDT)
  })

  it('lists a user\'s bets with fight context', async () => {
    await placeBet(db, { userId: user, fightId: fight.id, side: 'B', stake: 3n * USDT, idempotencyKey: 'hist' })
    const listed = await listUserBets(db, user)

    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      fightId: fight.id,
      side: 'B',
      stake: 3n * USDT,
      payout: null,
      fightStatus: 'OPEN',
      fighterA: 'Crusher',
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/bets/place.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/bets/place"`.

- [ ] **Step 3: Write the implementation**

`src/lib/bets/place.ts`. The order inside the transaction matters and is the whole point of the module: take the row lock first, re-check status and time under that lock, then check the balance from the ledger, then write.

```ts
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db, Executor } from '@/lib/db/client'
import { bets, fights } from '@/lib/db/schema'
import { MIN_STAKE_MICROS } from '@/lib/money/units'
import { balanceOf, poolAccount, userAvailableAccount } from '@/lib/ledger/accounts'
import { postTransaction } from '@/lib/ledger/post'
import type { Side, FightStatus, Outcome } from '@/lib/fights/repo'

export class BetError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'FIGHT_NOT_FOUND'
      | 'FIGHT_NOT_OPEN'
      | 'FIGHT_LOCKED'
      | 'INSUFFICIENT_FUNDS'
      | 'STAKE_BELOW_MINIMUM',
  ) {
    super(message)
    this.name = 'BetError'
  }
}

export type PlaceBetArgs = {
  userId: string
  fightId: string
  side: Side
  stake: bigint
  idempotencyKey: string
}

export type PlaceBetResult = { betId: string; replayed: boolean }

export async function placeBet(db: Db, args: PlaceBetArgs): Promise<PlaceBetResult> {
  if (args.stake < MIN_STAKE_MICROS) {
    throw new BetError(
      `stake ${args.stake} is below the ${MIN_STAKE_MICROS} micro-unit minimum`,
      'STAKE_BELOW_MINIMUM',
    )
  }

  return db.transaction(async (tx) => {
    // Replay check before anything else: a retried request must not re-lock or re-charge.
    const existing = await tx
      .select({ id: bets.id })
      .from(bets)
      .where(eq(bets.idempotencyKey, args.idempotencyKey))
      .limit(1)
    if (existing.length) return { betId: existing[0].id, replayed: true }

    // Serialise every bet on this fight against every other one. The lock-time comparison
    // happens in SQL so it uses the database clock and needs no extra round trip.
    // (A `SELECT now()` through raw `execute` returns a string, not a Date.)
    const locked = await tx
      .select({
        id: fights.id,
        status: fights.status,
        lockAt: fights.lockAt,
        pastLock: sql<boolean>`${fights.lockAt} <= now()`,
      })
      .from(fights)
      .where(eq(fights.id, args.fightId))
      .for('update')
      .limit(1)

    if (!locked.length) throw new BetError(`fight ${args.fightId} not found`, 'FIGHT_NOT_FOUND')
    const fight = locked[0]

    if (fight.status !== 'OPEN') {
      throw new BetError(`fight ${args.fightId} is ${fight.status}, not OPEN`, 'FIGHT_NOT_OPEN')
    }

    if (fight.pastLock) {
      throw new BetError(`fight ${args.fightId} locked at ${fight.lockAt}`, 'FIGHT_LOCKED')
    }

    const userAccount = await userAvailableAccount(tx, args.userId)
    const available = await balanceOf(tx, userAccount)
    if (available < args.stake) {
      throw new BetError(
        `balance ${available} is less than stake ${args.stake}`,
        'INSUFFICIENT_FUNDS',
      )
    }

    const pool = await poolAccount(tx, args.fightId)
    await postTransaction(tx, {
      kind: 'BET',
      idempotencyKey: `bet:${args.idempotencyKey}`,
      metadata: { userId: args.userId, fightId: args.fightId, side: args.side },
      legs: [
        { accountId: userAccount, amount: -args.stake },
        { accountId: pool, amount: args.stake },
      ],
    })

    const [created] = await tx
      .insert(bets)
      .values({
        fightId: args.fightId,
        userId: args.userId,
        side: args.side,
        stake: args.stake,
        idempotencyKey: args.idempotencyKey,
      })
      .returning({ id: bets.id })

    return { betId: created.id, replayed: false }
  })
}

export type UserBet = {
  id: string
  fightId: string
  leagueName: string
  fighterA: string
  fighterB: string
  side: Side
  stake: bigint
  payout: bigint | null
  fightStatus: FightStatus
  outcome: Outcome | null
  createdAt: Date
}

export async function listUserBets(x: Executor, userId: string): Promise<UserBet[]> {
  const rows = await x
    .select({
      id: bets.id,
      fightId: bets.fightId,
      leagueName: fights.leagueName,
      fighterA: fights.fighterA,
      fighterB: fights.fighterB,
      side: bets.side,
      stake: bets.stake,
      payout: bets.payout,
      fightStatus: fights.status,
      outcome: fights.outcome,
      createdAt: bets.createdAt,
    })
    .from(bets)
    .innerJoin(fights, eq(fights.id, bets.fightId))
    .where(eq(bets.userId, userId))
    .orderBy(desc(bets.createdAt))

  return rows as UserBet[]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/bets/place.test.ts
pnpm typecheck
```

Expected: PASS, 9 tests. The concurrency test is the one that matters — if it is flaky, the row lock is not being taken and the bug is real.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/bets tests/bets
git commit -m "feat: bet placement with row-locked balance and lock-time enforcement"
git push origin main
```

---

## Task 8: Settlement math (pure)

The highest-risk code in the system. It has no database access, so it can be hammered with property-based tests over thousands of generated pools.

**Files:**
- Create: `src/lib/settlement/math.ts`
- Test: `tests/settlement/math.test.ts`

**Interfaces:**
- Consumes: nothing (pure module)
- Produces (`src/lib/settlement/math.ts`):
  - `type SettlementBet = { id: string; side: Side; stake: bigint }`
  - `type SettlementInput = { outcome: Outcome; rakeBps: number; bets: SettlementBet[] }`
  - `type Payout = { betId: string; amount: bigint }`
  - `type SettlementResult = { refunded: boolean; poolTotal: bigint; winningPool: bigint; rake: bigint; dust: bigint; payouts: Payout[] }`
  - `computeSettlement(input: SettlementInput): SettlementResult`
  - `class SettlementMathError extends Error { code: 'INVARIANT_VIOLATED' | 'INVALID_RAKE' | 'INVALID_STAKE' }`

- [ ] **Step 1: Write the failing test**

`tests/settlement/math.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { computeSettlement, type SettlementBet } from '@/lib/settlement/math'
import type { Outcome, Side } from '@/lib/fights/repo'

const USDT = 1_000_000n
const bet = (id: string, side: Side, stake: bigint): SettlementBet => ({ id, side, stake })

describe('computeSettlement — worked examples', () => {
  it('splits the distributable pool in proportion to winning stake', () => {
    // 100 USDT pool: 25 on A (winner), 75 on B. 5% rake -> 95 distributable.
    const result = computeSettlement({
      outcome: 'A',
      rakeBps: 500,
      bets: [bet('a1', 'A', 10n * USDT), bet('a2', 'A', 15n * USDT), bet('b1', 'B', 75n * USDT)],
    })

    expect(result.refunded).toBe(false)
    expect(result.poolTotal).toBe(100n * USDT)
    expect(result.winningPool).toBe(25n * USDT)
    expect(result.rake).toBe(5n * USDT)
    expect(result.payouts).toEqual([
      { betId: 'a1', amount: 38n * USDT },
      { betId: 'a2', amount: 57n * USDT },
    ])
    expect(result.dust).toBe(0n)
  })

  it('sends integer-division remainder to dust', () => {
    // 10 USDT pool, zero rake, 3 equal winning stakes of 1 USDT -> 10_000_000 / 3 each.
    const result = computeSettlement({
      outcome: 'A',
      rakeBps: 0,
      bets: [
        bet('a1', 'A', 1n * USDT),
        bet('a2', 'A', 1n * USDT),
        bet('a3', 'A', 1n * USDT),
        bet('b1', 'B', 7n * USDT),
      ],
    })

    expect(result.payouts.map((p) => p.amount)).toEqual([3_333_333n, 3_333_333n, 3_333_333n])
    expect(result.dust).toBe(1n)
    expect(result.rake).toBe(0n)
  })

  it('refunds every stake on VOID', () => {
    const result = computeSettlement({
      outcome: 'VOID',
      rakeBps: 500,
      bets: [bet('a1', 'A', 10n * USDT), bet('b1', 'B', 40n * USDT)],
    })

    expect(result.refunded).toBe(true)
    expect(result.rake).toBe(0n)
    expect(result.dust).toBe(0n)
    expect(result.payouts).toEqual([
      { betId: 'a1', amount: 10n * USDT },
      { betId: 'b1', amount: 40n * USDT },
    ])
  })

  it('refunds when nobody backed the winner', () => {
    const result = computeSettlement({
      outcome: 'A',
      rakeBps: 500,
      bets: [bet('b1', 'B', 40n * USDT), bet('b2', 'B', 10n * USDT)],
    })

    expect(result.refunded).toBe(true)
    expect(result.winningPool).toBe(0n)
    expect(result.payouts.map((p) => p.amount)).toEqual([40n * USDT, 10n * USDT])
  })

  it('refunds when every stake was on the winning side', () => {
    // Without this case the winners would be paid 0.95x their own money back.
    const result = computeSettlement({
      outcome: 'A',
      rakeBps: 500,
      bets: [bet('a1', 'A', 30n * USDT), bet('a2', 'A', 10n * USDT)],
    })

    expect(result.refunded).toBe(true)
    expect(result.rake).toBe(0n)
    expect(result.payouts).toEqual([
      { betId: 'a1', amount: 30n * USDT },
      { betId: 'a2', amount: 10n * USDT },
    ])
  })

  it('handles a fight with no bets at all', () => {
    const result = computeSettlement({ outcome: 'A', rakeBps: 500, bets: [] })
    expect(result).toEqual({
      refunded: true,
      poolTotal: 0n,
      winningPool: 0n,
      rake: 0n,
      dust: 0n,
      payouts: [],
    })
  })

  it('rejects a stake below 1 micro-unit', () => {
    expect(() => computeSettlement({ outcome: 'A', rakeBps: 500, bets: [bet('x', 'A', 0n)] })).toThrow(
      /stake/,
    )
  })

  it('rejects a rake outside 0..2000 bps', () => {
    expect(() => computeSettlement({ outcome: 'A', rakeBps: 2001, bets: [] })).toThrow(/rake/)
  })
})

describe('computeSettlement — properties', () => {
  const arbBets = fc.array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 8 }),
      side: fc.constantFrom<Side>('A', 'B'),
      stake: fc.bigInt({ min: 1n, max: 10n ** 15n }),
    }),
    { maxLength: 60 },
  )

  const arbInput = fc.record({
    outcome: fc.constantFrom<Outcome>('A', 'B', 'VOID'),
    rakeBps: fc.integer({ min: 0, max: 2000 }),
    bets: arbBets,
  })

  it('conserves the pool exactly: sum(payouts) + rake + dust === poolTotal', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const r = computeSettlement({
          ...input,
          bets: input.bets.map((b, i) => ({ ...b, id: `${i}` })),
        })
        const paid = r.payouts.reduce((acc, p) => acc + p.amount, 0n)
        expect(paid + r.rake + r.dust).toBe(r.poolTotal)
      }),
      { numRuns: 2000 },
    )
  })

  it('never produces a negative payout, rake, or dust', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const r = computeSettlement({
          ...input,
          bets: input.bets.map((b, i) => ({ ...b, id: `${i}` })),
        })
        expect(r.rake >= 0n).toBe(true)
        expect(r.dust >= 0n).toBe(true)
        for (const p of r.payouts) expect(p.amount >= 0n).toBe(true)
      }),
      { numRuns: 2000 },
    )
  })

  it('pays only bets on the winning side, unless refunding', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const bets = input.bets.map((b, i) => ({ ...b, id: `${i}` }))
        const r = computeSettlement({ ...input, bets })
        if (r.refunded) {
          expect(r.payouts.map((p) => p.betId)).toEqual(bets.map((b) => b.id))
        } else {
          const winners = new Set(bets.filter((b) => b.side === input.outcome).map((b) => b.id))
          for (const p of r.payouts) expect(winners.has(p.betId)).toBe(true)
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('refunds exactly the three specified cases', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const bets = input.bets.map((b, i) => ({ ...b, id: `${i}` }))
        const r = computeSettlement({ ...input, bets })
        const expectRefund =
          input.outcome === 'VOID' || r.winningPool === 0n || r.winningPool === r.poolTotal
        expect(r.refunded).toBe(expectRefund)
      }),
      { numRuns: 2000 },
    )
  })

  it('returns every stake at face value when refunding', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const bets = input.bets.map((b, i) => ({ ...b, id: `${i}` }))
        const r = computeSettlement({ ...input, bets })
        fc.pre(r.refunded)
        const byId = new Map(bets.map((b) => [b.id, b.stake]))
        for (const p of r.payouts) expect(p.amount).toBe(byId.get(p.betId))
        expect(r.rake).toBe(0n)
        expect(r.dust).toBe(0n)
      }),
      { numRuns: 2000 },
    )
  })

  it('leaves dust strictly smaller than the number of winning bets', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const bets = input.bets.map((b, i) => ({ ...b, id: `${i}` }))
        const r = computeSettlement({ ...input, bets })
        fc.pre(!r.refunded)
        expect(r.dust < BigInt(r.payouts.length)).toBe(true)
      }),
      { numRuns: 2000 },
    )
  })

  it('pays a winner less than their stake only when rake exceeds the losing pool', () => {
    // The single accepted way a winner can lose money — see "Known property" in the plan header.
    fc.assert(
      fc.property(arbInput, (input) => {
        const bets = input.bets.map((b, i) => ({ ...b, id: `${i}` }))
        const r = computeSettlement({ ...input, bets })
        fc.pre(!r.refunded)
        const byId = new Map(bets.map((b) => [b.id, b.stake]))
        const shortfall = r.payouts.some((p) => p.amount < byId.get(p.betId)!)
        if (shortfall) {
          const losingPool = r.poolTotal - r.winningPool
          expect(r.rake >= losingPool || r.dust > 0n).toBe(true)
        }
      }),
      { numRuns: 2000 },
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/settlement/math.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/settlement/math"`.

- [ ] **Step 3: Write the implementation**

`src/lib/settlement/math.ts`. Every division is `BigInt` division on non-negative operands, so it floors. The invariant is asserted before returning, not left to the caller.

```ts
import type { Outcome, Side } from '@/lib/fights/repo'

export type SettlementBet = { id: string; side: Side; stake: bigint }

export type SettlementInput = {
  outcome: Outcome
  rakeBps: number
  bets: SettlementBet[]
}

export type Payout = { betId: string; amount: bigint }

export type SettlementResult = {
  refunded: boolean
  poolTotal: bigint
  winningPool: bigint
  rake: bigint
  dust: bigint
  payouts: Payout[]
}

export class SettlementMathError extends Error {
  constructor(
    message: string,
    readonly code: 'INVARIANT_VIOLATED' | 'INVALID_RAKE' | 'INVALID_STAKE',
  ) {
    super(message)
    this.name = 'SettlementMathError'
  }
}

export function computeSettlement(input: SettlementInput): SettlementResult {
  if (!Number.isInteger(input.rakeBps) || input.rakeBps < 0 || input.rakeBps > 2000) {
    throw new SettlementMathError(`rake_bps must be an integer in 0..2000, got ${input.rakeBps}`, 'INVALID_RAKE')
  }
  for (const b of input.bets) {
    if (b.stake <= 0n) {
      throw new SettlementMathError(`bet ${b.id} has non-positive stake ${b.stake}`, 'INVALID_STAKE')
    }
  }

  const poolTotal = input.bets.reduce((acc, b) => acc + b.stake, 0n)
  const winners = input.outcome === 'VOID' ? [] : input.bets.filter((b) => b.side === input.outcome)
  const winningPool = winners.reduce((acc, b) => acc + b.stake, 0n)

  // Three cases collapse to a full refund at face value with no rake.
  const refunded =
    input.outcome === 'VOID' || winningPool === 0n || winningPool === poolTotal

  const result: SettlementResult = refunded
    ? {
        refunded: true,
        poolTotal,
        winningPool,
        rake: 0n,
        dust: 0n,
        payouts: input.bets.map((b) => ({ betId: b.id, amount: b.stake })),
      }
    : (() => {
        const rake = (poolTotal * BigInt(input.rakeBps)) / 10000n
        const distributable = poolTotal - rake
        const payouts = winners.map((b) => ({
          betId: b.id,
          amount: (distributable * b.stake) / winningPool,
        }))
        const paid = payouts.reduce((acc, p) => acc + p.amount, 0n)
        return { refunded: false, poolTotal, winningPool, rake, dust: distributable - paid, payouts }
      })()

  const total = result.payouts.reduce((acc, p) => acc + p.amount, 0n) + result.rake + result.dust
  if (total !== poolTotal) {
    throw new SettlementMathError(
      `settlement does not conserve the pool: paid+rake+dust=${total}, poolTotal=${poolTotal}`,
      'INVARIANT_VIOLATED',
    )
  }

  return result
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/settlement/math.test.ts
```

Expected: PASS, 15 tests, ~14,000 generated pools. If fast-check reports a counterexample, do not weaken the property — the counterexample is the bug.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/settlement/math.ts tests/settlement/math.test.ts
git commit -m "feat: integer pari-mutuel settlement math with property-based proofs"
git push origin main
```

---

## Task 9: Settlement transaction

Wraps the pure math in one database transaction keyed by `fight_id`. A double-clicked settle button must produce exactly one payout.

**Files:**
- Create: `src/lib/settlement/settle.ts`
- Test: `tests/settlement/settle.test.ts`

**Interfaces:**
- Consumes: `Db`, `computeSettlement`, `postTransaction`, `poolAccount`, `userAvailableAccount`, `houseAccount`, `balanceOf`
- Produces (`src/lib/settlement/settle.ts`):
  - `class SettleError extends Error { code: 'FIGHT_NOT_FOUND' | 'NOT_SETTLEABLE' | 'POOL_NOT_DRAINED' }`
  - `type SettleArgs = { fightId: string; outcome: Outcome; settledBy: string }`
  - `settleFight(db: Db, args: SettleArgs): Promise<SettlementResult & { replayed: boolean }>`

Rules enforced here, not in the API layer:
- `outcome` of `'A'` or `'B'` requires the fight to be `LOCKED`.
- `outcome` of `'VOID'` is allowed from `OPEN` or `LOCKED`.
- The fight row is taken `FOR UPDATE` so a bet cannot slip in beside a settlement.
- Ledger legs are aggregated per account (a user with several winning bets gets one entry); per-bet detail lives on `bets.payout`.
- After posting, the pool account balance must be exactly zero. If it is not, the transaction aborts.

- [ ] **Step 1: Write the failing test**

`tests/settlement/settle.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { bets as betsTable } from '@/lib/db/schema'
import { createFight, publishFight, lockFight, getFight, type Fight } from '@/lib/fights/repo'
import { creditUser } from '@/lib/admin/credit'
import { placeBet } from '@/lib/bets/place'
import { settleFight } from '@/lib/settlement/settle'
import { userBalance, balanceOf, poolAccount, houseAccount } from '@/lib/ledger/accounts'

const HOUR = 60 * 60 * 1000
const USDT = 1_000_000n

describe('settleFight', () => {
  let db: Db
  let admin: string
  let alice: string
  let bob: string
  let fight: Fight

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    alice = await makeUser(db)
    bob = await makeUser(db)
    await creditUser(db, { userId: alice, amount: 100n * USDT, reference: 'a', creditedBy: admin })
    await creditUser(db, { userId: bob, amount: 100n * USDT, reference: 'b', creditedBy: admin })

    fight = await createFight(db, {
      leagueName: 'Robot League',
      fighterA: 'Crusher',
      fighterB: 'Bolt',
      lockAt: new Date(Date.now() + HOUR),
      createdBy: admin,
    })
    await publishFight(db, fight.id)
  })

  async function lockNow() {
    await db.execute(sql`UPDATE fights SET lock_at = now() - interval '1 second' WHERE id = ${fight.id}`)
    await lockFight(db, fight.id)
  }

  it('pays winners, takes rake, drains the pool, and marks the fight SETTLED', async () => {
    await placeBet(db, { userId: alice, fightId: fight.id, side: 'A', stake: 25n * USDT, idempotencyKey: 'a1' })
    await placeBet(db, { userId: bob, fightId: fight.id, side: 'B', stake: 75n * USDT, idempotencyKey: 'b1' })
    await lockNow()

    const result = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    expect(result.refunded).toBe(false)
    expect(result.rake).toBe(5n * USDT)
    expect(await userBalance(db, alice)).toBe(75n * USDT + 95n * USDT)
    expect(await userBalance(db, bob)).toBe(25n * USDT)
    expect(await balanceOf(db, await poolAccount(db, fight.id))).toBe(0n)
    expect(await balanceOf(db, await houseAccount(db, 'house_rake'))).toBe(5n * USDT)

    const settled = await getFight(db, fight.id)
    expect(settled.status).toBe('SETTLED')
    expect(settled.outcome).toBe('A')
    expect(settled.settledAt).not.toBeNull()
  })

  it('records the payout on each winning bet and zero on each losing bet', async () => {
    await placeBet(db, { userId: alice, fightId: fight.id, side: 'A', stake: 25n * USDT, idempotencyKey: 'a1' })
    await placeBet(db, { userId: bob, fightId: fight.id, side: 'B', stake: 75n * USDT, idempotencyKey: 'b1' })
    await lockNow()
    await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    const rows = await db.select().from(betsTable).where(eq(betsTable.fightId, fight.id))
    const byKey = new Map(rows.map((r) => [r.idempotencyKey, r.payout]))
    expect(byKey.get('a1')).toBe(95n * USDT)
    expect(byKey.get('b1')).toBe(0n)
  })

  it('refunds everyone and takes no rake on VOID', async () => {
    await placeBet(db, { userId: alice, fightId: fight.id, side: 'A', stake: 25n * USDT, idempotencyKey: 'a1' })
    await placeBet(db, { userId: bob, fightId: fight.id, side: 'B', stake: 75n * USDT, idempotencyKey: 'b1' })
    await lockNow()

    const result = await settleFight(db, { fightId: fight.id, outcome: 'VOID', settledBy: admin })

    expect(result.refunded).toBe(true)
    expect(await userBalance(db, alice)).toBe(100n * USDT)
    expect(await userBalance(db, bob)).toBe(100n * USDT)
    expect(await balanceOf(db, await houseAccount(db, 'house_rake'))).toBe(0n)
    expect((await getFight(db, fight.id)).status).toBe('VOIDED')
  })

  it('voids an OPEN fight without locking it first', async () => {
    await placeBet(db, { userId: alice, fightId: fight.id, side: 'A', stake: 10n * USDT, idempotencyKey: 'a1' })

    await settleFight(db, { fightId: fight.id, outcome: 'VOID', settledBy: admin })

    expect(await userBalance(db, alice)).toBe(100n * USDT)
    expect((await getFight(db, fight.id)).status).toBe('VOIDED')
  })

  it('refunds when every stake was on the winning side', async () => {
    await placeBet(db, { userId: alice, fightId: fight.id, side: 'A', stake: 30n * USDT, idempotencyKey: 'a1' })
    await placeBet(db, { userId: bob, fightId: fight.id, side: 'A', stake: 10n * USDT, idempotencyKey: 'b1' })
    await lockNow()

    const result = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    expect(result.refunded).toBe(true)
    expect(await userBalance(db, alice)).toBe(100n * USDT)
    expect(await userBalance(db, bob)).toBe(100n * USDT)
    expect(await balanceOf(db, await houseAccount(db, 'house_rake'))).toBe(0n)
  })

  it('refunds when nobody backed the winner', async () => {
    await placeBet(db, { userId: alice, fightId: fight.id, side: 'B', stake: 30n * USDT, idempotencyKey: 'a1' })
    await lockNow()

    const result = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    expect(result.refunded).toBe(true)
    expect(await userBalance(db, alice)).toBe(100n * USDT)
  })

  it('settles a fight with no bets at all', async () => {
    await lockNow()
    const result = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })
    expect(result.poolTotal).toBe(0n)
    expect((await getFight(db, fight.id)).status).toBe('SETTLED')
  })

  it('is idempotent: a second settle pays nothing more', async () => {
    await placeBet(db, { userId: alice, fightId: fight.id, side: 'A', stake: 25n * USDT, idempotencyKey: 'a1' })
    await placeBet(db, { userId: bob, fightId: fight.id, side: 'B', stake: 75n * USDT, idempotencyKey: 'b1' })
    await lockNow()

    const first = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })
    const second = await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    expect(second.replayed).toBe(true)
    expect(second.payouts).toEqual(first.payouts)
    expect(await userBalance(db, alice)).toBe(170n * USDT)
  })

  it('is idempotent under two concurrent settle calls', async () => {
    await placeBet(db, { userId: alice, fightId: fight.id, side: 'A', stake: 25n * USDT, idempotencyKey: 'a1' })
    await placeBet(db, { userId: bob, fightId: fight.id, side: 'B', stake: 75n * USDT, idempotencyKey: 'b1' })
    await lockNow()

    const both = await Promise.allSettled([
      settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin }),
      settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin }),
    ])

    expect(both.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1)
    expect(await userBalance(db, alice)).toBe(170n * USDT)
    expect(await balanceOf(db, await poolAccount(db, fight.id))).toBe(0n)
  })

  it('refuses to settle an OPEN fight with a real outcome', async () => {
    await expect(
      settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin }),
    ).rejects.toMatchObject({ code: 'NOT_SETTLEABLE' })
  })

  it('refuses to settle a DRAFT fight', async () => {
    const draft = await createFight(db, {
      leagueName: 'L', fighterA: 'A', fighterB: 'B',
      lockAt: new Date(Date.now() + HOUR), createdBy: admin,
    })
    await expect(
      settleFight(db, { fightId: draft.id, outcome: 'VOID', settledBy: admin }),
    ).rejects.toMatchObject({ code: 'NOT_SETTLEABLE' })
  })

  it('refuses an unknown fight', async () => {
    await expect(
      settleFight(db, {
        fightId: '00000000-0000-0000-0000-000000000000',
        outcome: 'VOID',
        settledBy: admin,
      }),
    ).rejects.toMatchObject({ code: 'FIGHT_NOT_FOUND' })
  })

  it('leaves the ledger balanced across the whole lifecycle', async () => {
    await placeBet(db, { userId: alice, fightId: fight.id, side: 'A', stake: 33n * USDT, idempotencyKey: 'a1' })
    await placeBet(db, { userId: bob, fightId: fight.id, side: 'B', stake: 67n * USDT, idempotencyKey: 'b1' })
    await lockNow()
    await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    const unbalanced = await db.execute<{ tx_id: string }>(sql`
      SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0
    `)
    expect(unbalanced.rows).toEqual([])

    const grandTotal = await db.execute<{ total: string }>(
      sql`SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries`,
    )
    expect(BigInt(grandTotal.rows[0].total)).toBe(0n)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/settlement/settle.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/settlement/settle"`.

- [ ] **Step 3: Write the implementation**

`src/lib/settlement/settle.ts`:

```ts
import { eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { bets, fights, settlements } from '@/lib/db/schema'
import { balanceOf, houseAccount, poolAccount, userAvailableAccount } from '@/lib/ledger/accounts'
import { postTransaction, type Leg } from '@/lib/ledger/post'
import type { Outcome, Side } from '@/lib/fights/repo'
import { computeSettlement, type SettlementResult } from './math'

export class SettleError extends Error {
  constructor(
    message: string,
    readonly code: 'FIGHT_NOT_FOUND' | 'NOT_SETTLEABLE' | 'POOL_NOT_DRAINED',
  ) {
    super(message)
    this.name = 'SettleError'
  }
}

export type SettleArgs = { fightId: string; outcome: Outcome; settledBy: string }

export async function settleFight(
  db: Db,
  args: SettleArgs,
): Promise<SettlementResult & { replayed: boolean }> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: fights.id, status: fights.status, rakeBps: fights.rakeBps })
      .from(fights)
      .where(eq(fights.id, args.fightId))
      .for('update')
      .limit(1)

    if (!locked.length) throw new SettleError(`fight ${args.fightId} not found`, 'FIGHT_NOT_FOUND')
    const fight = locked[0]

    // Replay: the settlements table is uniquely keyed by fight_id.
    const prior = await tx
      .select()
      .from(settlements)
      .where(eq(settlements.fightId, args.fightId))
      .limit(1)

    if (prior.length) {
      const paid = await tx
        .select({ id: bets.id, payout: bets.payout })
        .from(bets)
        .where(eq(bets.fightId, args.fightId))
        .orderBy(bets.createdAt, bets.id)
      return {
        replayed: true,
        refunded: prior[0].refunded,
        poolTotal: prior[0].poolTotal,
        winningPool: prior[0].winningPool,
        rake: prior[0].rake,
        dust: prior[0].dust,
        payouts: paid
          .filter((b) => (b.payout ?? 0n) > 0n)
          .map((b) => ({ betId: b.id, amount: b.payout as bigint })),
      }
    }

    const settleable =
      args.outcome === 'VOID'
        ? fight.status === 'OPEN' || fight.status === 'LOCKED'
        : fight.status === 'LOCKED'

    if (!settleable) {
      throw new SettleError(
        `fight ${args.fightId} is ${fight.status}; cannot settle with outcome ${args.outcome}`,
        'NOT_SETTLEABLE',
      )
    }

    // Ordered so a replay returns payouts in the same order as the original call.
    const placed = await tx
      .select({ id: bets.id, userId: bets.userId, side: bets.side, stake: bets.stake })
      .from(bets)
      .where(eq(bets.fightId, args.fightId))
      .orderBy(bets.createdAt, bets.id)

    const result = computeSettlement({
      outcome: args.outcome,
      rakeBps: fight.rakeBps,
      bets: placed.map((b) => ({ id: b.id, side: b.side as Side, stake: b.stake })),
    })

    // Aggregate payouts per user account; per-bet detail is written to bets.payout below.
    const userOf = new Map(placed.map((b) => [b.id, b.userId]))
    const perUser = new Map<string, bigint>()
    for (const p of result.payouts) {
      const userId = userOf.get(p.betId)!
      perUser.set(userId, (perUser.get(userId) ?? 0n) + p.amount)
    }

    const pool = await poolAccount(tx, args.fightId)
    const legs: Leg[] = [{ accountId: pool, amount: -result.poolTotal }]

    for (const [userId, amount] of perUser) {
      legs.push({ accountId: await userAvailableAccount(tx, userId), amount })
    }
    if (result.rake > 0n) {
      legs.push({ accountId: await houseAccount(tx, 'house_rake'), amount: result.rake })
    }
    if (result.dust > 0n) {
      legs.push({ accountId: await houseAccount(tx, 'house_dust'), amount: result.dust })
    }

    if (result.poolTotal > 0n) {
      await postTransaction(tx, {
        kind: 'SETTLEMENT',
        idempotencyKey: `settle:${args.fightId}`,
        metadata: { fightId: args.fightId, outcome: args.outcome, settledBy: args.settledBy },
        legs,
      })
    }

    // Per-bet payouts: winners get their computed amount, everyone else an explicit zero.
    const payoutById = new Map(result.payouts.map((p) => [p.betId, p.amount]))
    for (const b of placed) {
      await tx
        .update(bets)
        .set({ payout: payoutById.get(b.id) ?? 0n })
        .where(eq(bets.id, b.id))
    }

    await tx.insert(settlements).values({
      fightId: args.fightId,
      outcome: args.outcome,
      poolTotal: result.poolTotal,
      winningPool: result.winningPool,
      rake: result.rake,
      dust: result.dust,
      refunded: result.refunded,
      settledBy: args.settledBy,
    })

    await tx
      .update(fights)
      .set({
        status: args.outcome === 'VOID' ? 'VOIDED' : 'SETTLED',
        outcome: args.outcome,
        settledAt: sql`now()`,
      })
      .where(eq(fights.id, args.fightId))

    const remaining = await balanceOf(tx, pool)
    if (remaining !== 0n) {
      throw new SettleError(
        `pool for fight ${args.fightId} still holds ${remaining} after settlement`,
        'POOL_NOT_DRAINED',
      )
    }

    return { ...result, replayed: false }
  })
}
```

Do not add a bulk-settle helper. Settlement is a per-fight human decision, and a loop over fights is how one mis-click becomes many.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/settlement/settle.test.ts
pnpm test
pnpm typecheck
```

Expected: PASS. The full suite must be green at this point — the entire money engine is now built.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/settlement/settle.ts tests/settlement/settle.test.ts
git commit -m "feat: idempotent transactional settlement with pool-drained assertion"
git push origin main
```

---

## Task 10: HTTP plumbing and the public API

**Files:**
- Create: `src/lib/http/respond.ts`, `src/lib/http/auth.ts`, `src/lib/http/serialize.ts`
- Create: `src/app/api/auth/signup/route.ts`, `src/app/api/auth/login/route.ts`, `src/app/api/auth/logout/route.ts`
- Create: `src/app/api/me/route.ts`, `src/app/api/me/bets/route.ts`
- Create: `src/app/api/fights/route.ts`, `src/app/api/fights/[id]/route.ts`, `src/app/api/fights/[id]/bets/route.ts`
- Test: `tests/http/serialize.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–9
- Produces:
  - `src/lib/http/respond.ts`: `ok<T>(data: T, init?: ResponseInit): Response`, `fail(status: number, code: string, message: string): Response`, `handle(fn: () => Promise<Response>): Promise<Response>`
  - `src/lib/http/auth.ts`: `currentUser(): Promise<SessionUser | null>`, `requireUser(): Promise<SessionUser>`, `requireAdmin(): Promise<SessionUser>`, `class HttpError extends Error { status: number; code: string }`
  - `src/lib/http/serialize.ts`: `jsonSafe<T>(value: T): unknown` — recursively converts `bigint` to decimal strings and `Date` to ISO strings

**API contract** (all responses are `{ data }` on success, `{ error: { code, message } }` on failure; all money fields are decimal strings in micro-units):

| Method & path | Body | Success |
|---|---|---|
| `POST /api/auth/signup` | `{ email, password }` | `201 { user }`, sets `bb_session` |
| `POST /api/auth/login` | `{ email, password }` | `200 { user }`, sets `bb_session` |
| `POST /api/auth/logout` | — | `200 { ok: true }`, clears cookie |
| `GET /api/me` | — | `200 { user, balance }` |
| `GET /api/me/bets` | — | `200 { bets: UserBet[] }` |
| `GET /api/fights` | — | `200 { fights: FightSummary[] }` |
| `GET /api/fights/:id` | — | `200 { fight, totals, estimated }` |
| `POST /api/fights/:id/bets` | `{ side, stake, idempotencyKey }` | `201 { betId, replayed }` |

- [ ] **Step 1: Write the failing serialization test**

`tests/http/serialize.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { jsonSafe } from '@/lib/http/serialize'

describe('jsonSafe', () => {
  it('converts bigints to decimal strings', () => {
    expect(jsonSafe({ stake: 25_000_000n })).toEqual({ stake: '25000000' })
  })

  it('converts dates to ISO strings', () => {
    const at = new Date('2026-07-25T12:00:00.000Z')
    expect(jsonSafe({ at })).toEqual({ at: '2026-07-25T12:00:00.000Z' })
  })

  it('recurses through arrays and nested objects', () => {
    expect(jsonSafe({ bets: [{ stake: 1n, meta: { payout: null } }] })).toEqual({
      bets: [{ stake: '1', meta: { payout: null } }],
    })
  })

  it('leaves primitives alone', () => {
    expect(jsonSafe({ a: 1, b: 'x', c: true, d: null })).toEqual({ a: 1, b: 'x', c: true, d: null })
  })

  it('survives JSON.stringify', () => {
    expect(() => JSON.stringify(jsonSafe({ stake: 1n }))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/http/serialize.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/http/serialize"`.

- [ ] **Step 3: Write the HTTP helpers**

`src/lib/http/serialize.ts`:

```ts
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]),
    )
  }
  return value
}
```

`src/lib/http/respond.ts`:

```ts
import { NextResponse } from 'next/server'
import { jsonSafe } from './serialize'
import { HttpError } from './auth'
import { AuthError } from '@/lib/auth/session'
import { BetError } from '@/lib/bets/place'
import { FightError } from '@/lib/fights/repo'
import { SettleError } from '@/lib/settlement/settle'
import { CreditError } from '@/lib/admin/credit'
import { LedgerError } from '@/lib/ledger/post'

export function ok<T>(data: T, init?: ResponseInit): Response {
  return NextResponse.json({ data: jsonSafe(data) }, init)
}

export function fail(status: number, code: string, message: string): Response {
  return NextResponse.json({ error: { code, message } }, { status })
}

const STATUS_BY_CODE: Record<string, number> = {
  // auth
  EMAIL_TAKEN: 409,
  BAD_CREDENTIALS: 401,
  WEAK_PASSWORD: 422,
  // fights
  NOT_FOUND: 404,
  BAD_TRANSITION: 409,
  INVALID_RAKE: 422,
  LOCK_IN_PAST: 422,
  // bets
  FIGHT_NOT_FOUND: 404,
  FIGHT_NOT_OPEN: 409,
  FIGHT_LOCKED: 409,
  INSUFFICIENT_FUNDS: 402,
  STAKE_BELOW_MINIMUM: 422,
  // settlement
  NOT_SETTLEABLE: 409,
  POOL_NOT_DRAINED: 500,
  // credit / ledger
  NON_POSITIVE: 422,
  UNBALANCED: 500,
  EMPTY: 500,
}

/** Single place where domain errors become HTTP status codes. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof HttpError) return fail(err.status, err.code, err.message)

    if (
      err instanceof AuthError ||
      err instanceof BetError ||
      err instanceof FightError ||
      err instanceof SettleError ||
      err instanceof CreditError ||
      err instanceof LedgerError
    ) {
      const status = STATUS_BY_CODE[err.code] ?? 400
      if (status >= 500) console.error('[api] domain failure', err)
      return fail(status, err.code, err.message)
    }

    console.error('[api] unhandled', err)
    return fail(500, 'INTERNAL', 'something went wrong')
  }
}
```

`src/lib/http/auth.ts`:

```ts
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
```

- [ ] **Step 4: Write the auth routes**

`src/app/api/auth/signup/route.ts`:

```ts
import * as z from 'zod'
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/client'
import { login, signup, SESSION_COOKIE, SESSION_TTL_DAYS } from '@/lib/auth/session'
import { handle, ok } from '@/lib/http/respond'
import { HttpError } from '@/lib/http/auth'

const Body = z.object({ email: z.email(), password: z.string().min(10) })

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    const db = getDb()
    await signup(db, parsed.data.email, parsed.data.password)
    const { user, sessionId } = await login(db, parsed.data.email, parsed.data.password)

    const jar = await cookies()
    jar.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    })

    return ok({ user }, { status: 201 })
  })
}
```

`src/app/api/auth/login/route.ts` — identical except it calls only `login` and returns `200`:

```ts
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
```

`src/app/api/auth/logout/route.ts`:

```ts
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
```

- [ ] **Step 5: Write the account routes**

`src/app/api/me/route.ts`:

```ts
import { getDb } from '@/lib/db/client'
import { userBalance } from '@/lib/ledger/accounts'
import { handle, ok } from '@/lib/http/respond'
import { requireUser } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    return ok({ user, balance: await userBalance(getDb(), user.id) })
  })
}
```

`src/app/api/me/bets/route.ts`:

```ts
import { getDb } from '@/lib/db/client'
import { listUserBets } from '@/lib/bets/place'
import { handle, ok } from '@/lib/http/respond'
import { requireUser } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    return ok({ bets: await listUserBets(getDb(), user.id) })
  })
}
```

- [ ] **Step 6: Write the fight routes**

`src/app/api/fights/route.ts` — the lazy lock backstop runs here, which is enough at this scale to avoid a scheduler:

```ts
import { getDb } from '@/lib/db/client'
import { listFights, lockDueFights, poolTotals, estimatedPayoutPerUsdt } from '@/lib/fights/repo'
import { handle, ok } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    const db = getDb()
    await lockDueFights(db)

    const fights = await listFights(db, ['OPEN', 'LOCKED', 'SETTLED', 'VOIDED'])
    const summaries = await Promise.all(
      fights.map(async (fight) => {
        const totals = await poolTotals(db, fight.id)
        return { fight, totals, estimated: estimatedPayoutPerUsdt(totals, fight.rakeBps) }
      }),
    )

    return ok({ fights: summaries })
  })
}
```

`src/app/api/fights/[id]/route.ts`:

```ts
import { getDb } from '@/lib/db/client'
import { getFight, lockDueFights, poolTotals, estimatedPayoutPerUsdt } from '@/lib/fights/repo'
import { handle, ok } from '@/lib/http/respond'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const { id } = await params
    const db = getDb()
    await lockDueFights(db)

    const fight = await getFight(db, id)
    const totals = await poolTotals(db, id)
    return ok({ fight, totals, estimated: estimatedPayoutPerUsdt(totals, fight.rakeBps) })
  })
}
```

`src/app/api/fights/[id]/bets/route.ts` — `stake` arrives as a decimal USDT string and is parsed with `parseUsdt`, so no float ever touches the request path:

```ts
import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { placeBet } from '@/lib/bets/place'
import { parseUsdt } from '@/lib/money/units'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireUser } from '@/lib/http/auth'

const Body = z.object({
  side: z.enum(['A', 'B']),
  stake: z.string(),
  idempotencyKey: z.string().min(8).max(64),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const { id } = await params

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    let stake: bigint
    try {
      stake = parseUsdt(parsed.data.stake)
    } catch {
      throw new HttpError(422, 'INVALID_STAKE', `not a valid USDT amount: ${parsed.data.stake}`)
    }

    const result = await placeBet(getDb(), {
      userId: user.id,
      fightId: id,
      side: parsed.data.side,
      stake,
      // Namespaced by user so one client cannot replay another's key.
      idempotencyKey: `${user.id}:${parsed.data.idempotencyKey}`,
    })

    return ok(result, { status: result.replayed ? 200 : 201 })
  })
}
```

- [ ] **Step 7: Run the tests and build to verify**

```bash
pnpm test tests/http/serialize.test.ts
pnpm test
pnpm typecheck
pnpm build
```

Expected: all tests PASS, typecheck clean, `next build` succeeds. `next build` is the real check here — route handler signatures and the async `cookies()`/`params` contracts are compile-time errors in Next 15.

- [ ] **Step 8: Commit and push**

```bash
git add src/lib/http src/app/api tests/http
git commit -m "feat: public API — auth, account, fights, and bet placement"
git push origin main
```

---

## Task 11: Admin API and admin bootstrap

**Files:**
- Create: `scripts/make-admin.ts`
- Create: `src/app/api/admin/fights/route.ts`, `src/app/api/admin/fights/[id]/publish/route.ts`, `src/app/api/admin/fights/[id]/settle/route.ts`
- Create: `src/app/api/admin/credits/route.ts`, `src/app/api/admin/users/route.ts`
- Modify: `package.json` (add the `make-admin` script)

**Interfaces:**
- Consumes: `requireAdmin`, `createFight`, `publishFight`, `listFights`, `settleFight`, `creditUser`, `parseUsdt`
- Produces:

| Method & path | Body | Success |
|---|---|---|
| `GET /api/admin/fights` | — | `200 { fights }` — all statuses including `DRAFT` |
| `POST /api/admin/fights` | `{ leagueName, fighterA, fighterB, streamEmbedUrl?, lockAt, rakeBps? }` | `201 { fight }` |
| `POST /api/admin/fights/:id/publish` | — | `200 { fight }` |
| `POST /api/admin/fights/:id/settle` | `{ outcome }` | `200 { settlement }` |
| `GET /api/admin/users` | — | `200 { users }` — id, email, balance |
| `POST /api/admin/credits` | `{ userId, amount, reference }` | `201 { txId, replayed }` |

There is no admin signup route. The first admin is promoted from the command line, so the privilege can never be granted over HTTP.

- [ ] **Step 1: Write the admin bootstrap script**

`scripts/make-admin.ts`:

```ts
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
```

Add to `package.json` scripts:

```json
    "make-admin": "tsx scripts/make-admin.ts"
```

- [ ] **Step 2: Write the fight administration routes**

`src/app/api/admin/fights/route.ts`:

```ts
import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { createFight, listFights, poolTotals } from '@/lib/fights/repo'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireAdmin } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

const Body = z.object({
  leagueName: z.string().min(1).max(120),
  fighterA: z.string().min(1).max(120),
  fighterB: z.string().min(1).max(120),
  streamEmbedUrl: z.string().url().nullish(),
  lockAt: z.iso.datetime(),
  rakeBps: z.number().int().min(0).max(2000).optional(),
})

export async function GET(): Promise<Response> {
  return handle(async () => {
    await requireAdmin()
    const db = getDb()
    const fights = await listFights(db, ['DRAFT', 'OPEN', 'LOCKED', 'SETTLED', 'VOIDED'])
    const withTotals = await Promise.all(
      fights.map(async (fight) => ({ fight, totals: await poolTotals(db, fight.id) })),
    )
    return ok({ fights: withTotals })
  })
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const admin = await requireAdmin()

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    const fight = await createFight(getDb(), {
      leagueName: parsed.data.leagueName,
      fighterA: parsed.data.fighterA,
      fighterB: parsed.data.fighterB,
      streamEmbedUrl: parsed.data.streamEmbedUrl ?? null,
      lockAt: new Date(parsed.data.lockAt),
      rakeBps: parsed.data.rakeBps,
      createdBy: admin.id,
    })

    return ok({ fight }, { status: 201 })
  })
}
```

`src/app/api/admin/fights/[id]/publish/route.ts`:

```ts
import { getDb } from '@/lib/db/client'
import { publishFight } from '@/lib/fights/repo'
import { handle, ok } from '@/lib/http/respond'
import { requireAdmin } from '@/lib/http/auth'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    await requireAdmin()
    const { id } = await params
    return ok({ fight: await publishFight(getDb(), id) })
  })
}
```

`src/app/api/admin/fights/[id]/settle/route.ts`:

```ts
import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { settleFight } from '@/lib/settlement/settle'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireAdmin } from '@/lib/http/auth'

const Body = z.object({ outcome: z.enum(['A', 'B', 'VOID']) })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const admin = await requireAdmin()
    const { id } = await params

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    const settlement = await settleFight(getDb(), {
      fightId: id,
      outcome: parsed.data.outcome,
      settledBy: admin.id,
    })

    return ok({ settlement })
  })
}
```

- [ ] **Step 3: Write the user and credit routes**

`src/app/api/admin/users/route.ts`:

```ts
import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { handle, ok } from '@/lib/http/respond'
import { requireAdmin } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    await requireAdmin()

    const rows = await getDb().execute<{ id: string; email: string; balance: string }>(sql`
      SELECT u.id,
             u.email,
             COALESCE(SUM(le.amount), 0)::text AS balance
      FROM users u
      LEFT JOIN accounts a
        ON a.user_id = u.id AND a.kind = 'user_available'
      LEFT JOIN ledger_entries le
        ON le.account_id = a.id
      GROUP BY u.id, u.email
      ORDER BY u.created_at DESC
    `)

    return ok({ users: rows.rows.map((r) => ({ ...r, balance: BigInt(r.balance) })) })
  })
}
```

`src/app/api/admin/credits/route.ts`:

```ts
import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { creditUser } from '@/lib/admin/credit'
import { parseUsdt } from '@/lib/money/units'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireAdmin } from '@/lib/http/auth'

const Body = z.object({
  userId: z.uuid(),
  amount: z.string(),
  reference: z.string().min(4).max(64),
})

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const admin = await requireAdmin()

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    let amount: bigint
    try {
      amount = parseUsdt(parsed.data.amount)
    } catch {
      throw new HttpError(422, 'INVALID_AMOUNT', `not a valid USDT amount: ${parsed.data.amount}`)
    }

    const result = await creditUser(getDb(), {
      userId: parsed.data.userId,
      amount,
      reference: parsed.data.reference,
      creditedBy: admin.id,
    })

    return ok(result, { status: 201 })
  })
}
```

- [ ] **Step 4: Verify the build**

```bash
pnpm typecheck
pnpm build
pnpm test
```

Expected: typecheck clean, build succeeds, all tests still PASS.

- [ ] **Step 5: Commit and push**

```bash
git add scripts/make-admin.ts src/app/api/admin package.json
git commit -m "feat: admin API for fights, settlement, credits, and CLI admin bootstrap"
git push origin main
```

---

## Task 12: Public pages

Functional, unstyled, and deliberately plain. Design is a later slice.

**Files:**
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
- Create: `src/app/login/page.tsx`, `src/app/signup/page.tsx`
- Create: `src/app/fights/[id]/page.tsx`, `src/app/account/page.tsx`
- Create: `src/components/AuthForm.tsx`, `src/components/BetForm.tsx`, `src/components/Money.tsx`, `src/components/Nav.tsx`
- Create: `src/lib/client/api.ts`

**Interfaces:**
- Consumes: the public API contract from Task 10
- Produces (`src/lib/client/api.ts`):
  - `apiGet<T>(path: string): Promise<T>`
  - `apiPost<T>(path: string, body: unknown): Promise<T>`
  - `class ApiError extends Error { code: string; status: number }`

All money crosses the wire as micro-unit decimal strings and is rendered by `<Money micros={...} />`, which calls `formatUsdt`. No component does arithmetic on a `number`.

- [ ] **Step 1: Write the client API helper and the money component**

`src/lib/client/api.ts`:

```ts
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = body?.error ?? { code: 'INTERNAL', message: 'request failed' }
    throw new ApiError(response.status, error.code, error.message)
  }
  return body.data as T
}

export async function apiGet<T>(path: string): Promise<T> {
  return unwrap<T>(await fetch(path, { cache: 'no-store' }))
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  )
}
```

`src/components/Money.tsx`:

```tsx
import { formatUsdt } from '@/lib/money/units'

export function Money({ micros }: { micros: string | bigint | null }) {
  if (micros === null) return <span>—</span>
  return <span>{formatUsdt(BigInt(micros))} USDT</span>
}

export function Multiplier({ micros }: { micros: string | null }) {
  if (micros === null) return <span>—</span>
  return <span>{formatUsdt(BigInt(micros))}×</span>
}
```

- [ ] **Step 2: Write the layout and navigation**

`src/app/globals.css`:

```css
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 60rem; }
a { color: inherit; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid currentColor; padding: 0.35rem 0.6rem; text-align: left; }
fieldset { border: 1px solid currentColor; margin: 1rem 0; }
label { display: block; margin: 0.5rem 0; }
input, select, button { font: inherit; padding: 0.3rem; }
.error { color: #b00020; }
.estimate { opacity: 0.8; font-size: 0.9em; }
```

`src/app/layout.tsx`:

```tsx
import type { Metadata } from 'next'
import './globals.css'
import { Nav } from '@/components/Nav'

export const metadata: Metadata = {
  title: 'Bots Battle',
  description: 'Pari-mutuel betting on Robot MMA',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  )
}
```

`src/components/Nav.tsx`:

```tsx
import Link from 'next/link'
import { currentUser } from '@/lib/http/auth'
import { getDb } from '@/lib/db/client'
import { userBalance } from '@/lib/ledger/accounts'
import { Money } from './Money'

export async function Nav() {
  const user = await currentUser()
  const balance = user ? await userBalance(getDb(), user.id) : null

  return (
    <nav>
      <Link href="/">Fights</Link>
      {' · '}
      {user ? (
        <>
          <Link href="/account">Account</Link>
          {user.isAdmin && (
            <>
              {' · '}
              <Link href="/admin">Admin</Link>
            </>
          )}
          {' · '}
          <span>
            {user.email} — <Money micros={balance} />
          </span>
        </>
      ) : (
        <>
          <Link href="/login">Log in</Link>
          {' · '}
          <Link href="/signup">Sign up</Link>
        </>
      )}
      <hr />
    </nav>
  )
}
```

- [ ] **Step 3: Write the fight list page**

`src/app/page.tsx` — a server component reading the database directly; the polling happens only on the fight detail page where the numbers actually move:

```tsx
import Link from 'next/link'
import { getDb } from '@/lib/db/client'
import { listFights, lockDueFights, poolTotals, estimatedPayoutPerUsdt } from '@/lib/fights/repo'
import { Money, Multiplier } from '@/components/Money'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const db = getDb()
  await lockDueFights(db)

  const fights = await listFights(db, ['OPEN', 'LOCKED', 'SETTLED', 'VOIDED'])
  const rows = await Promise.all(
    fights.map(async (fight) => {
      const totals = await poolTotals(db, fight.id)
      return { fight, totals, estimated: estimatedPayoutPerUsdt(totals, fight.rakeBps) }
    }),
  )

  if (!rows.length) return <p>No fights are open right now.</p>

  return (
    <table>
      <thead>
        <tr>
          <th>Fight</th>
          <th>Status</th>
          <th>Pool</th>
          <th>Est. A</th>
          <th>Est. B</th>
          <th>Locks</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ fight, totals, estimated }) => (
          <tr key={fight.id}>
            <td>
              <Link href={`/fights/${fight.id}`}>
                {fight.fighterA} vs {fight.fighterB}
              </Link>
              <div className="estimate">{fight.leagueName}</div>
            </td>
            <td>
              {fight.status}
              {fight.outcome ? ` (${fight.outcome})` : ''}
            </td>
            <td>
              <Money micros={totals.total} />
            </td>
            <td>
              <Multiplier micros={estimated.a === null ? null : estimated.a.toString()} />
            </td>
            <td>
              <Multiplier micros={estimated.b === null ? null : estimated.b.toString()} />
            </td>
            <td>{fight.lockAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 4: Write the auth pages**

`src/components/AuthForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost(`/api/auth/${mode}`, { email, password })
      router.push('/')
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>{mode === 'login' ? 'Log in' : 'Sign up'}</legend>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === 'signup' ? 10 : 1}
            required
          />
        </label>
        {mode === 'signup' && <p className="estimate">At least 10 characters.</p>}
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </fieldset>
    </form>
  )
}
```

`src/app/login/page.tsx`:

```tsx
import { AuthForm } from '@/components/AuthForm'

export default function LoginPage() {
  return <AuthForm mode="login" />
}
```

`src/app/signup/page.tsx`:

```tsx
import { AuthForm } from '@/components/AuthForm'

export default function SignupPage() {
  return <AuthForm mode="signup" />
}
```

- [ ] **Step 5: Write the fight detail page with the bet form**

`src/components/BetForm.tsx` — polls every 3 seconds per the spec, and generates a fresh idempotency key per submission attempt so a retried click cannot double-charge:

```tsx
'use client'

import { useEffect, useState, useRef } from 'react'
import { apiGet, apiPost, ApiError } from '@/lib/client/api'
import { formatUsdt } from '@/lib/money/units'

type FightView = {
  fight: { id: string; fighterA: string; fighterB: string; status: string; outcome: string | null }
  totals: { total: string; a: string; b: string }
  estimated: { a: string | null; b: string | null }
}

const POLL_MS = 3000

export function BetForm({ fightId, initial }: { fightId: string; initial: FightView }) {
  const [view, setView] = useState(initial)
  const [side, setSide] = useState<'A' | 'B'>('A')
  const [stake, setStake] = useState('10')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const keyRef = useRef(crypto.randomUUID())

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        setView(await apiGet<FightView>(`/api/fights/${fightId}`))
      } catch {
        // A failed poll is not worth surfacing; the next one will refresh the numbers.
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [fightId])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await apiPost(`/api/fights/${fightId}/bets`, {
        side,
        stake,
        idempotencyKey: keyRef.current,
      })
      keyRef.current = crypto.randomUUID()
      setMessage(`Bet placed on ${side}.`)
      setView(await apiGet<FightView>(`/api/fights/${fightId}`))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const open = view.fight.status === 'OPEN'
  const estimate = side === 'A' ? view.estimated.a : view.estimated.b

  return (
    <>
      <table>
        <tbody>
          <tr>
            <th>Pool</th>
            <td>{formatUsdt(BigInt(view.totals.total))} USDT</td>
          </tr>
          <tr>
            <th>{view.fight.fighterA} (A)</th>
            <td>
              {formatUsdt(BigInt(view.totals.a))} USDT —{' '}
              {view.estimated.a ? `${formatUsdt(BigInt(view.estimated.a))}×` : '—'}
            </td>
          </tr>
          <tr>
            <th>{view.fight.fighterB} (B)</th>
            <td>
              {formatUsdt(BigInt(view.totals.b))} USDT —{' '}
              {view.estimated.b ? `${formatUsdt(BigInt(view.estimated.b))}×` : '—'}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="estimate">
        Estimated payouts move with the pool and are not fixed until betting locks.
      </p>

      {open ? (
        <form onSubmit={submit}>
          <fieldset>
            <legend>Place a bet</legend>
            <label>
              Robot
              <select value={side} onChange={(e) => setSide(e.target.value as 'A' | 'B')}>
                <option value="A">{view.fight.fighterA} (A)</option>
                <option value="B">{view.fight.fighterB} (B)</option>
              </select>
            </label>
            <label>
              Stake (USDT, minimum 1)
              <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" />
            </label>
            <p className="estimate">
              At the current pool that would return about{' '}
              {estimate ? `${formatUsdt(BigInt(estimate))}× your stake` : 'an unknown multiple'}.
            </p>
            {error && <p className="error">{error}</p>}
            {message && <p>{message}</p>}
            <button type="submit" disabled={busy}>
              {busy ? 'Placing…' : 'Place bet'}
            </button>
          </fieldset>
        </form>
      ) : (
        <p>
          Betting is closed — this fight is {view.fight.status}
          {view.fight.outcome ? ` (${view.fight.outcome})` : ''}.
        </p>
      )}
    </>
  )
}
```

`src/app/fights/[id]/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { getFight, lockDueFights, poolTotals, estimatedPayoutPerUsdt, FightError } from '@/lib/fights/repo'
import { BetForm } from '@/components/BetForm'
import { currentUser } from '@/lib/http/auth'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function FightPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getDb()
  await lockDueFights(db)

  const fight = await getFight(db, id).catch((err) => {
    if (err instanceof FightError && err.code === 'NOT_FOUND') notFound()
    throw err
  })

  if (fight.status === 'DRAFT') notFound()

  const totals = await poolTotals(db, id)
  const estimated = estimatedPayoutPerUsdt(totals, fight.rakeBps)
  const user = await currentUser()

  const initial = {
    fight: {
      id: fight.id,
      fighterA: fight.fighterA,
      fighterB: fight.fighterB,
      status: fight.status,
      outcome: fight.outcome,
    },
    totals: { total: totals.total.toString(), a: totals.a.toString(), b: totals.b.toString() },
    estimated: {
      a: estimated.a === null ? null : estimated.a.toString(),
      b: estimated.b === null ? null : estimated.b.toString(),
    },
  }

  return (
    <>
      <h1>
        {fight.fighterA} vs {fight.fighterB}
      </h1>
      <p>
        {fight.leagueName} · rake {(fight.rakeBps / 100).toFixed(2)}%
      </p>

      {fight.streamEmbedUrl && (
        <iframe
          src={fight.streamEmbedUrl}
          title="Live stream"
          width="640"
          height="360"
          allowFullScreen
        />
      )}

      {user ? (
        <BetForm fightId={fight.id} initial={initial} />
      ) : (
        <p>
          <Link href="/login">Log in</Link> to place a bet.
        </p>
      )}
    </>
  )
}
```

- [ ] **Step 6: Write the account page**

`src/app/account/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { userBalance } from '@/lib/ledger/accounts'
import { listUserBets } from '@/lib/bets/place'
import { Money } from '@/components/Money'

export const dynamic = 'force-dynamic'

export default async function AccountPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const db = getDb()
  const [balance, bets] = await Promise.all([userBalance(db, user.id), listUserBets(db, user.id)])

  return (
    <>
      <h1>Account</h1>
      <p>
        Balance: <Money micros={balance} />
      </p>

      <h2>Bets</h2>
      {bets.length === 0 ? (
        <p>No bets yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Fight</th>
              <th>Side</th>
              <th>Stake</th>
              <th>Status</th>
              <th>Payout</th>
            </tr>
          </thead>
          <tbody>
            {bets.map((bet) => (
              <tr key={bet.id}>
                <td>
                  <Link href={`/fights/${bet.fightId}`}>
                    {bet.fighterA} vs {bet.fighterB}
                  </Link>
                </td>
                <td>{bet.side}</td>
                <td>
                  <Money micros={bet.stake} />
                </td>
                <td>
                  {bet.fightStatus}
                  {bet.outcome ? ` (${bet.outcome})` : ''}
                </td>
                <td>
                  <Money micros={bet.payout} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
```

- [ ] **Step 7: Verify the build and click through the app**

```bash
pnpm typecheck
pnpm build
pnpm db:migrate
pnpm dev
```

Then, in a browser at `http://localhost:3000`: sign up, note the empty balance, and confirm the fight list renders "No fights are open right now." Admin flows are exercised in Task 13.

- [ ] **Step 8: Commit and push**

```bash
git add src/app src/components src/lib/client
git commit -m "feat: public pages — fight list, fight detail with polling odds, account"
git push origin main
```

---

## Task 13: Admin pages and the end-to-end walkthrough

**Files:**
- Create: `src/app/admin/page.tsx`, `src/app/admin/fights/[id]/page.tsx`
- Create: `src/components/CreateFightForm.tsx`, `src/components/FightAdminControls.tsx`, `src/components/CreditForm.tsx`
- Create: `docs/superpowers/plans/slice-1-walkthrough.md`

**Interfaces:**
- Consumes: the admin API contract from Task 11
- Produces: no new modules; this task closes the loop

- [ ] **Step 1: Write the admin forms**

`src/components/CreateFightForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'

export function CreateFightForm() {
  const router = useRouter()
  const [form, setForm] = useState({
    leagueName: '',
    fighterA: '',
    fighterB: '',
    streamEmbedUrl: '',
    lockAt: '',
    rakeBps: '500',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost('/api/admin/fights', {
        leagueName: form.leagueName,
        fighterA: form.fighterA,
        fighterB: form.fighterB,
        streamEmbedUrl: form.streamEmbedUrl || null,
        lockAt: new Date(form.lockAt).toISOString(),
        rakeBps: Number(form.rakeBps),
      })
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>New fight</legend>
        <label>
          League <input value={form.leagueName} onChange={set('leagueName')} required />
        </label>
        <label>
          Robot A <input value={form.fighterA} onChange={set('fighterA')} required />
        </label>
        <label>
          Robot B <input value={form.fighterB} onChange={set('fighterB')} required />
        </label>
        <label>
          Stream embed URL <input value={form.streamEmbedUrl} onChange={set('streamEmbedUrl')} />
        </label>
        <label>
          Locks at <input type="datetime-local" value={form.lockAt} onChange={set('lockAt')} required />
        </label>
        <label>
          Rake (bps, 0–2000) <input type="number" value={form.rakeBps} onChange={set('rakeBps')} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create draft'}
        </button>
      </fieldset>
    </form>
  )
}
```

`src/components/FightAdminControls.tsx` — settlement asks for a typed confirmation because it is irreversible and moves real balances:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'

export function FightAdminControls({
  fightId,
  status,
  fighterA,
  fighterB,
}: {
  fightId: string
  status: string
  fighterA: string
  fighterB: string
}) {
  const router = useRouter()
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function call(path: string, body?: unknown) {
    setBusy(true)
    setError(null)
    try {
      await apiPost(path, body)
      setConfirm('')
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const canSettle = status === 'LOCKED'
  const canVoid = status === 'OPEN' || status === 'LOCKED'
  const armed = confirm === 'SETTLE'

  return (
    <fieldset>
      <legend>Controls — fight is {status}</legend>

      {status === 'DRAFT' && (
        <button disabled={busy} onClick={() => call(`/api/admin/fights/${fightId}/publish`)}>
          Publish (open betting)
        </button>
      )}

      {(canSettle || canVoid) && (
        <>
          <label>
            Type SETTLE to enable outcome buttons
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>

          {canSettle && (
            <>
              <button
                disabled={busy || !armed}
                onClick={() => call(`/api/admin/fights/${fightId}/settle`, { outcome: 'A' })}
              >
                {fighterA} (A) won
              </button>{' '}
              <button
                disabled={busy || !armed}
                onClick={() => call(`/api/admin/fights/${fightId}/settle`, { outcome: 'B' })}
              >
                {fighterB} (B) won
              </button>{' '}
            </>
          )}

          {canVoid && (
            <button
              disabled={busy || !armed}
              onClick={() => call(`/api/admin/fights/${fightId}/settle`, { outcome: 'VOID' })}
            >
              Void and refund
            </button>
          )}
        </>
      )}

      {error && <p className="error">{error}</p>}
    </fieldset>
  )
}
```

`src/components/CreditForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'

export function CreditForm({ users }: { users: { id: string; email: string }[] }) {
  const router = useRouter()
  const [userId, setUserId] = useState(users[0]?.id ?? '')
  const [amount, setAmount] = useState('100')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost('/api/admin/credits', { userId, amount, reference })
      setReference('')
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>Credit a balance (stands in for a deposit)</legend>
        <label>
          User
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount (USDT) <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Reference (unique; replaying it is a no-op)
          <input value={reference} onChange={(e) => setReference(e.target.value)} minLength={4} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !userId}>
          {busy ? 'Crediting…' : 'Credit'}
        </button>
      </fieldset>
    </form>
  )
}
```

- [ ] **Step 2: Write the admin pages**

`src/app/admin/page.tsx`:

```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { listFights, poolTotals } from '@/lib/fights/repo'
import { CreateFightForm } from '@/components/CreateFightForm'
import { CreditForm } from '@/components/CreditForm'
import { Money } from '@/components/Money'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  const user = await currentUser()
  if (!user?.isAdmin) notFound()

  const db = getDb()
  const fights = await listFights(db, ['DRAFT', 'OPEN', 'LOCKED', 'SETTLED', 'VOIDED'])
  const rows = await Promise.all(
    fights.map(async (fight) => ({ fight, totals: await poolTotals(db, fight.id) })),
  )
  const users = await db.execute<{ id: string; email: string }>(
    sql`SELECT id, email FROM users ORDER BY created_at DESC`,
  )

  return (
    <>
      <h1>Admin</h1>
      <CreateFightForm />
      <CreditForm users={users.rows} />

      <h2>Fights</h2>
      <table>
        <thead>
          <tr>
            <th>Fight</th>
            <th>Status</th>
            <th>Pool</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ fight, totals }) => (
            <tr key={fight.id}>
              <td>
                <Link href={`/admin/fights/${fight.id}`}>
                  {fight.fighterA} vs {fight.fighterB}
                </Link>
              </td>
              <td>
                {fight.status}
                {fight.outcome ? ` (${fight.outcome})` : ''}
              </td>
              <td>
                <Money micros={totals.total} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
```

`src/app/admin/fights/[id]/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { getFight, poolTotals, FightError } from '@/lib/fights/repo'
import { FightAdminControls } from '@/components/FightAdminControls'
import { Money } from '@/components/Money'

export const dynamic = 'force-dynamic'

export default async function AdminFightPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser()
  if (!user?.isAdmin) notFound()

  const { id } = await params
  const db = getDb()

  const fight = await getFight(db, id).catch((err) => {
    if (err instanceof FightError && err.code === 'NOT_FOUND') notFound()
    throw err
  })
  const totals = await poolTotals(db, id)

  return (
    <>
      <h1>
        {fight.fighterA} vs {fight.fighterB}
      </h1>
      <table>
        <tbody>
          <tr>
            <th>Status</th>
            <td>
              {fight.status}
              {fight.outcome ? ` (${fight.outcome})` : ''}
            </td>
          </tr>
          <tr>
            <th>Locks at</th>
            <td>{fight.lockAt.toISOString()}</td>
          </tr>
          <tr>
            <th>Rake</th>
            <td>{(fight.rakeBps / 100).toFixed(2)}%</td>
          </tr>
          <tr>
            <th>Pool</th>
            <td>
              <Money micros={totals.total} /> (A <Money micros={totals.a} />, B{' '}
              <Money micros={totals.b} />)
            </td>
          </tr>
        </tbody>
      </table>

      <FightAdminControls
        fightId={fight.id}
        status={fight.status}
        fighterA={fight.fighterA}
        fighterB={fight.fighterB}
      />
    </>
  )
}
```

- [ ] **Step 3: Run the whole suite and build**

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: all tests PASS, typecheck clean, build succeeds.

- [ ] **Step 4: Walk the app end to end by hand**

Write down the result of each step in `docs/superpowers/plans/slice-1-walkthrough.md` as you go. Record actual observed numbers, not expected ones.

```bash
pnpm db:up
pnpm db:migrate
pnpm dev
```

1. Sign up as `admin@example.com`, then in a second terminal: `pnpm make-admin admin@example.com`. Reload — the `Admin` link appears.
2. Sign up as `alice@example.com` and `bob@example.com` in private windows.
3. As admin, credit Alice 100 USDT (reference `seed-alice`) and Bob 100 USDT (reference `seed-bob`).
4. Submit the credit for Alice a second time with the same reference. Her balance must not change — the confirmation of idempotency in the real UI.
5. Create a fight locking ~10 minutes out, rake 500 bps. Publish it.
6. As Alice, bet 25 USDT on A. As Bob, bet 75 USDT on B. Watch the estimate on Alice's open tab move within 3 seconds without a reload.
7. As admin, wait for the lock time to pass and reload `/admin` so the backstop locks the fight, then settle with outcome A.
8. Alice's balance must read 170.00 USDT, Bob's 25.00 USDT.
9. Confirm the house took exactly 5 USDT:

```bash
docker compose exec db psql -U botsbattle -d botsbattle -c "
  SELECT a.kind, SUM(le.amount) AS balance
  FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
  GROUP BY a.kind ORDER BY a.kind;
"
```

10. Confirm the ledger is globally balanced and no transaction is lopsided:

```bash
docker compose exec db psql -U botsbattle -d botsbattle -c "
  SELECT COALESCE(SUM(amount), 0) AS grand_total FROM ledger_entries;
  SELECT tx_id, SUM(amount) FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0;
"
```

Expected: `grand_total` is `0`, and the second query returns no rows. If either fails, stop — that is a production-severity defect in the slice's core claim.

- [ ] **Step 5: Commit and push**

```bash
git add src/app/admin src/components docs/superpowers/plans/slice-1-walkthrough.md
git commit -m "feat: admin pages for fight lifecycle, settlement, and credits"
git push origin main
```

---

## Done when

- `pnpm test` is green, including ~14,000 generated settlement pools and the concurrent-bet overdraft test
- `pnpm typecheck` and `pnpm build` are clean
- The hand walkthrough in Task 13 Step 4 is recorded, with a globally balanced ledger
- No `balance` column exists anywhere; every balance in the app is a `SUM` over `ledger_entries`

## Deliberately not in this slice

Tron, deposits, withdrawals, the signer process, TOTP, `balance_cache` and reconciliation, visual design, and deployment. Slices 2–4 cover them.

