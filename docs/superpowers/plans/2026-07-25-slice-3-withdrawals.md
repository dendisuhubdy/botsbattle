# Slice 3 — Withdrawals, Admin Approval, and TOTP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users withdraw USDT to a Tron address they control, gated by TOTP and human approval, with the funds ring-fenced in the ledger from the moment the request is made.

**Architecture:** A withdrawal is a state machine over ledger movements, not a chain operation with bookkeeping bolted on. Requesting one immediately moves the amount `user_available → user_pending_withdrawal`, so it cannot be staked or withdrawn twice while a human reviews it. Approval enqueues a `signer_jobs` row; the Slice 2 signer broadcasts it; the Slice 2 worker confirms it and closes out `user_pending_withdrawal → hot_wallet`.

**Tech Stack:** Everything from Slices 1–2, plus `otpauth` for RFC 6238 TOTP and `qrcode` for enrolment.

> **Read this before executing.** Slice 1 was planned in full and then executed, and execution
> surfaced five real defects — including `postTransaction` not being atomic, a genuine money
> bug. This plan was written against Slice 2's *planned* interfaces. Before starting, re-read
> `src/lib/signer/jobs.ts`, `src/lib/signer/run.ts`, and `src/lib/tron/client.ts` as they
> actually exist and reconcile any drift. Names here are predictions, not observations.

## Global Constraints

All Slice 1 and Slice 2 constraints still apply. In addition:

- **The ledger moves first.** `user_available → user_pending_withdrawal` happens in the same transaction that creates the request, before any human or chain involvement. A request that exists without its funds ring-fenced is a double-spend.
- **TOTP gates withdrawals only**, never login. Enrolment is triggered at the first withdrawal attempt, not at signup.
- **Every state change writes a ledger entry**, so a stuck withdrawal is always explainable from the ledger alone.
- **Approval is a human step.** No automatic approval path exists, not even behind a flag.
- **`users.withdrawal_locked` is checked** on every withdrawal request. It already exists from Slice 1 and defaults to `false`.
- **TOTP secrets are encrypted at rest** with AES-256-GCM under `TOTP_ENCRYPTION_KEY`. The column `users.totp_secret_enc` already exists.
- Withdrawal idempotency key is the `request_id`.

## Withdrawal lifecycle

```
                      ┌──────────► REJECTED ──► (funds returned)
                      │
REQUESTED ──► APPROVED ──► BROADCAST ──► CONFIRMED
     │                          │
     └──► CANCELLED             └──► FAILED ──► (funds returned)
```

| Transition | Who | Ledger effect |
|---|---|---|
| → `REQUESTED` | user (with TOTP) | `user_available −X`, `user_pending_withdrawal +X` |
| `REQUESTED → CANCELLED` | user | `user_pending_withdrawal −X`, `user_available +X` |
| `REQUESTED → REJECTED` | admin | `user_pending_withdrawal −X`, `user_available +X` |
| `REQUESTED → APPROVED` | admin | none — enqueues a signer job |
| `APPROVED → BROADCAST` | signer | none — records `tx_hash` |
| `BROADCAST → CONFIRMED` | worker | `user_pending_withdrawal −X`, `hot_wallet +X` |
| `BROADCAST → FAILED` | worker/signer | `user_pending_withdrawal −X`, `user_available +X` |

`hot_wallet +X` on confirmation is the mirror of Slice 2's deposit leg: custody is carried with
inverted sign, so money genuinely leaving the platform reduces the custody obligation.

## File Structure

| Path | Responsibility |
|---|---|
| `migrations/0005_withdrawals.sql` | `withdrawal_requests`, status enum |
| `src/lib/auth/totp.ts` | Secret generation, encryption, verification, enrolment URI |
| `src/lib/withdrawals/request.ts` | Creating and cancelling a request |
| `src/lib/withdrawals/review.ts` | Admin approve/reject |
| `src/lib/withdrawals/settle.ts` | Broadcast recording, confirmation, failure return |
| `src/lib/withdrawals/poller.ts` | Worker-side confirmation tracking |
| `src/app/api/me/totp/**`, `src/app/api/me/withdrawals/**` | User API |
| `src/app/api/admin/withdrawals/**` | Admin API |
| `src/app/withdraw/page.tsx`, `src/app/admin/withdrawals/page.tsx` | UI |

---

## Task 1: TOTP secrets

**Files:**
- Create: `src/lib/auth/totp.ts`
- Modify: `.env.example`
- Test: `tests/auth/totp.test.ts`

**Interfaces:**
- Consumes: `users` table (`totp_secret_enc`, `totp_enabled` already exist)
- Produces (`src/lib/auth/totp.ts`):
  - `class TotpError extends Error { code: 'NOT_ENROLLED' | 'ALREADY_ENROLLED' | 'INVALID_CODE' | 'NO_KEY' }`
  - `generateSecret(): string` — base32
  - `encryptSecret(secret: string, key?: string): string`, `decryptSecret(payload: string, key?: string): string`
  - `enrolmentUri(args: { secret: string; email: string }): string`
  - `beginEnrolment(db: Db, userId: string): Promise<{ secret: string; uri: string }>`
  - `confirmEnrolment(db: Db, userId: string, code: string): Promise<void>`
  - `verifyTotp(db: Db, userId: string, code: string): Promise<void>` — throws on failure

- [ ] **Step 1: Install dependencies**

```bash
pnpm add otpauth qrcode
pnpm add -D @types/qrcode
```

- [ ] **Step 2: Write the failing test**

`tests/auth/totp.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import {
  generateSecret,
  encryptSecret,
  decryptSecret,
  enrolmentUri,
  beginEnrolment,
  confirmEnrolment,
  verifyTotp,
  TotpError,
} from '@/lib/auth/totp'

const KEY = '0'.repeat(64) // 32 bytes hex

function codeFor(secret: string): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
}

describe('TOTP secrets', () => {
  it('generates a distinct base32 secret each time', () => {
    const a = generateSecret()
    const b = generateSecret()
    expect(a).toMatch(/^[A-Z2-7]+$/)
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(32)
  })

  it('round-trips through encryption', () => {
    const secret = generateSecret()
    const sealed = encryptSecret(secret, KEY)
    expect(sealed).not.toContain(secret)
    expect(decryptSecret(sealed, KEY)).toBe(secret)
  })

  it('produces a different ciphertext each time for the same secret', () => {
    const secret = generateSecret()
    expect(encryptSecret(secret, KEY)).not.toBe(encryptSecret(secret, KEY))
  })

  it('refuses to decrypt with the wrong key', () => {
    const sealed = encryptSecret(generateSecret(), KEY)
    expect(() => decryptSecret(sealed, '1'.repeat(64))).toThrow()
  })

  it('refuses to decrypt tampered ciphertext', () => {
    const sealed = encryptSecret(generateSecret(), KEY)
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('a') ? 'b' : 'a')
    expect(() => decryptSecret(tampered, KEY)).toThrow()
  })

  it('builds an otpauth URI an authenticator app accepts', () => {
    const uri = enrolmentUri({ secret: 'JBSWY3DPEHPK3PXP', email: 'a@example.com' })
    expect(uri).toMatch(/^otpauth:\/\/totp\//)
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain('a%40example.com')
  })
})

describe('TOTP enrolment', () => {
  let db: Db
  let user: string

  beforeAll(async () => {
    ;({ db } = await testDb())
    process.env.TOTP_ENCRYPTION_KEY = KEY
  })

  beforeEach(async () => {
    await truncateAll(db)
    user = await makeUser(db)
  })

  it('stores an encrypted secret but does not enable until confirmed', async () => {
    const { secret } = await beginEnrolment(db, user)

    const [row] = await db.select().from(users).where(eq(users.id, user))
    expect(row.totpEnabled).toBe(false)
    expect(row.totpSecretEnc).not.toBeNull()
    expect(row.totpSecretEnc).not.toContain(secret)
  })

  it('enables TOTP when the confirming code is correct', async () => {
    const { secret } = await beginEnrolment(db, user)
    await confirmEnrolment(db, user, codeFor(secret))

    const [row] = await db.select().from(users).where(eq(users.id, user))
    expect(row.totpEnabled).toBe(true)
  })

  it('rejects a wrong confirming code and leaves TOTP disabled', async () => {
    await beginEnrolment(db, user)
    await expect(confirmEnrolment(db, user, '000000')).rejects.toMatchObject({
      code: 'INVALID_CODE',
    })

    const [row] = await db.select().from(users).where(eq(users.id, user))
    expect(row.totpEnabled).toBe(false)
  })

  it('refuses to re-enrol an already enrolled user', async () => {
    const { secret } = await beginEnrolment(db, user)
    await confirmEnrolment(db, user, codeFor(secret))

    await expect(beginEnrolment(db, user)).rejects.toMatchObject({ code: 'ALREADY_ENROLLED' })
  })

  it('verifies a live code once enrolled', async () => {
    const { secret } = await beginEnrolment(db, user)
    await confirmEnrolment(db, user, codeFor(secret))

    await expect(verifyTotp(db, user, codeFor(secret))).resolves.toBeUndefined()
  })

  it('rejects a wrong code after enrolment', async () => {
    const { secret } = await beginEnrolment(db, user)
    await confirmEnrolment(db, user, codeFor(secret))

    await expect(verifyTotp(db, user, '000000')).rejects.toMatchObject({ code: 'INVALID_CODE' })
  })

  it('reports NOT_ENROLLED for a user who never enrolled', async () => {
    await expect(verifyTotp(db, user, '123456')).rejects.toMatchObject({ code: 'NOT_ENROLLED' })
  })

  it('reports NOT_ENROLLED when enrolment was begun but never confirmed', async () => {
    const { secret } = await beginEnrolment(db, user)
    await expect(verifyTotp(db, user, codeFor(secret))).rejects.toMatchObject({
      code: 'NOT_ENROLLED',
    })
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test tests/auth/totp.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/auth/totp"`.

