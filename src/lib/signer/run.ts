import type { Db } from '@/lib/db/client'
import { TronError, type TronClient } from '@/lib/tron/client'
import { failWithdrawal, markBroadcast } from '@/lib/withdrawals/settle'
import { claimNextJob, completeJob, failJob } from './jobs'
import { derivePrivateKeyHex } from './keys'
import type { SweepPayload } from './sweep'

export type SignerDeps = {
  db: Db
  tron: TronClient
  seed: Uint8Array
  hotWalletAddress: string
  hotWalletIndex: number
}

export type RunOutcome = 'idle' | 'done' | 'failed'

type WithdrawPayload = {
  requestId: string
  address: string
  amountMicros: string
}

/**
 * Claim and execute at most one job. Returning after a single job keeps the loop's failure
 * blast radius small and lets the caller decide the pacing.
 */
export async function runOnce(deps: SignerDeps): Promise<RunOutcome> {
  const job = await claimNextJob(deps.db)
  if (!job) return 'idle'

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

    // WITHDRAW: sent from the hot wallet key to the user's requested address.
    const payload = job.payload as unknown as WithdrawPayload
    const txHash = await deps.tron.sendTrc20({
      fromPrivateKeyHex: derivePrivateKeyHex(deps.seed, deps.hotWalletIndex),
      to: payload.address,
      amountMicros: BigInt(payload.amountMicros),
    })

    await markBroadcast(deps.db, { requestId: payload.requestId, txHash })
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
    const { parked } = await failJob(deps.db, job.id, message, { retry })

    // When a withdrawal job is out of retries the user's funds must come back; leaving them
    // ring-fenced against a job nobody will ever run again is money silently frozen. `parked`
    // is `failJob`'s own verdict on exhaustion, so this can't disagree with what actually got
    // written to the job row.
    if (job.kind === 'WITHDRAW' && parked) {
      const payload = job.payload as unknown as WithdrawPayload
      await failWithdrawal(deps.db, { requestId: payload.requestId, reason: message })
    }

    return 'failed'
  }
}
