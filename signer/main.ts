import 'dotenv/config'
import { createDb } from '../src/lib/db/client'
import { loadTronConfig } from '../src/lib/tron/config'
import { createTronGridClient } from '../src/lib/tron/trongrid'
import { loadSignerSeed, assertMatchesXpub } from '../src/lib/signer/keys'
import { runOnce } from '../src/lib/signer/run'
import { runLoop } from '../src/lib/process/loop'

const INTERVAL_MS = Number(process.env.SIGNER_INTERVAL_MS ?? '5000')

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

const config = loadTronConfig()
const seed = loadSignerSeed()

// Fail fast if the seed and the xpub the web app publishes are different wallets.
assertMatchesXpub(seed, config.xpub)
console.log('[signer] seed matches TRON_XPUB')

const { db, pool } = createDb(url)
const tron = createTronGridClient(config)
const controller = new AbortController()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[signer] ${signal} received, shutting down`)
    controller.abort()
  })
}

console.log(`[signer] watching for jobs on ${config.network} every ${INTERVAL_MS}ms`)

await runLoop({
  intervalMs: INTERVAL_MS,
  signal: controller.signal,
  onError: (err) => console.error('[signer] tick failed:', err),
  onTick: async () => {
    // Drain the queue rather than sleeping between jobs when work is waiting.
    let outcome = await runOnce({ db, tron, seed, hotWalletAddress: config.hotWalletAddress })
    while (outcome !== 'idle') {
      console.log(`[signer] job ${outcome}`)
      outcome = await runOnce({ db, tron, seed, hotWalletAddress: config.hotWalletAddress })
    }
  },
})

await pool.end()
console.log('[signer] stopped')