- [ ] **Step 4: Write the implementation**

`src/lib/auth/totp.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import type { Db } from '@/lib/db/client'
import { users } from '@/lib/db/schema'

const ISSUER = 'Bots Battle'
/** One step either side, so a code entered as the window rolls still works. */
const WINDOW = 1

export class TotpError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_ENROLLED' | 'ALREADY_ENROLLED' | 'INVALID_CODE' | 'NO_KEY',
  ) {
    super(message)
    this.name = 'TotpError'
  }
}

function keyBytes(key?: string): Buffer {
  const hex = key ?? process.env.TOTP_ENCRYPTION_KEY
  if (!hex) throw new TotpError('TOTP_ENCRYPTION_KEY is not set', 'NO_KEY')
  const buf = Buffer.from(hex, 'hex')
  if (buf.length !== 32) {
    throw new TotpError('TOTP_ENCRYPTION_KEY must be 32 bytes of hex (64 characters)', 'NO_KEY')
  }
  return buf
}

export function generateSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32
}

/** AES-256-GCM, stored as `iv.tag.ciphertext` in hex. */
export function encryptSecret(secret: string, key?: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv)
  const enc = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join('.')
}

export function decryptSecret(payload: string, key?: string): string {
  const [ivHex, tagHex, dataHex] = payload.split('.')
  if (!ivHex || !tagHex || !dataHex) throw new Error('malformed encrypted TOTP secret')

  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8')
}

export function enrolmentUri(args: { secret: string; email: string }): string {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: args.email,
    secret: OTPAuth.Secret.fromBase32(args.secret),
  }).toString()
}

function totpFor(secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) })
}

/**
 * Issue a secret and store it encrypted, but leave TOTP disabled until the user proves they
 * can generate a code. Enabling on issue would lock out anyone whose scan failed.
 */
export async function beginEnrolment(
  db: Db,
  userId: string,
): Promise<{ secret: string; uri: string }> {
  const [row] = await db
    .select({ email: users.email, enabled: users.totpEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!row) throw new TotpError(`no user ${userId}`, 'NOT_ENROLLED')
  if (row.enabled) throw new TotpError('TOTP is already enabled', 'ALREADY_ENROLLED')

  const secret = generateSecret()
  await db
    .update(users)
    .set({ totpSecretEnc: encryptSecret(secret) })
    .where(eq(users.id, userId))

  return { secret, uri: enrolmentUri({ secret, email: row.email }) }
}

export async function confirmEnrolment(db: Db, userId: string, code: string): Promise<void> {
  const [row] = await db
    .select({ enc: users.totpSecretEnc })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!row?.enc) throw new TotpError('enrolment has not been started', 'NOT_ENROLLED')

  const secret = decryptSecret(row.enc)
  if (totpFor(secret).validate({ token: code, window: WINDOW }) === null) {
    throw new TotpError('incorrect code', 'INVALID_CODE')
  }

  await db.update(users).set({ totpEnabled: true }).where(eq(users.id, userId))
}

export async function verifyTotp(db: Db, userId: string, code: string): Promise<void> {
  const [row] = await db
    .select({ enc: users.totpSecretEnc, enabled: users.totpEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (!row?.enabled || !row.enc) throw new TotpError('TOTP is not enrolled', 'NOT_ENROLLED')

  const secret = decryptSecret(row.enc)
  if (totpFor(secret).validate({ token: code, window: WINDOW }) === null) {
    throw new TotpError('incorrect code', 'INVALID_CODE')
  }
}
```

- [ ] **Step 5: Extend `.env.example`**

```
# 32 bytes of hex. Generate with: openssl rand -hex 32
TOTP_ENCRYPTION_KEY=
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm test tests/auth/totp.test.ts
pnpm typecheck
```

Expected: PASS, 14 tests.

- [ ] **Step 7: Commit and push**

```bash
git add src/lib/auth/totp.ts tests/auth/totp.test.ts .env.example package.json pnpm-lock.yaml
git commit -m "feat: encrypted TOTP secrets with two-phase enrolment"
git push origin main
```

---

## Task 2: Withdrawal schema and request creation

**Files:**
- Create: `migrations/0005_withdrawals.sql`, `src/lib/withdrawals/request.ts`
- Modify: `src/lib/db/schema.ts`, `tests/helpers/db.ts`
- Test: `tests/withdrawals/request.test.ts`

**Interfaces:**
- Consumes: `postTransaction`, `userAvailableAccount`, `userPendingWithdrawalAccount`, `verifyTotp`, `isTronAddress`, `MIN_STAKE_MICROS`
- Produces (`src/lib/withdrawals/request.ts`):
  - `class WithdrawalError extends Error { code: 'INSUFFICIENT_FUNDS' | 'BELOW_MINIMUM' | 'INVALID_ADDRESS' | 'LOCKED' | 'NOT_FOUND' | 'NOT_CANCELLABLE' }`
  - `MIN_WITHDRAWAL_MICROS = 10_000_000n` (10 USDT — below this the network fee dominates)
  - `requestWithdrawal(db: Db, args: { userId: string; address: string; amountMicros: bigint; totpCode: string }): Promise<{ requestId: string }>`
  - `cancelWithdrawal(db: Db, args: { userId: string; requestId: string }): Promise<void>`
  - `listUserWithdrawals(x: Executor, userId: string): Promise<UserWithdrawal[]>`

- [ ] **Step 1: Write the migration**

`migrations/0005_withdrawals.sql`:

```sql
CREATE TYPE withdrawal_status AS ENUM (
  'REQUESTED', 'APPROVED', 'BROADCAST', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'FAILED'
);

CREATE TABLE withdrawal_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  address       TEXT NOT NULL,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  status        withdrawal_status NOT NULL DEFAULT 'REQUESTED',
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by   UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at   TIMESTAMPTZ,
  review_note   TEXT,
  signer_job_id UUID REFERENCES signer_jobs(id) ON DELETE RESTRICT,
  tx_hash       TEXT,
  broadcast_at  TIMESTAMPTZ,
  confirmed_at  TIMESTAMPTZ,
  failure_reason TEXT,
  CONSTRAINT withdrawals_reviewed_together CHECK (
    (reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX withdrawals_status_idx ON withdrawal_requests (status, requested_at);
CREATE INDEX withdrawals_user_idx   ON withdrawal_requests (user_id, requested_at DESC);
```

- [ ] **Step 2: Extend the Drizzle schema**

Append to `src/lib/db/schema.ts`:

```ts
export const withdrawalStatus = pgEnum('withdrawal_status', [
  'REQUESTED',
  'APPROVED',
  'BROADCAST',
  'CONFIRMED',
  'REJECTED',
  'CANCELLED',
  'FAILED',
])

export const withdrawalRequests = pgTable(
  'withdrawal_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    address: text('address').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    status: withdrawalStatus('status').notNull().default('REQUESTED'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    signerJobId: uuid('signer_job_id').references(() => signerJobs.id),
    txHash: text('tx_hash'),
    broadcastAt: timestamp('broadcast_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
  },
  (t) => [
    index('withdrawals_status_idx').on(t.status, t.requestedAt),
    index('withdrawals_user_idx').on(t.userId),
  ],
)
```

- [ ] **Step 3: Extend the truncation helper**

Add `withdrawal_requests` to the front of the `TRUNCATE` list in `tests/helpers/db.ts`.

- [ ] **Step 4: Write the failing test**

