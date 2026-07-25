import { asc, eq, sql } from 'drizzle-orm'
import type { Db, Executor } from '@/lib/db/client'
import { signerJobs } from '@/lib/db/schema'

export const MAX_ATTEMPTS = 5

export type SignerJob = {
  id: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
}

/**
 * Takes an `Executor` rather than a `Db` so callers can enlist it in a surrounding
 * transaction — Slice 3's withdrawal approval needs the job and the status change to
 * commit together or not at all.
 */
export async function enqueueJob(
  x: Executor,
  args: { kind: string; idempotencyKey: string; payload: Record<string, unknown> },
): Promise<{ jobId: string; created: boolean }> {
  const inserted = await x
    .insert(signerJobs)
    .values({ kind: args.kind, idempotencyKey: args.idempotencyKey, payload: args.payload })
    .onConflictDoNothing({ target: signerJobs.idempotencyKey })
    .returning({ id: signerJobs.id })

  if (inserted.length) return { jobId: inserted[0].id, created: true }

  const existing = await x
    .select({ id: signerJobs.id })
    .from(signerJobs)
    .where(eq(signerJobs.idempotencyKey, args.idempotencyKey))
    .limit(1)
  return { jobId: existing[0].id, created: false }
}

/**
 * Claim the oldest pending job. `FOR UPDATE SKIP LOCKED` means several signer instances
 * could run without ever handing one job to two of them.
 */
export async function claimNextJob(db: Db): Promise<SignerJob | null> {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: signerJobs.id })
      .from(signerJobs)
      .where(eq(signerJobs.status, 'PENDING'))
      .orderBy(asc(signerJobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true })

    if (!candidates.length) return null

    const [claimed] = await tx
      .update(signerJobs)
      .set({
        status: 'CLAIMED',
        attempts: sql`${signerJobs.attempts} + 1`,
        claimedAt: sql`now()`,
      })
      .where(eq(signerJobs.id, candidates[0].id))
      .returning({
        id: signerJobs.id,
        kind: signerJobs.kind,
        payload: signerJobs.payload,
        attempts: signerJobs.attempts,
      })

    return {
      id: claimed.id,
      kind: claimed.kind,
      payload: claimed.payload as Record<string, unknown>,
      attempts: claimed.attempts,
    }
  })
}

export async function completeJob(db: Db, jobId: string, txHash: string): Promise<void> {
  await db
    .update(signerJobs)
    .set({ status: 'DONE', txHash, completedAt: sql`now()`, lastError: null })
    .where(eq(signerJobs.id, jobId))
}

/**
 * A retryable failure goes back to PENDING until MAX_ATTEMPTS is exhausted, after which it
 * is parked as FAILED for a human. Broadcasting blindly forever would burn gas on a
 * transaction that cannot succeed.
 */
export async function failJob(
  db: Db,
  jobId: string,
  error: string,
  opts: { retry?: boolean } = {},
): Promise<void> {
  const rows = await db
    .select({ attempts: signerJobs.attempts })
    .from(signerJobs)
    .where(eq(signerJobs.id, jobId))
    .limit(1)
  if (!rows.length) return

  const exhausted = rows[0].attempts >= MAX_ATTEMPTS
  const status = opts.retry && !exhausted ? 'PENDING' : 'FAILED'

  await db
    .update(signerJobs)
    .set({
      status,
      lastError: error,
      completedAt: status === 'FAILED' ? sql`now()` : null,
    })
    .where(eq(signerJobs.id, jobId))
}
