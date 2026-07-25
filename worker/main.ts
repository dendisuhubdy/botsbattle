import 'dotenv/config'
import { createDb } from '../src/lib/db/client'
import { loadTronConfig } from '../src/lib/tron/config'
import { createTronGridClient } from '../src/lib/tron/trongrid'
import { pollDeposits } from '../src/lib/deposits/poller'
import { enqueueSweeps } from '../src/lib/signer/sweep'
import { pollWithdrawals } from '../src/lib/withdrawals/poller'
import { runLoop } from '../src/lib/process/loop'

const POLL_INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? '15000')

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

// The worker is watch-only. If a seed leaks into its environment, refuse to start rather
// than quietly run a process that could spend.
if (process.env.TRON_MNEMONIC) {
  throw new Error('TRON_MNEMONIC must not be set in the worker environment')
}

const config = loadTronConfig()
const { db, pool } = createDb(url)
const tron = createTronGridClient(config)
const controller = new AbortController()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[worker] ${signal} received, shutting down`)
    controller.abort()
  })
}

console.log(`[worker] polling ${config.network} every ${POLL_INTERVAL_MS}ms`)

await runLoop({
  intervalMs: POLL_INTERVAL_MS,
  signal: controller.signal,
  onError: (err) => console.error('[worker] tick failed:', err),
  onTick: async () => {
    const result = await pollDeposits(db, tron, { confirmations: config.confirmations })
    if (result.newTransfers || result.credited.length) {
      console.log(
        `[worker] head=${result.headBlock} new=${result.newTransfers} credited=${result.credited.length}`,
      )
    }
    const queued = await enqueueSweeps(db, tron, { minMicros: config.sweepMinMicros })
    if (queued) console.log(`[worker] queued ${queued} sweep job(s)`)

    const withdrawals = await pollWithdrawals(db, tron, { confirmations: config.confirmations })
    if (withdrawals.confirmed.length) {
      console.log(`[worker] confirmed ${withdrawals.confirmed.length} withdrawal(s)`)
    }
  },
})

await pool.end()
console.log('[worker] stopped')