`tests/withdrawals/request.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import * as OTPAuth from 'otpauth'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { users, withdrawalRequests } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { creditUser } from '@/lib/admin/credit'
import { beginEnrolment, confirmEnrolment } from '@/lib/auth/totp'
import { requestWithdrawal, cancelWithdrawal, listUserWithdrawals } from '@/lib/withdrawals/request'
import { balanceOf, userAvailableAccount, userPendingWithdrawalAccount } from '@/lib/ledger/accounts'

const USDT = 1_000_000n
const DEST = 'TEnzFm6jmsVnizS7RSuBr7H6zzn4e7H7Pb'

describe('requestWithdrawal', () => {
  let db: Db
  let user: string
  let admin: string
  let secret: string

  beforeAll(async () => {
    ;({ db } = await testDb())
    process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64)
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })
    secret = (await beginEnrolment(db, user)).secret
    await confirmEnrolment(db, user, code())
  })

  function code(): string {
    return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
  }

  async function available(): Promise<bigint> {
    return balanceOf(db, await userAvailableAccount(db, user))
  }
  async function pending(): Promise<bigint> {
    return balanceOf(db, await userPendingWithdrawalAccount(db, user))
  }

  it('ring-fences the funds immediately', async () => {
    await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 40n * USDT,
      totpCode: code(),
    })

    expect(await available()).toBe(60n * USDT)
    expect(await pending()).toBe(40n * USDT)
  })

  it('records the request as REQUESTED', async () => {
    const { requestId } = await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 40n * USDT,
      totpCode: code(),
    })

    const [row] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('REQUESTED')
    expect(row.address).toBe(DEST)
    expect(row.amount).toBe(40n * USDT)
  })

  it('refuses a wrong TOTP code and moves nothing', async () => {
    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 40n * USDT,
        totpCode: '000000',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' })

    expect(await available()).toBe(100n * USDT)
    expect(await pending()).toBe(0n)
  })

  it('refuses a user who has not enrolled in TOTP', async () => {
    const other = await makeUser(db)
    await creditUser(db, { userId: other, amount: 50n * USDT, reference: 'o', creditedBy: admin })

    await expect(
      requestWithdrawal(db, {
        userId: other,
        address: DEST,
        amountMicros: 10n * USDT,
        totpCode: '123456',
      }),
    ).rejects.toMatchObject({ code: 'NOT_ENROLLED' })
  })

  it('refuses more than the available balance', async () => {
    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 101n * USDT,
        totpCode: code(),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' })
    expect(await available()).toBe(100n * USDT)
  })

  it('counts already-pending withdrawals against the balance', async () => {
    // The whole point of ring-fencing: a second request cannot spend the first one's funds.
    await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 60n * USDT,
      totpCode: code(),
    })

    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 60n * USDT,
        totpCode: code(),
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' })
  })

  it('refuses an amount below the minimum', async () => {
    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 9n * USDT,
        totpCode: code(),
      }),
    ).rejects.toMatchObject({ code: 'BELOW_MINIMUM' })
  })

  it('refuses a malformed destination address', async () => {
    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: 'not-a-tron-address',
        amountMicros: 20n * USDT,
        totpCode: code(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' })
  })

  it('refuses when the account is withdrawal_locked', async () => {
    await db.update(users).set({ withdrawalLocked: true }).where(eq(users.id, user))

    await expect(
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 20n * USDT,
        totpCode: code(),
      }),
    ).rejects.toMatchObject({ code: 'LOCKED' })
    expect(await available()).toBe(100n * USDT)
  })

  it('never overdraws under concurrent requests', async () => {
    // 100 USDT of balance, five simultaneous 30 USDT requests: at most three may succeed.
    const attempts = Array.from({ length: 5 }, () =>
      requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 30n * USDT,
        totpCode: code(),
      }).then(
        () => 'ok' as const,
        () => 'rejected' as const,
      ),
    )

    const results = await Promise.all(attempts)
    expect(results.filter((r) => r === 'ok').length).toBeLessThanOrEqual(3)
    expect(await available()).toBeGreaterThanOrEqual(0n)
    expect((await available()) + (await pending())).toBe(100n * USDT)
  })
})

describe('cancelWithdrawal', () => {
  let db: Db
  let user: string
  let admin: string
  let secret: string

  beforeAll(async () => {
    ;({ db } = await testDb())
    process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64)
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })
    secret = (await beginEnrolment(db, user)).secret
    await confirmEnrolment(
      db,
      user,
      new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate(),
    )
  })

  function code(): string {
    return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
  }

  it('returns the funds and marks it CANCELLED', async () => {
    const { requestId } = await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 40n * USDT,
      totpCode: code(),
    })

    await cancelWithdrawal(db, { userId: user, requestId })

    expect(await balanceOf(db, await userAvailableAccount(db, user))).toBe(100n * USDT)
    expect(await balanceOf(db, await userPendingWithdrawalAccount(db, user))).toBe(0n)

    const [row] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('CANCELLED')
  })

  it('is idempotent — cancelling twice returns the funds once', async () => {
    const { requestId } = await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 40n * USDT,
      totpCode: code(),
    })

    await cancelWithdrawal(db, { userId: user, requestId })
    await cancelWithdrawal(db, { userId: user, requestId })

    expect(await balanceOf(db, await userAvailableAccount(db, user))).toBe(100n * USDT)
  })

  it("refuses to cancel another user's request", async () => {
    const { requestId } = await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 40n * USDT,
      totpCode: code(),
    })
    const other = await makeUser(db)

    await expect(cancelWithdrawal(db, { userId: other, requestId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(await balanceOf(db, await userPendingWithdrawalAccount(db, user))).toBe(40n * USDT)
  })

  it('lists a user\'s withdrawals newest first', async () => {
    await requestWithdrawal(db, {
      userId: user,
      address: DEST,
      amountMicros: 20n * USDT,
      totpCode: code(),
    })
    const listed = await listUserWithdrawals(db, user)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ address: DEST, amount: 20n * USDT, status: 'REQUESTED' })
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm test tests/withdrawals/request.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/withdrawals/request"`.

- [ ] **Step 6: Write the implementation**

`src/lib/withdrawals/request.ts`:

```ts
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db, Executor } from '@/lib/db/client'
import { users, withdrawalRequests } from '@/lib/db/schema'
import {
  balanceOf,
  userAvailableAccount,
  userPendingWithdrawalAccount,
} from '@/lib/ledger/accounts'
import { postTransaction } from '@/lib/ledger/post'
import { verifyTotp } from '@/lib/auth/totp'
import { isTronAddress } from '@/lib/tron/address'

export const MIN_WITHDRAWAL_MICROS = 10_000_000n

export class WithdrawalError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INSUFFICIENT_FUNDS'
      | 'BELOW_MINIMUM'
      | 'INVALID_ADDRESS'
      | 'LOCKED'
      | 'NOT_FOUND'
      | 'NOT_CANCELLABLE',
  ) {
    super(message)
    this.name = 'WithdrawalError'
  }
}

export type UserWithdrawal = {
  id: string
  address: string
  amount: bigint
  status: string
  requestedAt: Date
  txHash: string | null
  failureReason: string | null
}

/**
 * Create a withdrawal request and ring-fence its funds in the same transaction.
 *
 * The ledger move happens before any human or chain involvement: a request that exists
 * without its funds moved out of `user_available` is a double-spend waiting to happen,
 * because the user could stake the same money while an admin reviews the withdrawal.
 */
export async function requestWithdrawal(
  db: Db,
  args: { userId: string; address: string; amountMicros: bigint; totpCode: string },
): Promise<{ requestId: string }> {
  if (!isTronAddress(args.address)) {
    throw new WithdrawalError(`not a valid Tron address: ${args.address}`, 'INVALID_ADDRESS')
  }
  if (args.amountMicros < MIN_WITHDRAWAL_MICROS) {
    throw new WithdrawalError(
      `minimum withdrawal is ${MIN_WITHDRAWAL_MICROS} micro-units`,
      'BELOW_MINIMUM',
    )
  }

  // TOTP is checked before the lock so a wrong code costs nothing.
  await verifyTotp(db, args.userId, args.totpCode)

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, locked: users.withdrawalLocked })
      .from(users)
      .where(eq(users.id, args.userId))
      .for('update')
      .limit(1)

    if (!user) throw new WithdrawalError(`no user ${args.userId}`, 'NOT_FOUND')
    if (user.locked) {
      throw new WithdrawalError('withdrawals are locked on this account', 'LOCKED')
    }

    const availableAccount = await userAvailableAccount(tx, args.userId)
    const available = await balanceOf(tx, availableAccount)
    if (available < args.amountMicros) {
      throw new WithdrawalError(
        `balance ${available} is less than ${args.amountMicros}`,
        'INSUFFICIENT_FUNDS',
      )
    }

    const [created] = await tx
      .insert(withdrawalRequests)
      .values({ userId: args.userId, address: args.address, amount: args.amountMicros })
      .returning({ id: withdrawalRequests.id })

    const pendingAccount = await userPendingWithdrawalAccount(tx, args.userId)
    await postTransaction(tx, {
      kind: 'WITHDRAWAL_REQUESTED',
      idempotencyKey: `withdrawal:request:${created.id}`,
      metadata: { userId: args.userId, requestId: created.id, address: args.address },
      legs: [
        { accountId: availableAccount, amount: -args.amountMicros },
        { accountId: pendingAccount, amount: args.amountMicros },
      ],
    })

    return { requestId: created.id }
  })
}

/** Return ring-fenced funds to the user. Only a REQUESTED withdrawal can be cancelled. */
export async function cancelWithdrawal(
  db: Db,
  args: { userId: string; requestId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: withdrawalRequests.id,
        amount: withdrawalRequests.amount,
        status: withdrawalRequests.status,
      })
      .from(withdrawalRequests)
      .where(
        and(
          eq(withdrawalRequests.id, args.requestId),
          eq(withdrawalRequests.userId, args.userId),
        ),
      )
      .for('update')
      .limit(1)

    if (!request) throw new WithdrawalError(`no withdrawal ${args.requestId}`, 'NOT_FOUND')
    if (request.status === 'CANCELLED') return // already returned; replaying is a no-op
    if (request.status !== 'REQUESTED') {
      throw new WithdrawalError(`withdrawal is ${request.status}`, 'NOT_CANCELLABLE')
    }

    const [availableAccount, pendingAccount] = await Promise.all([
      userAvailableAccount(tx, args.userId),
      userPendingWithdrawalAccount(tx, args.userId),
    ])

    await postTransaction(tx, {
      kind: 'WITHDRAWAL_CANCELLED',
      idempotencyKey: `withdrawal:cancel:${request.id}`,
      metadata: { userId: args.userId, requestId: request.id },
      legs: [
        { accountId: pendingAccount, amount: -request.amount },
        { accountId: availableAccount, amount: request.amount },
      ],
    })

    await tx
      .update(withdrawalRequests)
      .set({ status: 'CANCELLED' })
      .where(eq(withdrawalRequests.id, request.id))
  })
}

export async function listUserWithdrawals(
  x: Executor,
  userId: string,
): Promise<UserWithdrawal[]> {
  const rows = await x
    .select({
      id: withdrawalRequests.id,
      address: withdrawalRequests.address,
      amount: withdrawalRequests.amount,
      status: withdrawalRequests.status,
      requestedAt: withdrawalRequests.requestedAt,
      txHash: withdrawalRequests.txHash,
      failureReason: withdrawalRequests.failureReason,
    })
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.userId, userId))
    .orderBy(desc(withdrawalRequests.requestedAt))
  return rows as UserWithdrawal[]
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm test tests/withdrawals/request.test.ts
pnpm typecheck
```

