export type Trc20Transfer = {
  txHash: string
  logIndex: number
  from: string
  to: string
  amountMicros: bigint
  blockNumber: number
}

export type SendArgs = {
  fromPrivateKeyHex: string
  to: string
  amountMicros: bigint
}

export class TronError extends Error {
  constructor(
    message: string,
    readonly code: 'RPC_FAILED' | 'BROADCAST_FAILED' | 'INSUFFICIENT_ENERGY',
  ) {
    super(message)
    this.name = 'TronError'
  }
}

/**
 * Every chain interaction the platform performs. Deliberately narrow: the fake in
 * `fake.ts` must be able to implement all of it faithfully, or the tests are lying.
 */
export type TronClient = {
  headBlock(): Promise<number>
  /** TRC20 transfers *into* `address`, newest first. */
  incomingTransfers(address: string, opts?: { sinceMs?: number }): Promise<Trc20Transfer[]>
  trc20Balance(address: string): Promise<bigint>
  /** TRX balance in SUN (1 TRX = 1e6 SUN), used to check sweep gas. */
  trxBalance(address: string): Promise<bigint>
  sendTrc20(args: SendArgs): Promise<string>
}
