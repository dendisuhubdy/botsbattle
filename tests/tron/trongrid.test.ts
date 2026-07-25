import { describe, it, expect } from 'vitest'
import { createTronGridClient } from '@/lib/tron/trongrid'
import { TronError } from '@/lib/tron/client'
import type { TronConfig } from '@/lib/tron/config'

const ADDR = 'TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9'
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TX = '8b5e5f9a99d65c0b3aac7f3cbc2ee3029a0d4225054fd99830236d96d853c503'

const config: TronConfig = {
  network: 'nile',
  fullHost: 'https://nile.trongrid.io',
  apiKey: 'test-key',
  usdtContract: USDT_CONTRACT,
  confirmations: 19,
  sweepMinMicros: 20_000_000n,
  hotWalletAddress: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
  hotWalletIndex: 0,
  xpub: 'xpub-not-used-here',
}

/** Response bodies copied from the live probe recorded in the Slice 2 plan header. */
function stubFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    const match = Object.keys(routes).find((k) => url.includes(k))
    if (!match) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(routes[match]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

describe('TronGrid client', () => {
  it('reads the head block height', async () => {
    const client = createTronGridClient(
      config,
      stubFetch({ '/wallet/getnowblock': { block_header: { raw_data: { number: 84768962 } } } }),
    )
    expect(await client.headBlock()).toBe(84768962)
  })

  it('joins the discovery and events endpoints into transfers', async () => {
    const calls: string[] = []
    const client = createTronGridClient(
      config,
      stubFetch(
        {
          '/transactions/trc20': {
            success: true,
            data: [
              {
                transaction_id: TX,
                token_info: { address: USDT_CONTRACT, decimals: 6, symbol: 'USDT' },
                block_timestamp: 1764517689000,
                from: 'TEPSrSYPDSQ7yXpMFPq91Fb1QEWpMkRGfn',
                to: ADDR,
                type: 'Transfer',
                value: '2000000',
              },
            ],
          },
          [`/transactions/${TX}/events`]: {
            success: true,
            data: [
              {
                event_name: 'Transfer',
                event_index: 0,
                block_number: 77951958,
                contract_address: USDT_CONTRACT,
                result: {
                  from: '0x30760c7e10b1d3509d8d64a7e9eb9ab94bc83495',
                  to: '0x82dd6b9966724ae2fdc79b416c7588da67ff1b35',
                  value: '2000000',
                },
              },
            ],
          },
        },
        calls,
      ),
    )

    const transfers = await client.incomingTransfers(ADDR)
    expect(transfers).toEqual([
      {
        txHash: TX,
        logIndex: 0,
        // Not a guess: this is the value TronGrid's discovery endpoint reported as `from`
        // for this transaction, so the hex conversion is checked against TronGrid's own base58.
        from: 'TEPSrSYPDSQ7yXpMFPq91Fb1QEWpMkRGfn',
        to: ADDR,
        amountMicros: 2_000_000n,
        blockNumber: 77951958,
      },
    ])
    expect(calls.some((c) => c.includes('only_to=true'))).toBe(true)
    expect(calls.some((c) => c.includes(`contract_address=${USDT_CONTRACT}`))).toBe(true)
  })

  it('ignores events from other contracts and other recipients', async () => {
    const client = createTronGridClient(
      config,
      stubFetch({
        '/transactions/trc20': {
          success: true,
          data: [
            { transaction_id: TX, token_info: { address: USDT_CONTRACT }, to: ADDR, value: '1' },
          ],
        },
        [`/transactions/${TX}/events`]: {
          success: true,
          data: [
            {
              event_name: 'Transfer',
              event_index: 0,
              block_number: 10,
              contract_address: 'TSomeOtherContract0000000000000000',
              result: {
                from: '0x' + '11'.repeat(20),
                to: '0x82dd6b9966724ae2fdc79b416c7588da67ff1b35',
                value: '1',
              },
            },
            {
              event_name: 'Transfer',
              event_index: 1,
              block_number: 10,
              contract_address: USDT_CONTRACT,
              result: { from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), value: '9' },
            },
            {
              event_name: 'Approval',
              event_index: 2,
              block_number: 10,
              contract_address: USDT_CONTRACT,
              result: {
                from: '0x' + '11'.repeat(20),
                to: '0x82dd6b9966724ae2fdc79b416c7588da67ff1b35',
                value: '5',
              },
            },
          ],
        },
      }),
    )

    expect(await client.incomingTransfers(ADDR)).toEqual([])
  })

  it('sends the API key header when configured', async () => {
    let seenKey: string | null = null
    const client = createTronGridClient(config, (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seenKey = new Headers(init?.headers).get('TRON-PRO-API-KEY')
      return new Response(JSON.stringify({ block_header: { raw_data: { number: 1 } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch)

    await client.headBlock()
    expect(seenKey).toBe('test-key')
  })

  it('raises TronError on a non-200 response', async () => {
    const client = createTronGridClient(
      config,
      (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
    )

    await expect(client.headBlock()).rejects.toMatchObject({ code: 'RPC_FAILED' })
    await expect(client.headBlock()).rejects.toBeInstanceOf(TronError)
  })

  it('treats an empty discovery result as no transfers', async () => {
    const client = createTronGridClient(
      config,
      stubFetch({ '/transactions/trc20': { success: true, data: [] } }),
    )
    expect(await client.incomingTransfers(ADDR)).toEqual([])
  })
})