Expected: PASS, 14 tests. Run three times — the concurrency test is the one that matters.

- [ ] **Step 8: Commit and push**

```bash
git add migrations/0005_withdrawals.sql src/lib/db/schema.ts src/lib/withdrawals tests/withdrawals tests/helpers/db.ts
git commit -m "feat: withdrawal requests with immediate ledger ring-fencing"
git push origin main
```

---

## Task 3: Admin review — approve and reject

**Files:**
- Create: `src/lib/withdrawals/review.ts`
- Test: `tests/withdrawals/review.test.ts`

**Interfaces:**
- Consumes: `enqueueJob` (Slice 2), `postTransaction`, `WithdrawalError`
- Produces (`src/lib/withdrawals/review.ts`):
  - `type PendingReview = { id: string; userId: string; email: string; address: string; amount: bigint; requestedAt: Date }`
  - `listPendingWithdrawals(x: Executor): Promise<PendingReview[]>`
  - `approveWithdrawal(db: Db, args: { requestId: string; adminId: string; note?: string }): Promise<{ jobId: string }>`
  - `rejectWithdrawal(db: Db, args: { requestId: string; adminId: string; note: string }): Promise<void>`

Approval moves no money — the funds are already ring-fenced. It enqueues a `WITHDRAW` signer
job keyed on the request id, so a double-clicked approve produces one job.

- [ ] **Step 1: Write the failing test**

`tests/withdrawals/review.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { signerJobs, withdrawalRequests } from '@/lib/db/schema'
import { creditUser } from '@/lib/admin/credit'
import { beginEnrolment, confirmEnrolment } from '@/lib/auth/totp'
import { requestWithdrawal } from '@/lib/withdrawals/request'
import {
  listPendingWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
} from '@/lib/withdrawals/review'
import { balanceOf, userAvailableAccount, userPendingWithdrawalAccount } from '@/lib/ledger/accounts'

const USDT = 1_000_000n
const DEST = 'TEnzFm6jmsVnizS7RSuBr7H6zzn4e7H7Pb'

describe('withdrawal review', () => {
  let db: Db
  let user: string
  let admin: string
  let secret: string
  let requestId: string

  beforeAll(async () => {
    ;({ db } = await testDb())
    process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64)
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })
    secret = (await beginEnrolment(db, user)).secret
    await confirmEnrolment(db, user, code())
    requestId = (
      await requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 40n * USDT,
        totpCode: code(),
      })
    ).requestId
  })

  function code(): string {
    return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
  }

  it('lists a requested withdrawal for review with the user email', async () => {
    const pending = await listPendingWithdrawals(db)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: requestId, address: DEST, amount: 40n * USDT })
    expect(pending[0].email).toContain('@example.com')
  })

  it('approving enqueues a signer job and moves no money', async () => {
    const { jobId } = await approveWithdrawal(db, { requestId, adminId: admin })

    const [job] = await db.select().from(signerJobs).where(eq(signerJobs.id, jobId))
    expect(job.kind).toBe('WITHDRAW')
    expect(job.status).toBe('PENDING')

    // Funds stay ring-fenced; nothing returns to available.
    expect(await balanceOf(db, await userAvailableAccount(db, user))).toBe(60n * USDT)
    expect(await balanceOf(db, await userPendingWithdrawalAccount(db, user))).toBe(40n * USDT)

    const [row] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('APPROVED')
    expect(row.reviewedBy).toBe(admin)
    expect(row.reviewedAt).not.toBeNull()
    expect(row.signerJobId).toBe(jobId)
  })

  it('double-clicking approve produces exactly one job', async () => {
    const first = await approveWithdrawal(db, { requestId, adminId: admin })
    const second = await approveWithdrawal(db, { requestId, adminId: admin })

    expect(second.jobId).toBe(first.jobId)
    expect(await db.select().from(signerJobs)).toHaveLength(1)
  })

  it('two concurrent approvals produce exactly one job', async () => {
    const results = await Promise.allSettled([
      approveWithdrawal(db, { requestId, adminId: admin }),
      approveWithdrawal(db, { requestId, adminId: admin }),
    ])
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    expect(await db.select().from(signerJobs)).toHaveLength(1)
  })

  it('rejecting returns the funds', async () => {
    await rejectWithdrawal(db, { requestId, adminId: admin, note: 'suspicious pattern' })

    expect(await balanceOf(db, await userAvailableAccount(db, user))).toBe(100n * USDT)
    expect(await balanceOf(db, await userPendingWithdrawalAccount(db, user))).toBe(0n)

    const [row] = await db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('REJECTED')
    expect(row.reviewNote).toBe('suspicious pattern')
  })

  it('rejecting twice returns the funds once', async () => {
    await rejectWithdrawal(db, { requestId, adminId: admin, note: 'no' })
    await rejectWithdrawal(db, { requestId, adminId: admin, note: 'no' })
    expect(await balanceOf(db, await userAvailableAccount(db, user))).toBe(100n * USDT)
  })

  it('cannot reject an already approved withdrawal', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    await expect(
      rejectWithdrawal(db, { requestId, adminId: admin, note: 'changed my mind' }),
    ).rejects.toMatchObject({ code: 'NOT_REVIEWABLE' })
  })

  it('cannot approve an already rejected withdrawal', async () => {
    await rejectWithdrawal(db, { requestId, adminId: admin, note: 'no' })
    await expect(approveWithdrawal(db, { requestId, adminId: admin })).rejects.toMatchObject({
      code: 'NOT_REVIEWABLE',
    })
  })

  it('drops a reviewed withdrawal off the pending list', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    expect(await listPendingWithdrawals(db)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/withdrawals/review.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/withdrawals/review"`.

- [ ] **Step 3: Write the implementation**

`src/lib/withdrawals/review.ts`. Add `'NOT_REVIEWABLE'` to `WithdrawalError`'s code union in
`request.ts` as part of this step.

