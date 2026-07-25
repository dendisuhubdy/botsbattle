import type { Db } from '@/lib/db/client'
import { TronError, type TronClient } from '@/lib/tron/client'
import { claimNextJob, completeJob, failJob } from './jobs'
import { derivePrivateKeyHex } from './keys'
import type { SweepPayload } from './sweep'

export type SignerDeps = {
  db: Db
  tron: TronClient
  seed: Uint8Array
  hotWalletAddress: string
}

export type RunOutcome = 'idle' | 'done' | 'failed'

/**
 * Claim and execute at most one job. Returning after a single job keeps the loop's failure
 * blast radius small and lets the caller decide the pacing.
 */
export async function runOnce(deps: SignerDeps): Promise<RunOutcome> {
  const job = await claimNextJob(deps.db)
  if (!job) return 'idle'

  if (job.kind !== 'SWEEP') {
    await failJob(deps.db, job.id, `unknown job kind: ${job.kind}`, { retry: false })
    return 'failed'
  }

  const payload = job.payload as unknown as SweepPayload

  try {
    const privateKeyHex = derivePrivateKeyHex(deps.seed, payload.derivationIndex)

    const txHash = await deps.tron.sendTrc20({
      fromPrivateKeyHex: privateKeyHex,
      to: deps.hotWalletAddress,
      amountMicros: BigInt(payload.amountMicros),
    })

    await completeJob(deps.db, job.id, txHash)
    return 'done'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // A TronError is a chain-side problem: the node was unreachable, the address was out of
    // energy, the broadcast bounced. All of those can succeed later, so retry until
    // MAX_ATTEMPTS parks the job for a human.
    //
    // Anything else came from our own code — a bad derivation index, a malformed payload —
    // and will fail identically every time. Retrying it just burns attempts and delays the
    // alert, so park it immediately.
    const retry = err instanceof TronError
    await failJob(deps.db, job.id, message, { retry })
    return 'failed'
  }
}
