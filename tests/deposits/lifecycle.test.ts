import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { assignDepositAddress } from '@/lib/deposits/addresses'
import { pollDeposits } from '@/lib/deposits/poller'
import { deriveXpub } from '@/lib/signer/keys'
import { enqueueSweeps } from '@/lib/signer/sweep'
import { runOnce } from '@/lib/signer/run'
import { reconcileChain } from '@/lib/reconcile/chain'
import { createFight, publishFight, lockFight } from '@/lib/fights/repo'
import { placeBet } from '@/lib/bets/place'
import { settleFight } from '@/lib/settlement/settle'
import { userBalance } from '@/lib/ledger/accounts'
import { FakeTron } from '@/lib/tron/fake'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEED = mnemonicToSeedSync(MNEMONIC)
const XPUB = deriveXpub(SEED)
const USDT = 1_000_000n
const HOT = 'TTTFe9haCY6CACG9iTM8uyL89pFEPy4ctW'
const HOUR = 60 * 60 * 1000

/**
 * Deposit -> credit -> sweep -> bet -> settle, on the fake chain, asserting the ledger
 * stays balanced and reconciliation holds at every stage. This is the Slice 1 + Slice 2
 * seam: money entering from the chain must be spendable by the betting engine.
 */
describe('deposit-to-settlement lifecycle', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  async function assertLedgerBalanced() {
    const unbalanced = await db.execute<{ tx_id: string }>(
      sql`SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0`,
    )
    expect(unbalanced.rows).toEqual([])

    const total = await db.execute<{ total: string }>(
      sql`SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries`,
    )
    expect(BigInt(total.rows[0].total)).toBe(0n)
  }

  it('carries chain money through betting and settlement with the books balanced', async () => {
    const admin = await makeAdmin(db)
    const alice = await makeUser(db)
    const bob = await makeUser(db)

    const aliceAddr = (await assignDepositAddress(db, { userId: alice, xpub: XPUB })).address
    const bobAddr = (await assignDepositAddress(db, { userId: bob, xpub: XPUB })).address

    const tron = new FakeTron()
    tron.deposit({ to: aliceAddr, amountMicros: 100n * USDT, blockNumber: 1000 })
    tron.deposit({ to: bobAddr, amountMicros: 100n * USDT, blockNumber: 1000 })
    tron.setHead(1100)

    // 1. Deposits credit after confirmations.
    const polled = await pollDeposits(db, tron, { confirmations: 19 })
    expect(polled.credited).toHaveLength(2)
    expect(await userBalance(db, alice)).toBe(100n * USDT)
    expect(await userBalance(db, bob)).toBe(100n * USDT)
    await assertLedgerBalanced()
    expect((await reconcileChain(db, tron, HOT)).balanced).toBe(true)

    // 2. Sweeps consolidate into the hot wallet without changing custody.
    expect(await enqueueSweeps(db, tron, { minMicros: 20n * USDT })).toBe(2)
    expect(await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT, hotWalletIndex: 99 })).toBe('done')
    expect(await runOnce({ db, tron, seed: SEED, hotWalletAddress: HOT, hotWalletIndex: 99 })).toBe('done')

    expect(await tron.trc20Balance(HOT)).toBe(200n * USDT)
    expect(await tron.trc20Balance(aliceAddr)).toBe(0n)
    const afterSweep = await reconcileChain(db, tron, HOT)
    expect(afterSweep.onChainMicros).toBe(200n * USDT)
    expect(afterSweep.balanced).toBe(true)

    // 3. Deposited money is spendable by the betting engine.
    const fight = await createFight(db, {
      leagueName: 'Robot League',
      fighterA: 'Crusher',
      fighterB: 'Bolt',
      lockAt: new Date(Date.now() + HOUR),
      createdBy: admin,
    })
    await publishFight(db, fight.id)

    await placeBet(db, {
      userId: alice,
      fightId: fight.id,
      side: 'A',
      stake: 25n * USDT,
      idempotencyKey: 'a1',
    })
    await placeBet(db, {
      userId: bob,
      fightId: fight.id,
      side: 'B',
      stake: 75n * USDT,
      idempotencyKey: 'b1',
    })

    await db.execute(
      sql`UPDATE fights SET lock_at = now() - interval '1 second' WHERE id = ${fight.id}`,
    )
    await lockFight(db, fight.id)
    await settleFight(db, { fightId: fight.id, outcome: 'A', settledBy: admin })

    expect(await userBalance(db, alice)).toBe(170n * USDT)
    expect(await userBalance(db, bob)).toBe(25n * USDT)
    await assertLedgerBalanced()

    // 4. Betting never touched the chain, so reconciliation is unchanged.
    const final = await reconcileChain(db, tron, HOT)
    expect(final.onChainMicros).toBe(200n * USDT)
    expect(final.ledgerCustodyMicros).toBe(200n * USDT)
    expect(final.balanced).toBe(true)
  })
})