```ts
import { asc, eq, sql } from 'drizzle-orm'
import type { Db, Executor } from '@/lib/db/client'
import { users, withdrawalRequests } from '@/lib/db/schema'
import { userAvailableAccount, userPendingWithdrawalAccount } from '@/lib/ledger/accounts'
import { postTransaction } from '@/lib/ledger/post'
import { enqueueJob } from '@/lib/signer/jobs'
import { WithdrawalError } from './request'

export type PendingReview = {
  id: string
  userId: string
  email: string
  address: string
  amount: bigint
  requestedAt: Date
}

export async function listPendingWithdrawals(x: Executor): Promise<PendingReview[]> {
  const rows = await x
    .select({
      id: withdrawalRequests.id,
      userId: withdrawalRequests.userId,
      email: users.email,
      address: withdrawalRequests.address,
      amount: withdrawalRequests.amount,
      requestedAt: withdrawalRequests.requestedAt,
    })
    .from(withdrawalRequests)
    .innerJoin(users, eq(users.id, withdrawalRequests.userId))
    .where(eq(withdrawalRequests.status, 'REQUESTED'))
    .orderBy(asc(withdrawalRequests.requestedAt))
  return rows as PendingReview[]
}

/**
 * Approve a withdrawal and hand it to the signer.
 *
 * No ledger movement happens here — the funds were ring-fenced at request time. The signer
 * job is keyed on the request id, so a double-clicked approve button enqueues one job.
 */
export async function approveWithdrawal(
  db: Db,
  args: { requestId: string; adminId: string; note?: string },
): Promise<{ jobId: string }> {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: withdrawalRequests.id,
        userId: withdrawalRequests.userId,
        address: withdrawalRequests.address,
        amount: withdrawalRequests.amount,
        status: withdrawalRequests.status,
        signerJobId: withdrawalRequests.signerJobId,
      })
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, args.requestId))
      .for('update')
      .limit(1)

    if (!request) throw new WithdrawalError(`no withdrawal ${args.requestId}`, 'NOT_FOUND')

    // Replaying an approval returns the original job rather than making a second one.
    if (request.status === 'APPROVED' && request.signerJobId) {
      return { jobId: request.signerJobId }
    }
    if (request.status !== 'REQUESTED') {
      throw new WithdrawalError(`withdrawal is ${request.status}`, 'NOT_REVIEWABLE')
    }

    const { jobId } = await enqueueJob(tx as unknown as Db, {
      kind: 'WITHDRAW',
      idempotencyKey: `withdraw:${request.id}`,
      payload: {
        requestId: request.id,
        userId: request.userId,
        address: request.address,
        amountMicros: request.amount.toString(),
      },
    })

    await tx
      .update(withdrawalRequests)
      .set({
        status: 'APPROVED',
        reviewedBy: args.adminId,
        reviewedAt: sql`now()`,
        reviewNote: args.note ?? null,
        signerJobId: jobId,
      })
      .where(eq(withdrawalRequests.id, request.id))

    return { jobId }
  })
}

export async function rejectWithdrawal(
  db: Db,
  args: { requestId: string; adminId: string; note: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: withdrawalRequests.id,
        userId: withdrawalRequests.userId,
        amount: withdrawalRequests.amount,
        status: withdrawalRequests.status,
      })
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, args.requestId))
      .for('update')
      .limit(1)

    if (!request) throw new WithdrawalError(`no withdrawal ${args.requestId}`, 'NOT_FOUND')
    if (request.status === 'REJECTED') return // funds already returned
    if (request.status !== 'REQUESTED') {
      throw new WithdrawalError(`withdrawal is ${request.status}`, 'NOT_REVIEWABLE')
    }

    const [availableAccount, pendingAccount] = await Promise.all([
      userAvailableAccount(tx, request.userId),
      userPendingWithdrawalAccount(tx, request.userId),
    ])

    await postTransaction(tx, {
      kind: 'WITHDRAWAL_REJECTED',
      idempotencyKey: `withdrawal:reject:${request.id}`,
      metadata: { requestId: request.id, adminId: args.adminId },
      legs: [
        { accountId: pendingAccount, amount: -request.amount },
        { accountId: availableAccount, amount: request.amount },
      ],
    })

    await tx
      .update(withdrawalRequests)
      .set({
        status: 'REJECTED',
        reviewedBy: args.adminId,
        reviewedAt: sql`now()`,
        reviewNote: args.note,
      })
      .where(eq(withdrawalRequests.id, request.id))
  })
}
```

**Note on `enqueueJob(tx as unknown as Db, …)`:** Slice 2's `enqueueJob` takes a `Db`, but this
must enlist in the surrounding transaction or an approval could commit without its job. If
Slice 2 shipped `enqueueJob` accepting an `Executor`, drop the cast. If it did not, widen its
signature to `Executor` as part of this step rather than leaving the cast in place — a cast
that silently breaks atomicity on a money path is not acceptable.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test tests/withdrawals/review.test.ts
pnpm typecheck
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit and push**

```bash
git add src/lib/withdrawals tests/withdrawals
git commit -m "feat: admin approve and reject for withdrawals"
git push origin main
```

---

## Task 4: Signer withdrawal execution and confirmation tracking

**Files:**
- Modify: `src/lib/signer/run.ts` (handle the `WITHDRAW` kind)
- Create: `src/lib/withdrawals/settle.ts`, `src/lib/withdrawals/poller.ts`
- Modify: `worker/main.ts`
- Test: `tests/withdrawals/settle.test.ts`

**Interfaces:**
- Consumes: `TronClient`, `runOnce`, `postTransaction`, `houseAccount`
- Produces (`src/lib/withdrawals/settle.ts`):
  - `markBroadcast(db: Db, args: { requestId: string; txHash: string }): Promise<void>`
  - `confirmWithdrawal(db: Db, requestId: string): Promise<void>` — `user_pending_withdrawal → hot_wallet`
  - `failWithdrawal(db: Db, args: { requestId: string; reason: string }): Promise<void>` — returns funds
- Produces (`src/lib/withdrawals/poller.ts`):
  - `pollWithdrawals(db: Db, tron: TronClient, opts: { confirmations: number }): Promise<{ confirmed: string[] }>`

- [ ] **Step 1: Write the failing test**

`tests/withdrawals/settle.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import * as OTPAuth from 'otpauth'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { withdrawalRequests } from '@/lib/db/schema'
import { creditUser } from '@/lib/admin/credit'
import { beginEnrolment, confirmEnrolment } from '@/lib/auth/totp'
import { requestWithdrawal } from '@/lib/withdrawals/request'
import { approveWithdrawal } from '@/lib/withdrawals/review'
import { markBroadcast, confirmWithdrawal, failWithdrawal } from '@/lib/withdrawals/settle'
import { runOnce } from '@/lib/signer/run'
import { FakeTron } from '@/lib/tron/fake'
import { balanceOf, userAvailableAccount, userPendingWithdrawalAccount, houseAccount } from '@/lib/ledger/accounts'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEED = mnemonicToSeedSync(MNEMONIC)
const USDT = 1_000_000n
const DEST = 'TEnzFm6jmsVnizS7RSuBr7H6zzn4e7H7Pb'
const HOT = 'TTTFe9haCY6CACG9iTM8uyL89pFEPy4ctW'

describe('withdrawal settlement', () => {
  let db: Db
  let user: string
  let admin: string
  let secret: string
  let requestId: string

  beforeAll(async () => {
    ;({ db } = await testDb())
    process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64)
  })

  beforeEach(async () => {
    await truncateAll(db)
    admin = await makeAdmin(db)
    user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })
    secret = (await beginEnrolment(db, user)).secret
    await confirmEnrolment(db, user, code())
    requestId = (
      await requestWithdrawal(db, {
        userId: user,
        address: DEST,
        amountMicros: 40n * USDT,
        totpCode: code(),
      })
    ).requestId
  })

  function code(): string {
    return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate()
  }

  const pending = async () => balanceOf(db, await userPendingWithdrawalAccount(db, user))
  const available = async () => balanceOf(db, await userAvailableAccount(db, user))
  const hot = async () => balanceOf(db, await houseAccount(db, 'hot_wallet'))

  it('records a broadcast without moving money', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    await markBroadcast(db, { requestId, txHash: 'deadbeef' })

    const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('BROADCAST')
    expect(row.txHash).toBe('deadbeef')
    expect(await pending()).toBe(40n * USDT)
  })

  it('closes out pending into hot_wallet on confirmation', async () => {
    const hotBefore = await hot()
    await approveWithdrawal(db, { requestId, adminId: admin })
    await markBroadcast(db, { requestId, txHash: 'deadbeef' })
    await confirmWithdrawal(db, requestId)

    expect(await pending()).toBe(0n)
    expect(await available()).toBe(60n * USDT)
    // Custody is carried inverted, so money leaving reduces the obligation.
    expect(await hot()).toBe(hotBefore + 40n * USDT)

    const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('CONFIRMED')
    expect(row.confirmedAt).not.toBeNull()
  })

  it('confirming twice moves money once', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    await markBroadcast(db, { requestId, txHash: 'deadbeef' })
    await confirmWithdrawal(db, requestId)
    const hotAfterFirst = await hot()
    await confirmWithdrawal(db, requestId)

    expect(await hot()).toBe(hotAfterFirst)
    expect(await pending()).toBe(0n)
  })

  it('returns the funds when the broadcast fails', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    await failWithdrawal(db, { requestId, reason: 'insufficient energy' })

    expect(await pending()).toBe(0n)
    expect(await available()).toBe(100n * USDT)

    const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('FAILED')
    expect(row.failureReason).toBe('insufficient energy')
  })

  it('failing twice returns the funds once', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })
    await failWithdrawal(db, { requestId, reason: 'x' })
    await failWithdrawal(db, { requestId, reason: 'x' })
    expect(await available()).toBe(100n * USDT)
  })

  it('the signer broadcasts an approved withdrawal end to end', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })

    const tron = new FakeTron()
    // Fund the hot wallet on the fake chain so the send can succeed.
    tron.deposit({ to: HOT, amountMicros: 500n * USDT, blockNumber: 1 })

    expect(await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })).toBe('done')

    expect(tron.broadcasts).toHaveLength(1)
    expect(tron.broadcasts[0]).toMatchObject({ to: DEST, amountMicros: 40n * USDT })

    const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('BROADCAST')
    expect(row.txHash).toBe(tron.broadcasts[0].txHash)
  })

  it('a failed signer broadcast returns the funds to the user', async () => {
    await approveWithdrawal(db, { requestId, adminId: admin })

    const tron = new FakeTron()
    tron.deposit({ to: HOT, amountMicros: 500n * USDT, blockNumber: 1 })

    // Exhaust every retry so the job is parked and the withdrawal fails for good.
    for (let i = 0; i < 5; i++) {
      tron.failNextSend('node unreachable')
      await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT })
    }

    const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, requestId))
    expect(row.status).toBe('FAILED')
    expect(await available()).toBe(100n * USDT)
    expect(await pending()).toBe(0n)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/withdrawals/settle.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/withdrawals/settle"`.

- [ ] **Step 3: Write the settlement module**

`src/lib/withdrawals/settle.ts`:

