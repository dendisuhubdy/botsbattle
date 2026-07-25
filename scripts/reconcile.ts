import 'dotenv/config'
import { createDb } from '../src/lib/db/client'
import { loadTronConfig } from '../src/lib/tron/config'
import { createTronGridClient } from '../src/lib/tron/trongrid'
import { reconcileChain } from '../src/lib/reconcile/chain'
import { formatUsdt } from '../src/lib/money/units'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const config = loadTronConfig()
const { db, pool } = createDb(url)
const result = await reconcileChain(db, createTronGridClient(config), config.hotWalletAddress)
await pool.end()

console.log(`on chain:        ${formatUsdt(result.onChainMicros)} USDT`)
console.log(`ledger custody:  ${formatUsdt(result.ledgerCustodyMicros)} USDT`)
console.log(`admin credits:   ${formatUsdt(result.adminCreditedMicros)} USDT (not chain-backed)`)
console.log(`difference:      ${formatUsdt(result.differenceMicros)} USDT`)

for (const row of result.perAddress) {
  if (row.onChain > 0n) console.log(`  ${row.address}  ${formatUsdt(row.onChain)}`)
}

if (!result.balanced) {
  console.error('\nRECONCILIATION FAILED — treat as a production incident')
  process.exit(1)
}
console.log('\nbalanced')
