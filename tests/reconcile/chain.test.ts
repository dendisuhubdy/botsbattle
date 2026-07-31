import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser, makeAdmin } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { ACCOUNT_PATH } from '@/lib/tron/address'
import { assignDepositAddress } from '@/lib/deposits/addresses'
import { recordSeenTransfer, creditConfirmedDeposits } from '@/lib/deposits/credit'
import { creditUser } from '@/lib/admin/credit'
import { reconcileChain } from '@/lib/reconcile/chain'
import { derivePrivateKeyHex } from '@/lib/signer/keys'
import { FakeTron } from '@/lib/tron/fake'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SEED = mnemonicToSeedSync(MNEMONIC)
const XPUB = HDKey.fromMasterSeed(SEED).derive(ACCOUNT_PATH).publicExtendedKey
const USDT = 1_000_000n
// Index 99 of the same test wallet, so the hot wallet is provably ours and reproducible.
const HOT = 'TTTFe9haCY6CACG9iTM8uyL89pFEPy4ctW'

describe('reconcileChain', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('balances on an empty system', async () => {
    const result = await reconcileChain(db, new FakeTron(), HOT)
    expect(result).toMatchObject({
      onChainMicros: 0n,
      ledgerCustodyMicros: 0n,
      differenceMicros: 0n,
      balanced: true,
    })
  })

  it('balances after a real deposit is credited', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    const tron = new FakeTron()
    const transfer = tron.deposit({ to: address, amountMicros: 60n * USDT, blockNumber: 100 })
    await recordSeenTransfer(db, transfer)
    await creditConfirmedDeposits(db, 200, 19)

    const result = await reconcileChain(db, tron, HOT)
    expect(result.onChainMicros).toBe(60n * USDT)
    expect(result.ledgerCustodyMicros).toBe(60n * USDT)
    expect(result.balanced).toBe(true)
  })

  it('still balances once funds are swept to the hot wallet', async () => {
    const user = await makeUser(db)
    const { address, derivationIndex } = await assignDepositAddress(db, {
      userId: user,
      xpub: XPUB,
    })

    const tron = new FakeTron()
    const transfer = tron.deposit({ to: address, amountMicros: 60n * USDT, blockNumber: 100 })
    await recordSeenTransfer(db, transfer)
    await creditConfirmedDeposits(db, 200, 19)

    // Perform the sweep for real, with the key the signer would use for this address.
    // Read the index back rather than assuming it: index 0 is reserved for the hot wallet,
    // so assignment starts at 1.
    await tron.sendTrc20({
      fromPrivateKeyHex: derivePrivateKeyHex(SEED, derivationIndex),
      to: HOT,
      amountMicros: 60n * USDT,
    })

    expect(await tron.trc20Balance(address)).toBe(0n)
    expect(await tron.trc20Balance(HOT)).toBe(60n * USDT)

    // A sweep moves money between two accounts we control, so custody is unchanged.
    const result = await reconcileChain(db, tron, HOT)
    expect(result.onChainMicros).toBe(60n * USDT)
    expect(result.ledgerCustodyMicros).toBe(60n * USDT)
    expect(result.balanced).toBe(true)
  })

  it('reports admin credits separately so they do not read as corruption', async () => {
    const admin = await makeAdmin(db)
    const user = await makeUser(db)
    await creditUser(db, { userId: user, amount: 100n * USDT, reference: 'seed', creditedBy: admin })

    const result = await reconcileChain(db, new FakeTron(), HOT)
    expect(result.adminCreditedMicros).toBe(100n * USDT)
    expect(result.ledgerCustodyMicros).toBe(100n * USDT)
    // Chain holds nothing, but 100 of the custody figure is fabricated, so this balances.
    expect(result.differenceMicros).toBe(0n)
    expect(result.balanced).toBe(true)
  })

  it('flags a genuine shortfall', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    const tron = new FakeTron()
    const transfer = tron.deposit({ to: address, amountMicros: 60n * USDT, blockNumber: 100 })
    await recordSeenTransfer(db, transfer)
    await creditConfirmedDeposits(db, 200, 19)

    // The money leaves the chain without any corresponding ledger movement.
    const drained = new FakeTron()
    const result = await reconcileChain(db, drained, HOT)

    expect(result.onChainMicros).toBe(0n)
    expect(result.ledgerCustodyMicros).toBe(60n * USDT)
    expect(result.differenceMicros).toBe(-60n * USDT)
    expect(result.balanced).toBe(false)
  })

  it('lists the per-address on-chain balances it summed', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })
    const tron = new FakeTron()
    tron.deposit({ to: address, amountMicros: 3n * USDT, blockNumber: 1 })

    const result = await reconcileChain(db, tron, HOT)
    expect(result.perAddress).toContainEqual({ address, onChain: 3n * USDT })
  })
})