```ts
import { eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { withdrawalRequests } from '@/lib/db/schema'
import {
  houseAccount,
  userAvailableAccount,
  userPendingWithdrawalAccount,
} from '@/lib/ledger/accounts'
import { postTransaction } from '@/lib/ledger/post'
import { WithdrawalError } from './request'

export async function markBroadcast(
  db: Db,
  args: { requestId: string; txHash: string },
): Promise<void> {
  await db
    .update(withdrawalRequests)
    .set({ status: 'BROADCAST', txHash: args.txHash, broadcastAt: sql`now()` })
    .where(eq(withdrawalRequests.id, args.requestId))
}

/**
 * The money has genuinely left the platform. Close out the ring-fence against chain custody:
 * `hot_wallet` is carried with inverted sign, so a positive leg here *reduces* the custody
 * obligation by the amount that left.
 */
export async function confirmWithdrawal(db: Db, requestId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: withdrawalRequests.id,
        userId: withdrawalRequests.userId,
        amount: withdrawalRequests.amount,
        status: withdrawalRequests.status,
      })
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, requestId))
      .for('update')
      .limit(1)

    if (!request) throw new WithdrawalError(`no withdrawal ${requestId}`, 'NOT_FOUND')
    if (request.status === 'CONFIRMED') return
    if (request.status !== 'BROADCAST') {
      throw new WithdrawalError(`withdrawal is ${request.status}`, 'NOT_REVIEWABLE')
    }

    const [pendingAccount, hotWallet] = await Promise.all([
      userPendingWithdrawalAccount(tx, request.userId),
      houseAccount(tx, 'hot_wallet'),
    ])

    await postTransaction(tx, {
      kind: 'WITHDRAWAL_CONFIRMED',
      idempotencyKey: `withdrawal:confirm:${request.id}`,
      metadata: { requestId: request.id, userId: request.userId },
      legs: [
        { accountId: pendingAccount, amount: -request.amount },
        { accountId: hotWallet, amount: request.amount },
      ],
    })

    await tx
      .update(withdrawalRequests)
      .set({ status: 'CONFIRMED', confirmedAt: sql`now()` })
      .where(eq(withdrawalRequests.id, request.id))
  })
}

/** The withdrawal will never land. Return the ring-fenced funds to the user. */
export async function failWithdrawal(
  db: Db,
  args: { requestId: string; reason: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: withdrawalRequests.id,
        userId: withdrawalRequests.userId,
        amount: withdrawalRequests.amount,
        status: withdrawalRequests.status,
      })
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.id, args.requestId))
      .for('update')
      .limit(1)

    if (!request) throw new WithdrawalError(`no withdrawal ${args.requestId}`, 'NOT_FOUND')
    if (request.status === 'FAILED') return
    if (request.status === 'CONFIRMED') {
      throw new WithdrawalError('cannot fail a confirmed withdrawal', 'NOT_REVIEWABLE')
    }

    const [availableAccount, pendingAccount] = await Promise.all([
      userAvailableAccount(tx, request.userId),
      userPendingWithdrawalAccount(tx, request.userId),
    ])

    await postTransaction(tx, {
      kind: 'WITHDRAWAL_FAILED',
      idempotencyKey: `withdrawal:fail:${request.id}`,
      metadata: { requestId: request.id, reason: args.reason },
      legs: [
        { accountId: pendingAccount, amount: -request.amount },
        { accountId: availableAccount, amount: request.amount },
      ],
    })

    await tx
      .update(withdrawalRequests)
      .set({ status: 'FAILED', failureReason: args.reason })
      .where(eq(withdrawalRequests.id, request.id))
  })
}
```

- [ ] **Step 4: Teach the signer to handle WITHDRAW jobs**

In `src/lib/signer/run.ts`, replace the single-kind guard with a switch. The withdrawal is sent
from the hot wallet key — derivation index 0 by convention, matching
`TRON_HOT_WALLET_ADDRESS`.

```ts
import { markBroadcast, failWithdrawal } from '@/lib/withdrawals/settle'
import { MAX_ATTEMPTS } from './jobs'

export const HOT_WALLET_INDEX = 0

// inside runOnce, replacing the `if (job.kind !== 'SWEEP')` guard:
  if (job.kind !== 'SWEEP' && job.kind !== 'WITHDRAW') {
    await failJob(deps.db, job.id, `unknown job kind: ${job.kind}`, { retry: false })
    return 'failed'
  }

  try {
    if (job.kind === 'SWEEP') {
      const payload = job.payload as unknown as SweepPayload
      const txHash = await deps.tron.sendTrc20({
        fromPrivateKeyHex: derivePrivateKeyHex(deps.seed, payload.derivationIndex),
        to: deps.hotWalletAddress,
        amountMicros: BigInt(payload.amountMicros),
      })
      await completeJob(deps.db, job.id, txHash)
      return 'done'
    }

    const payload = job.payload as unknown as {
      requestId: string
      address: string
      amountMicros: string
    }
    const txHash = await deps.tron.sendTrc20({
      fromPrivateKeyHex: derivePrivateKeyHex(deps.seed, HOT_WALLET_INDEX),
      to: payload.address,
      amountMicros: BigInt(payload.amountMicros),
    })
    await markBroadcast(deps.db, { requestId: payload.requestId, txHash })
    await completeJob(deps.db, job.id, txHash)
    return 'done'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const retry = err instanceof TronError
    await failJob(deps.db, job.id, message, { retry })

    // When a withdrawal job is out of retries the user's funds must come back; leaving them
    // ring-fenced against a job nobody will ever run again is money silently frozen.
    if (job.kind === 'WITHDRAW' && (!retry || job.attempts >= MAX_ATTEMPTS)) {
      const payload = job.payload as unknown as { requestId: string }
      await failWithdrawal(deps.db, { requestId: payload.requestId, reason: message })
    }
    return 'failed'
  }
```

- [ ] **Step 5: Write the confirmation poller**

`src/lib/withdrawals/poller.ts`:

```ts
import { eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { withdrawalRequests } from '@/lib/db/schema'
import type { TronClient } from '@/lib/tron/client'
import { confirmWithdrawal } from './settle'

/**
 * Confirm broadcast withdrawals once the destination shows the transfer buried deep enough.
 *
 * The check is deliberately "did a transfer of this amount to this address land in a block
 * at least N deep", rather than trusting the broadcast receipt: a receipt says the node
 * accepted the transaction, not that it survived.
 */
export async function pollWithdrawals(
  db: Db,
  tron: TronClient,
  opts: { confirmations: number },
): Promise<{ confirmed: string[] }> {
  const head = await tron.headBlock()
  const confirmed: string[] = []

  const broadcast = await db
    .select({
      id: withdrawalRequests.id,
      address: withdrawalRequests.address,
      amount: withdrawalRequests.amount,
      txHash: withdrawalRequests.txHash,
    })
    .from(withdrawalRequests)
    .where(eq(withdrawalRequests.status, 'BROADCAST'))

  for (const request of broadcast) {
    try {
      const transfers = await tron.incomingTransfers(request.address)
      const landed = transfers.find(
        (t) =>
          t.txHash === request.txHash &&
          t.amountMicros === request.amount &&
          head - t.blockNumber + 1 >= opts.confirmations,
      )
      if (!landed) continue

      await confirmWithdrawal(db, request.id)
      confirmed.push(request.id)
    } catch (err) {
      console.error(`[withdrawals] failed to check ${request.id}:`, err)
    }
  }

  return { confirmed }
}
```

- [ ] **Step 6: Wire it into the worker**

In `worker/main.ts`, inside `onTick`, after the sweep enqueue:

```ts
    const withdrawals = await pollWithdrawals(db, tron, { confirmations: config.confirmations })
    if (withdrawals.confirmed.length) {
      console.log(`[worker] confirmed ${withdrawals.confirmed.length} withdrawal(s)`)
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm test tests/withdrawals
pnpm typecheck
pnpm build
```

Expected: PASS across all three withdrawal suites.

- [ ] **Step 8: Commit and push**

```bash
git add src/lib/withdrawals src/lib/signer/run.ts worker/main.ts tests/withdrawals
git commit -m "feat: signer withdrawal broadcast and worker confirmation tracking"
git push origin main
```

---

## Task 5: User API and withdrawal page

**Files:**
- Create: `src/app/api/me/totp/route.ts`, `src/app/api/me/totp/confirm/route.ts`
- Create: `src/app/api/me/withdrawals/route.ts`, `src/app/api/me/withdrawals/[id]/cancel/route.ts`
- Create: `src/app/withdraw/page.tsx`, `src/components/TotpEnrolment.tsx`, `src/components/WithdrawForm.tsx`
- Modify: `src/components/Nav.tsx`, `src/lib/http/respond.ts`

**Interfaces:**
- Consumes: `beginEnrolment`, `confirmEnrolment`, `requestWithdrawal`, `cancelWithdrawal`, `listUserWithdrawals`, `requireUser`
- Produces:

| Method & path | Body | Success |
|---|---|---|
| `POST /api/me/totp` | — | `201 { uri, secret }` |
| `POST /api/me/totp/confirm` | `{ code }` | `200 { enabled: true }` |
| `GET /api/me/withdrawals` | — | `200 { withdrawals }` |
| `POST /api/me/withdrawals` | `{ address, amount, totpCode }` | `201 { requestId }` |
| `POST /api/me/withdrawals/:id/cancel` | — | `200 { ok: true }` |

