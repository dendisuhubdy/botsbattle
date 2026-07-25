import { TronWeb } from 'tronweb'
import { TronError, type SendArgs, type TronClient, type Trc20Transfer } from './client'

/**
 * A deterministic in-memory chain. No randomness and no clock: transaction hashes are
 * generated from a counter so tests reproduce exactly.
 */
export class FakeTron implements TronClient {
  private head = 1000
  private transfers: Trc20Transfer[] = []
  private trc20: Map<string, bigint> = new Map()
  private trx: Map<string, bigint> = new Map()
  private counter = 0
  private nextSendFailure: string | null = null

  readonly broadcasts: Array<{ from: string; to: string; amountMicros: bigint; txHash: string }> =
    []

  setHead(n: number): void {
    this.head = n
  }

  setTrxBalance(address: string, sun: bigint): void {
    this.trx.set(address, sun)
  }

  failNextSend(message: string): void {
    this.nextSendFailure = message
  }

  deposit(args: {
    to: string
    amountMicros: bigint
    blockNumber: number
    txHash?: string
    logIndex?: number
    from?: string
  }): Trc20Transfer {
    const transfer: Trc20Transfer = {
      txHash: args.txHash ?? `fake${(this.counter++).toString(16).padStart(60, '0')}`,
      logIndex: args.logIndex ?? 0,
      from: args.from ?? 'TSenderAddressPlaceholder00000000',
      to: args.to,
      amountMicros: args.amountMicros,
      blockNumber: args.blockNumber,
    }
    this.transfers.push(transfer)
    this.credit(args.to, args.amountMicros)
    return transfer
  }

  private credit(address: string, amount: bigint): void {
    this.trc20.set(address, (this.trc20.get(address) ?? 0n) + amount)
  }

  async headBlock(): Promise<number> {
    return this.head
  }

  async incomingTransfers(address: string): Promise<Trc20Transfer[]> {
    return this.transfers
      .filter((t) => t.to === address)
      .slice()
      .sort((a, b) => b.blockNumber - a.blockNumber)
  }

  async trc20Balance(address: string): Promise<bigint> {
    return this.trc20.get(address) ?? 0n
  }

  async trxBalance(address: string): Promise<bigint> {
    return this.trx.get(address) ?? 0n
  }

  async sendTrc20(args: SendArgs): Promise<string> {
    if (this.nextSendFailure) {
      const message = this.nextSendFailure
      this.nextSendFailure = null
      throw new TronError(message, 'BROADCAST_FAILED')
    }

    const from = TronWeb.address.fromPrivateKey(args.fromPrivateKeyHex)
    if (from === false) throw new TronError('invalid private key', 'BROADCAST_FAILED')

    const available = this.trc20.get(from) ?? 0n
    if (available < args.amountMicros) {
      throw new TronError(
        `fake chain: ${from} holds ${available}, cannot send ${args.amountMicros}`,
        'BROADCAST_FAILED',
      )
    }

    this.trc20.set(from, available - args.amountMicros)
    this.credit(args.to, args.amountMicros)

    const txHash = `send${(this.counter++).toString(16).padStart(60, '0')}`
    this.broadcasts.push({ from, to: args.to, amountMicros: args.amountMicros, txHash })

    // A broadcast is a real transfer on the fake chain, so it must be visible to a later
    // `incomingTransfers` call — otherwise a poller watching the destination address can
    // never see its own signer's sends land.
    this.transfers.push({
      txHash,
      logIndex: 0,
      from,
      to: args.to,
      amountMicros: args.amountMicros,
      blockNumber: this.head,
    })

    return txHash
  }
}
