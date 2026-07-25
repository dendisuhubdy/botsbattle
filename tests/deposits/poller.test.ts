import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { testDb, truncateAll } from '../helpers/db'
import { makeUser } from '../helpers/fixtures'
import type { Db } from '@/lib/db/client'
import { ACCOUNT_PATH } from '@/lib/tron/address'
import { assignDepositAddress } from '@/lib/deposits/addresses'
import { pollDeposits } from '@/lib/deposits/poller'
import { FakeTron } from '@/lib/tron/fake'
import { userBalance } from '@/lib/ledger/accounts'
import type { TronClient } from '@/lib/tron/client'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const XPUB = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive(ACCOUNT_PATH)
  .publicExtendedKey
const USDT = 1_000_000n
const CONF = { confirmations: 19 }

describe('pollDeposits', () => {
  let db: Db

  beforeAll(async () => {
    ;({ db } = await testDb())
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  it('does nothing when no addresses are assigned', async () => {
    const tron = new FakeTron()
    const result = await pollDeposits(db, tron, CONF)
    expect(result).toMatchObject({ addressesScanned: 0, newTransfers: 0, credited: [] })
  })

  it('records a transfer but withholds credit until confirmed', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    const tron = new FakeTron()
    tron.setHead(1000)
    tron.deposit({ to: address, amountMicros: 40n * USDT, blockNumber: 1000 })

    const first = await pollDeposits(db, tron, CONF)
    expect(first.newTransfers).toBe(1)
    expect(first.credited).toEqual([])
    expect(await userBalance(db, user)).toBe(0n)

    // head - block + 1 >= 19 requires head 1018 for a block-1000 transfer.
    tron.setHead(1018)
    const second = await pollDeposits(db, tron, CONF)
    expect(second.credited).toHaveLength(1)
    expect(await userBalance(db, user)).toBe(40n * USDT)
  })

  it('is safe to run repeatedly — no double credit, no duplicate rows', async () => {
    const user = await makeUser(db)
    const { address } = await assignDepositAddress(db, { userId: user, xpub: XPUB })

    const tron = new FakeTron()
    tron.deposit({ to: address, amountMicros: 12n * USDT, blockNumber: 1000 })
    tron.setHead(2000)

    await pollDeposits(db, tron, CONF)
    await pollDeposits(db, tron, CONF)
    const third = await pollDeposits(db, tron, CONF)

    expect(third.newTransfers).toBe(0)
    expect(third.credited).toEqual([])
    expect(await userBalance(db, user)).toBe(12n * USDT)
  })

  it('scans every assigned address', async () => {
    const users = [await makeUser(db), await makeUser(db)]
    const addresses: string[] = []
    for (const u of users) {
      addresses.push((await assignDepositAddress(db, { userId: u, xpub: XPUB })).address)
    }

    const tron = new FakeTron()
    tron.deposit({ to: addresses[0], amountMicros: 5n * USDT, blockNumber: 1000 })
    tron.deposit({ to: addresses[1], amountMicros: 6n * USDT, blockNumber: 1000 })
    tron.setHead(2000)

    const result = await pollDeposits(db, tron, CONF)
    expect(result.addressesScanned).toBe(2)
    expect(result.credited).toHaveLength(2)
    expect(await userBalance(db, users[0])).toBe(5n * USDT)
    expect(await userBalance(db, users[1])).toBe(6n * USDT)
  })

  it('keeps going when one address fails to read', async () => {
    const users = [await makeUser(db), await makeUser(db)]
    const addresses: string[] = []
    for (const u of users) {
      addresses.push((await assignDepositAddress(db, { userId: u, xpub: XPUB })).address)
    }

    const inner = new FakeTron()
    inner.deposit({ to: addresses[1], amountMicros: 9n * USDT, blockNumber: 1000 })
    inner.setHead(2000)

    // A client that throws for exactly one address.
    const flaky: TronClient = {
      headBlock: () => inner.headBlock(),
      incomingTransfers: (address) => {
        if (address === addresses[0]) return Promise.reject(new Error('rpc exploded'))
        return inner.incomingTransfers(address)
      },
      trc20Balance: (a) => inner.trc20Balance(a),
      trxBalance: (a) => inner.trxBalance(a),
      sendTrc20: (a) => inner.sendTrc20(a),
    }

    const result = await pollDeposits(db, flaky, CONF)
    expect(result.addressesScanned).toBe(2)
    expect(await userBalance(db, users[1])).toBe(9n * USDT)
  })
})