- [ ] **Step 1: Register the new error codes**

In `src/lib/http/respond.ts`, add `TotpError` and `WithdrawalError` to the domain-error
`instanceof` chain, and add to `STATUS_BY_CODE`:

```ts
  // totp
  NOT_ENROLLED: 428,
  ALREADY_ENROLLED: 409,
  INVALID_CODE: 401,
  NO_KEY: 500,
  // withdrawals
  BELOW_MINIMUM: 422,
  INVALID_ADDRESS: 422,
  LOCKED: 403,
  NOT_REVIEWABLE: 409,
  NOT_CANCELLABLE: 409,
```

`428 Precondition Required` is the useful signal for `NOT_ENROLLED`: it tells the client to
send the user through enrolment rather than treating it as a plain authentication failure.

- [ ] **Step 2: Write the TOTP routes**

`src/app/api/me/totp/route.ts`:

```ts
import { getDb } from '@/lib/db/client'
import { beginEnrolment } from '@/lib/auth/totp'
import { handle, ok } from '@/lib/http/respond'
import { requireUser } from '@/lib/http/auth'

export async function POST(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const { secret, uri } = await beginEnrolment(getDb(), user.id)
    return ok({ secret, uri }, { status: 201 })
  })
}
```

`src/app/api/me/totp/confirm/route.ts`:

```ts
import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { confirmEnrolment } from '@/lib/auth/totp'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireUser } from '@/lib/http/auth'

const Body = z.object({ code: z.string().regex(/^\d{6}$/) })

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', 'code must be six digits')

    await confirmEnrolment(getDb(), user.id, parsed.data.code)
    return ok({ enabled: true })
  })
}
```

- [ ] **Step 3: Write the withdrawal routes**

`src/app/api/me/withdrawals/route.ts`:

```ts
import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { parseUsdt } from '@/lib/money/units'
import { requestWithdrawal, listUserWithdrawals } from '@/lib/withdrawals/request'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireUser } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

const Body = z.object({
  address: z.string().min(30).max(50),
  amount: z.string(),
  totpCode: z.string().regex(/^\d{6}$/),
})

export async function GET(): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    return ok({ withdrawals: await listUserWithdrawals(getDb(), user.id) })
  })
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', parsed.error.issues[0].message)

    let amountMicros: bigint
    try {
      amountMicros = parseUsdt(parsed.data.amount)
    } catch {
      throw new HttpError(422, 'INVALID_AMOUNT', `not a valid USDT amount: ${parsed.data.amount}`)
    }

    const result = await requestWithdrawal(getDb(), {
      userId: user.id,
      address: parsed.data.address,
      amountMicros,
      totpCode: parsed.data.totpCode,
    })

    return ok(result, { status: 201 })
  })
}
```

`src/app/api/me/withdrawals/[id]/cancel/route.ts`:

```ts
import { getDb } from '@/lib/db/client'
import { cancelWithdrawal } from '@/lib/withdrawals/request'
import { handle, ok } from '@/lib/http/respond'
import { requireUser } from '@/lib/http/auth'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const user = await requireUser()
    const { id } = await params
    await cancelWithdrawal(getDb(), { userId: user.id, requestId: id })
    return ok({ ok: true })
  })
}
```

- [ ] **Step 4: Write the enrolment component**

`src/components/TotpEnrolment.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'

export function TotpEnrolment() {
  const router = useRouter()
  const [enrolment, setEnrolment] = useState<{ uri: string; secret: string } | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function begin() {
    setBusy(true)
    setError(null)
    try {
      setEnrolment(await apiPost<{ uri: string; secret: string }>('/api/me/totp'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost('/api/me/totp/confirm', { code })
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  if (!enrolment) {
    return (
      <fieldset>
        <legend>Two-factor authentication required</legend>
        <p>Withdrawals are protected by an authenticator app. Set one up to continue.</p>
        {error && <p className="error">{error}</p>}
        <button onClick={begin} disabled={busy}>
          {busy ? 'Starting…' : 'Set up two-factor authentication'}
        </button>
      </fieldset>
    )
  }

  return (
    <form onSubmit={confirm}>
      <fieldset>
        <legend>Finish setting up two-factor authentication</legend>
        <p>Add this to your authenticator app, then enter the six-digit code it shows.</p>
        <p>
          Setup key: <code>{enrolment.secret}</code>
        </p>
        <p className="estimate">
          Store this key somewhere safe. Losing it means losing the ability to withdraw.
        </p>
        <label>
          Code
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Confirm'}
        </button>
      </fieldset>
    </form>
  )
}
```

- [ ] **Step 5: Write the withdrawal form**

`src/components/WithdrawForm.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'
import { formatUsdt } from '@/lib/money/units'

export function WithdrawForm({
  availableMicros,
  minimumMicros,
}: {
  availableMicros: string
  minimumMicros: string
}) {
  const router = useRouter()
  const [address, setAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await apiPost('/api/me/withdrawals', { address, amount, totpCode })
      setMessage('Withdrawal requested. It will be reviewed before it is sent.')
      setAmount('')
      setTotpCode('')
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
        <legend>Withdraw USDT</legend>
        <p className="estimate">
          Available: {formatUsdt(BigInt(availableMicros))} USDT · minimum{' '}
          {formatUsdt(BigInt(minimumMicros))} USDT
        </p>
        <label>
          Destination Tron address
          <input value={address} onChange={(e) => setAddress(e.target.value)} required />
        </label>
        <p className="estimate">
          USDT-TRC20 only. Check the address carefully — a sent withdrawal cannot be reversed.
        </p>
        <label>
          Amount (USDT)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
        </label>
        <label>
          Authenticator code
          <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" required />
        </label>
        {error && <p className="error">{error}</p>}
        {message && <p>{message}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Requesting…' : 'Request withdrawal'}
        </button>
      </fieldset>
    </form>
  )
}
```

- [ ] **Step 6: Write the page**

`src/app/withdraw/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { users } from '@/lib/db/schema'
import { currentUser } from '@/lib/http/auth'
import { userBalance } from '@/lib/ledger/accounts'
import { listUserWithdrawals, MIN_WITHDRAWAL_MICROS } from '@/lib/withdrawals/request'
import { TotpEnrolment } from '@/components/TotpEnrolment'
import { WithdrawForm } from '@/components/WithdrawForm'
import { Money } from '@/components/Money'

export const dynamic = 'force-dynamic'

export default async function WithdrawPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const db = getDb()
  const [row] = await db
    .select({ enabled: users.totpEnabled, locked: users.withdrawalLocked })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  const [balance, withdrawals] = await Promise.all([
    userBalance(db, user.id),
    listUserWithdrawals(db, user.id),
  ])

  return (
    <>
      <h1>Withdraw</h1>

      {row.locked ? (
        <p className="error">
          Withdrawals are currently locked on this account. Contact support.
        </p>
      ) : row.enabled ? (
        <WithdrawForm
          availableMicros={balance.toString()}
          minimumMicros={MIN_WITHDRAWAL_MICROS.toString()}
        />
      ) : (
        <TotpEnrolment />
      )}

      <h2>History</h2>
      {withdrawals.length === 0 ? (
        <p>No withdrawals yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Requested</th>
              <th>Amount</th>
              <th>Destination</th>
              <th>Status</th>
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {withdrawals.map((w) => (
              <tr key={w.id}>
                <td>{w.requestedAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
                <td>
                  <Money micros={w.amount} />
                </td>
                <td>
                  <code>{w.address}</code>
                </td>
                <td>
                  {w.status}
                  {w.failureReason ? ` — ${w.failureReason}` : ''}
                </td>
                <td>{w.txHash ? <code>{w.txHash.slice(0, 16)}…</code> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
```

- [ ] **Step 7: Add the nav link**

In `src/components/Nav.tsx`, in the signed-in branch after the Deposit link:

```tsx
          <Link href="/withdraw">Withdraw</Link>
          {' · '}
```

- [ ] **Step 8: Verify**

```bash
pnpm typecheck
pnpm build
pnpm test
```

Expected: build lists `/withdraw`, `/api/me/totp`, `/api/me/withdrawals`; all tests pass.

- [ ] **Step 9: Commit and push**

```bash
git add src/app/api/me src/app/withdraw src/components src/lib/http/respond.ts
git commit -m "feat: TOTP enrolment and withdrawal request UI"
git push origin main
```

---

## Task 6: Admin withdrawal queue

**Files:**
- Create: `src/app/api/admin/withdrawals/route.ts`, `src/app/api/admin/withdrawals/[id]/approve/route.ts`, `src/app/api/admin/withdrawals/[id]/reject/route.ts`
- Create: `src/app/admin/withdrawals/page.tsx`, `src/components/WithdrawalReviewControls.tsx`
- Modify: `src/app/admin/page.tsx`

**Interfaces:**
- Consumes: `listPendingWithdrawals`, `approveWithdrawal`, `rejectWithdrawal`, `requireAdmin`
- Produces:

| Method & path | Body | Success |
|---|---|---|
| `GET /api/admin/withdrawals` | — | `200 { pending }` |
| `POST /api/admin/withdrawals/:id/approve` | `{ note? }` | `200 { jobId }` |
| `POST /api/admin/withdrawals/:id/reject` | `{ note }` | `200 { ok: true }` |

