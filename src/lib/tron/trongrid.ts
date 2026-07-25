import { TronWeb } from 'tronweb'
import { TronError, type SendArgs, type TronClient, type Trc20Transfer } from './client'
import type { TronConfig } from './config'
import { hexToTronAddress } from './address'

type Json = Record<string, any>

export function createTronGridClient(
  config: TronConfig,
  fetchImpl: typeof fetch = fetch,
): TronClient {
  async function call(path: string, init?: RequestInit): Promise<Json> {
    const headers = new Headers(init?.headers)
    headers.set('accept', 'application/json')
    if (config.apiKey) headers.set('TRON-PRO-API-KEY', config.apiKey)
    if (init?.body) headers.set('content-type', 'application/json')

    const response = await fetchImpl(`${config.fullHost}${path}`, { ...init, headers })
    if (!response.ok) {
      throw new TronError(`TronGrid ${path} returned ${response.status}`, 'RPC_FAILED')
    }
    return (await response.json()) as Json
  }

  async function headBlock(): Promise<number> {
    const body = await call('/wallet/getnowblock', { method: 'POST', body: '{}' })
    const height = body?.block_header?.raw_data?.number
    if (typeof height !== 'number') {
      throw new TronError('getnowblock returned no block number', 'RPC_FAILED')
    }
    return height
  }

  /**
   * Two stages, because the cheap per-address endpoint carries no log index:
   *   1. discover candidate transaction ids for this address
   *   2. read each transaction's events for the authoritative index and block number
   */
  async function incomingTransfers(address: string): Promise<Trc20Transfer[]> {
    const query = new URLSearchParams({
      only_to: 'true',
      limit: '50',
      contract_address: config.usdtContract,
    })
    const discovery = await call(`/v1/accounts/${address}/transactions/trc20?${query}`)
    const rows: Json[] = discovery?.data ?? []

    const txIds = [...new Set(rows.map((r) => r.transaction_id).filter(Boolean))]
    const transfers: Trc20Transfer[] = []

    for (const txId of txIds) {
      const events = await call(`/v1/transactions/${txId}/events`)
      for (const event of (events?.data ?? []) as Json[]) {
        if (event.event_name !== 'Transfer') continue
        if (event.contract_address !== config.usdtContract) continue

        const to = hexToTronAddress(String(event.result?.to ?? ''))
        if (to !== address) continue

        transfers.push({
          txHash: txId,
          logIndex: Number(event.event_index),
          from: hexToTronAddress(String(event.result?.from ?? '')),
          to,
          amountMicros: BigInt(String(event.result?.value ?? '0')),
          blockNumber: Number(event.block_number),
        })
      }
    }

    return transfers.sort((a, b) => b.blockNumber - a.blockNumber)
  }

  function tronWebFor(privateKey?: string): TronWeb {
    return new TronWeb({
      fullHost: config.fullHost,
      headers: config.apiKey ? { 'TRON-PRO-API-KEY': config.apiKey } : undefined,
      privateKey,
    })
  }

  async function trc20Balance(address: string): Promise<bigint> {
    const tronWeb = tronWebFor()
    tronWeb.setAddress(address)
    const contract = await tronWeb.contract().at(config.usdtContract)
    const raw = await contract.balanceOf(address).call()
    return BigInt(raw.toString())
  }

  async function trxBalance(address: string): Promise<bigint> {
    const tronWeb = tronWebFor()
    return BigInt((await tronWeb.trx.getBalance(address)).toString())
  }

  async function sendTrc20(args: SendArgs): Promise<string> {
    const tronWeb = tronWebFor(args.fromPrivateKeyHex)
    try {
      const contract = await tronWeb.contract().at(config.usdtContract)
      const txHash: string = await contract
        .transfer(args.to, args.amountMicros.toString())
        .send({ feeLimit: 40_000_000 })
      return txHash
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = /energy|bandwidth/i.test(message) ? 'INSUFFICIENT_ENERGY' : 'BROADCAST_FAILED'
      throw new TronError(`TRC20 transfer failed: ${message}`, code)
    }
  }

  return { headBlock, incomingTransfers, trc20Balance, trxBalance, sendTrc20 }
}
