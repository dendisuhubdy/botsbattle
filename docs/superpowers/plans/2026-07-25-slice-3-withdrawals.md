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

<!-- PLAN-CONTINUES -->
