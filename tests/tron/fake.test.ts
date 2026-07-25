import { describe, it, expect } from 'vitest'
import { TronWeb } from 'tronweb'
import { FakeTron } from '@/lib/tron/fake'
import { TronError } from '@/lib/tron/client'

const ADDR_A = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'
const ADDR_B = 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK'
const USDT = 1_000_000n

describe('FakeTron', () => {
  it('starts at a known head and advances only when told', async () => {
    const tron = new FakeTron()
    expect(await tron.headBlock()).toBe(1000)
    tron.setHead(1042)
    expect(await tron.headBlock()).toBe(1042)
  })

  it('returns deposits addressed to the queried address only', async () => {
    const tron = new FakeTron()
    tron.deposit({ to: ADDR_A, amountMicros: 25n * USDT, blockNumber: 1001 })
    tron.deposit({ to: ADDR_B, amountMicros: 5n * USDT, blockNumber: 1001 })

    const forA = await tron.incomingTransfers(ADDR_A)
    expect(forA).toHaveLength(1)
    expect(forA[0]).toMatchObject({ to: ADDR_A, amountMicros: 25n * USDT, blockNumber: 1001 })
  })

  it('assigns distinct (txHash, logIndex) pairs automatically', async () => {
    const tron = new FakeTron()
    tron.deposit({ to: ADDR_A, amountMicros: 1n * USDT, blockNumber: 1001 })
    tron.deposit({ to: ADDR_A, amountMicros: 2n * USDT, blockNumber: 1002 })

    const transfers = await tron.incomingTransfers(ADDR_A)
    const keys = transfers.map((t) => `${t.txHash}:${t.logIndex}`)
    expect(new Set(keys).size).toBe(2)
  })

  it('supports two transfers sharing one transaction hash', async () => {
    const tron = new FakeTron()
    tron.deposit({
      to: ADDR_A,
      amountMicros: 1n * USDT,
      blockNumber: 1001,
      txHash: 'shared',
      logIndex: 0,
    })
    tron.deposit({
      to: ADDR_A,
      amountMicros: 2n * USDT,
      blockNumber: 1001,
      txHash: 'shared',
      logIndex: 1,
    })

    const transfers = await tron.incomingTransfers(ADDR_A)
    expect(transfers.map((t) => t.logIndex).sort()).toEqual([0, 1])
  })

  it('tracks the TRC20 balance as deposits land and sends leave', async () => {
    const tron = new FakeTron()
    tron.deposit({ to: ADDR_A, amountMicros: 30n * USDT, blockNumber: 1001 })
    expect(await tron.trc20Balance(ADDR_A)).toBe(30n * USDT)

    // The fake attributes the send to the address matching the key it was given, so fund
    // that address first.
    const key = 'aa'.repeat(32)
    const sender = TronWeb.address.fromPrivateKey(key) as string
    tron.deposit({ to: sender, amountMicros: 10n * USDT, blockNumber: 1001 })

    await tron.sendTrc20({ fromPrivateKeyHex: key, to: ADDR_B, amountMicros: 10n * USDT })

    expect(tron.broadcasts).toHaveLength(1)
    expect(tron.broadcasts[0]).toMatchObject({ to: ADDR_B, amountMicros: 10n * USDT })
    expect(await tron.trc20Balance(sender)).toBe(0n)
    expect(await tron.trc20Balance(ADDR_B)).toBe(10n * USDT)
  })

  it('refuses to send more than the sending address holds', async () => {
    const tron = new FakeTron()
    await expect(
      tron.sendTrc20({ fromPrivateKeyHex: 'aa'.repeat(32), to: ADDR_B, amountMicros: 1n * USDT }),
    ).rejects.toBeInstanceOf(TronError)
  })

  it('reports TRX balance, defaulting to zero', async () => {
    const tron = new FakeTron()
    expect(await tron.trxBalance(ADDR_A)).toBe(0n)
    tron.setTrxBalance(ADDR_A, 5_000_000n)
    expect(await tron.trxBalance(ADDR_A)).toBe(5_000_000n)
  })

  it('can be told to fail the next broadcast', async () => {
    const tron = new FakeTron()
    const key = 'aa'.repeat(32)
    const sender = TronWeb.address.fromPrivateKey(key) as string
    tron.deposit({ to: sender, amountMicros: 10n * USDT, blockNumber: 1 })

    tron.failNextSend('out of energy')
    await expect(
      tron.sendTrc20({ fromPrivateKeyHex: key, to: ADDR_B, amountMicros: 1n * USDT }),
    ).rejects.toBeInstanceOf(TronError)

    // The failure is consumed: the next send succeeds.
    const hash = await tron.sendTrc20({
      fromPrivateKeyHex: key,
      to: ADDR_B,
      amountMicros: 1n * USDT,
    })
    expect(hash).toMatch(/^send[0-9a-f]+$/)
  })
})
