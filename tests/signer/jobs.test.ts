import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { testDb, truncateAll } from '../helpers/db'
import type { Db } from '@/lib/db/client'
import { signerJobs } from '@/lib/db/schema'
import { enqueueJob, claimNextJob, completeJob, failJob, MAX_ATTEMPTS } from '@/lib/signer/jobs'

describe('signer job queue', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const job = (key: string) => ({ kind: 'SWEEP', idempotencyKey: key, payload: { address: 'T1' } })

  it('enqueues a pending job', async () => {
    const result = await enqueueJob(db, job('k1'))
    expect(result.created).toBe(true)

    const [row] = await db.select().from(signerJobs)
    expect(row.status).toBe('PENDING')
    expect(row.attempts).toBe(0)
  })

  it('is idempotent on the key', async () => {
    const first = await enqueueJob(db, job('dup'))
    const second = await enqueueJob(db, job('dup'))

    expect(second.created).toBe(false)
    expect(second.jobId).toBe(first.jobId)
    expect(await db.select().from(signerJobs)).toHaveLength(1)
  })

  it('enlists in a caller transaction and rolls back with it', async () => {
    await expect(
      db.transaction(async (tx) => {
        await enqueueJob(tx, job('rollback'))
        throw new Error('caller aborts')
      }),
    ).rejects.toThrow('caller aborts')

    expect(await db.select().from(signerJobs)).toHaveLength(0)
  })

  it('claims a job and marks it CLAIMED', async () => {
    await enqueueJob(db, job('k1'))
    const claimed = await claimNextJob(db)

    expect(claimed).not.toBeNull()
    expect(claimed!.attempts).toBe(1)

    const [row] = await db.select().from(signerJobs)
    expect(row.status).toBe('CLAIMED')
    expect(row.claimedAt).not.toBeNull()
  })

  it('returns null when there is nothing to claim', async () => {
    expect(await claimNextJob(db)).toBeNull()
  })

  it('never hands one job to two concurrent claimants', async () => {
    await enqueueJob(db, job('only-one'))
    const claims = await Promise.all([claimNextJob(db), claimNextJob(db), claimNextJob(db)])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('completes a job with its transaction hash', async () => {
    const { jobId } = await enqueueJob(db, job('k1'))
    await claimNextJob(db)
    await completeJob(db, jobId, 'abc123')

    const [row] = await db.select().from(signerJobs).where(eq(signerJobs.id, jobId))
    expect(row.status).toBe('DONE')
    expect(row.txHash).toBe('abc123')
    expect(row.completedAt).not.toBeNull()
  })

  it('returns a retryable failure to PENDING', async () => {
    const { jobId } = await enqueueJob(db, job('k1'))
    await claimNextJob(db)
    const result = await failJob(db, jobId, 'temporary rpc error', { retry: true })

    expect(result).toEqual({ parked: false })
    const [row] = await db.select().from(signerJobs).where(eq(signerJobs.id, jobId))
    expect(row.status).toBe('PENDING')
    expect(row.lastError).toBe('temporary rpc error')
    expect(await claimNextJob(db)).not.toBeNull()
  })

  it('marks a non-retryable failure FAILED', async () => {
    const { jobId } = await enqueueJob(db, job('k1'))
    await claimNextJob(db)
    const result = await failJob(db, jobId, 'bad address', { retry: false })

    expect(result).toEqual({ parked: true })
    const [row] = await db.select().from(signerJobs).where(eq(signerJobs.id, jobId))
    expect(row.status).toBe('FAILED')
    expect(await claimNextJob(db)).toBeNull()
  })

  it('stops retrying after MAX_ATTEMPTS, reporting parked only on the last attempt', async () => {
    const { jobId } = await enqueueJob(db, job('k1'))
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const claimed = await claimNextJob(db)
      expect(claimed).not.toBeNull()
      const result = await failJob(db, jobId, `attempt ${i}`, { retry: true })
      expect(result).toEqual({ parked: i === MAX_ATTEMPTS - 1 })
    }

    const [row] = await db.select().from(signerJobs).where(eq(signerJobs.id, jobId))
    expect(row.status).toBe('FAILED')
    expect(await claimNextJob(db)).toBeNull()
  })

  it('reports not parked when the job no longer exists', async () => {
    expect(await failJob(db, '00000000-0000-0000-0000-000000000000', 'gone')).toEqual({
      parked: false,
    })
  })
})