- [ ] **Step 1: Write the routes**

`src/app/api/admin/withdrawals/route.ts`:

```ts
import { getDb } from '@/lib/db/client'
import { listPendingWithdrawals } from '@/lib/withdrawals/review'
import { handle, ok } from '@/lib/http/respond'
import { requireAdmin } from '@/lib/http/auth'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return handle(async () => {
    await requireAdmin()
    return ok({ pending: await listPendingWithdrawals(getDb()) })
  })
}
```

`src/app/api/admin/withdrawals/[id]/approve/route.ts`:

```ts
import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { approveWithdrawal } from '@/lib/withdrawals/review'
import { handle, ok } from '@/lib/http/respond'
import { requireAdmin } from '@/lib/http/auth'

const Body = z.object({ note: z.string().max(500).optional() })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const admin = await requireAdmin()
    const { id } = await params
    const parsed = Body.safeParse(await request.json().catch(() => ({})))

    const result = await approveWithdrawal(getDb(), {
      requestId: id,
      adminId: admin.id,
      note: parsed.success ? parsed.data.note : undefined,
    })
    return ok(result)
  })
}
```

`src/app/api/admin/withdrawals/[id]/reject/route.ts`:

```ts
import * as z from 'zod'
import { getDb } from '@/lib/db/client'
import { rejectWithdrawal } from '@/lib/withdrawals/review'
import { handle, ok } from '@/lib/http/respond'
import { HttpError, requireAdmin } from '@/lib/http/auth'

const Body = z.object({ note: z.string().min(1).max(500) })

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(async () => {
    const admin = await requireAdmin()
    const { id } = await params

    const parsed = Body.safeParse(await request.json())
    if (!parsed.success) throw new HttpError(422, 'INVALID_BODY', 'a rejection note is required')

    await rejectWithdrawal(getDb(), { requestId: id, adminId: admin.id, note: parsed.data.note })
    return ok({ ok: true })
  })
}
```

A rejection note is mandatory. The user sees their money come back with no explanation
otherwise, and support has nothing to work from.

- [ ] **Step 2: Write the review controls**

`src/components/WithdrawalReviewControls.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'

export function WithdrawalReviewControls({
  requestId,
  address,
  amountLabel,
}: {
  requestId: string
  address: string
  amountLabel: string
}) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const armed = confirm === 'SEND'

  async function call(path: string, body?: unknown) {
    setBusy(true)
    setError(null)
    try {
      await apiPost(path, body)
      setConfirm('')
      setNote('')
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset>
      <legend>
        Review — {amountLabel} to <code>{address}</code>
      </legend>
      <label>
        Note
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label>
        Type SEND to enable approval
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <button
        disabled={busy || !armed}
        onClick={() => call(`/api/admin/withdrawals/${requestId}/approve`, { note: note || undefined })}
      >
        Approve and send
      </button>{' '}
      <button
        disabled={busy || note.trim().length === 0}
        onClick={() => call(`/api/admin/withdrawals/${requestId}/reject`, { note })}
      >
        Reject and refund
      </button>
      {error && <p className="error">{error}</p>}
    </fieldset>
  )
}
```

- [ ] **Step 3: Write the admin page**

`src/app/admin/withdrawals/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/client'
import { currentUser } from '@/lib/http/auth'
import { listPendingWithdrawals } from '@/lib/withdrawals/review'
import { WithdrawalReviewControls } from '@/components/WithdrawalReviewControls'
import { formatUsdt } from '@/lib/money/units'

export const dynamic = 'force-dynamic'

export default async function AdminWithdrawalsPage() {
  const user = await currentUser()
  if (!user?.isAdmin) notFound()

  const pending = await listPendingWithdrawals(getDb())

  return (
    <>
      <h1>Withdrawal queue</h1>
      {pending.length === 0 ? (
        <p>Nothing awaiting review.</p>
      ) : (
        pending.map((w) => (
          <div key={w.id}>
            <p>
              {w.email} · requested {w.requestedAt.toISOString().replace('T', ' ').slice(0, 16)}
            </p>
            <WithdrawalReviewControls
              requestId={w.id}
              address={w.address}
              amountLabel={`${formatUsdt(w.amount)} USDT`}
            />
          </div>
        ))
      )}
    </>
  )
}
```

- [ ] **Step 4: Link it from the admin page**

In `src/app/admin/page.tsx`, immediately after the `<h1>Admin</h1>`:

```tsx
      <p>
        <Link href="/admin/withdrawals">Withdrawal queue</Link>
      </p>
```

- [ ] **Step 5: Verify**

```bash
pnpm typecheck
pnpm build
pnpm test
```

Expected: build lists `/admin/withdrawals` and the three admin withdrawal routes; all tests pass.

- [ ] **Step 6: Commit and push**

```bash
git add src/app/api/admin/withdrawals src/app/admin src/components
git commit -m "feat: admin withdrawal approval queue"
git push origin main
```

---

## Task 7: Live Nile withdrawal walkthrough

**Files:**
- Create: `docs/superpowers/plans/slice-3-walkthrough.md`

Reuse the Nile wallet and configuration from Slice 2's walkthrough. The hot wallet needs both
USDT (to send) and TRX (for energy).

- [ ] **Step 1: Set the encryption key**

```bash
openssl rand -hex 32
```

Put it in `.env` as `TOTP_ENCRYPTION_KEY`. Confirm `.env` is still ignored:

```bash
git check-ignore -v .env
```

- [ ] **Step 2: Enrol in TOTP through the UI**

Sign in, visit `/withdraw`, start enrolment, add the setup key to an authenticator app, and
confirm. Record that the page then shows the withdrawal form.

- [ ] **Step 3: Verify the guards before withdrawing anything**

Record the observed response for each:

1. Amount below the 10 USDT minimum → `BELOW_MINIMUM`
2. A malformed destination address → `INVALID_ADDRESS`
3. A wrong authenticator code → `INVALID_CODE`
4. An amount above the balance → `INSUFFICIENT_FUNDS`

- [ ] **Step 4: Request a withdrawal and confirm the ring-fence**

Request a real withdrawal to a second Nile address you control. Immediately check that the
available balance dropped and that the money is in pending:

```bash
docker compose exec -T db psql -U botsbattle -d botsbattle -c "
  SELECT a.kind, SUM(le.amount) AS balance
  FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
  WHERE a.kind IN ('user_available','user_pending_withdrawal')
  GROUP BY a.kind ORDER BY a.kind::text;"
```

Then confirm the ring-fence actually binds: with the withdrawal still pending, try to place a
bet larger than the remaining available balance. It must be refused with `INSUFFICIENT_FUNDS`.
This is the property the whole design exists for — record the observed error.

- [ ] **Step 5: Approve it and watch the signer send**

Approve from `/admin/withdrawals`, then run the signer in a shell with `TRON_MNEMONIC` set.
Record the broadcast hash and verify on <https://nile.tronscan.org> that the USDT arrived at
the destination.

- [ ] **Step 6: Watch the worker confirm it**

Run the worker and record the cycle at which the withdrawal moves to `CONFIRMED`. Then verify
the ledger closed out correctly:

```bash
docker compose exec -T db psql -U botsbattle -d botsbattle -c "
  SELECT COALESCE(SUM(amount),0) AS grand_total FROM ledger_entries;
  SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0;
  SELECT kind, idempotency_key FROM ledger_transactions ORDER BY created_at;"
```

Expected: `grand_total` is `0`, no lopsided transactions, and the transaction log shows
`WITHDRAWAL_REQUESTED` followed by `WITHDRAWAL_CONFIRMED` for this request.

- [ ] **Step 7: Exercise the reject path**

Request a second withdrawal, reject it with a note, and confirm the funds returned to
available and the status reads `REJECTED` with the note visible to the user.

- [ ] **Step 8: Reconcile**

```bash
pnpm reconcile
```

Expected: `balanced`. The withdrawn amount should have reduced both the on-chain total and the
ledger custody figure by the same amount.

- [ ] **Step 9: Write up the walkthrough**

`docs/superpowers/plans/slice-3-walkthrough.md`, recording observed values as in the Slice 1
and 2 walkthroughs: the guard responses, the ring-fence check, the broadcast hash, the
confirmation cycle, the reject path, and the reconciliation output. **No mnemonic, no TOTP
secret, and no encryption key in the document.**

- [ ] **Step 10: Commit and push**

```bash
git add docs/superpowers/plans/slice-3-walkthrough.md
git commit -m "docs: Slice 3 live Nile withdrawal walkthrough"
git push origin main
```

---

## Done when

- `pnpm test` is green, including the concurrent-withdrawal test and every idempotency test
- `pnpm typecheck` and `pnpm build` are clean
- A real Nile withdrawal was requested, approved, broadcast, and confirmed, with the ledger
  balanced at zero throughout
- A pending withdrawal demonstrably blocked a bet that would have spent the same funds
- A rejected withdrawal returned the money with a note the user can see
- `pnpm reconcile` reports `balanced` after the withdrawal settled
- No secret material is in the repository

## Deliberately not in this slice

`balance_cache` and its reconciliation job, KYC verification, geo-restriction, automated
withdrawal approval, and deployment. Slice 4 covers deployment; the rest remain non-goals.
