export type TronNetwork = 'nile' | 'mainnet'

export type TronConfig = {
  network: TronNetwork
  fullHost: string
  apiKey: string | null
  usdtContract: string
  confirmations: number
  sweepMinMicros: bigint
  hotWalletAddress: string
  xpub: string
}

const DEFAULT_HOSTS: Record<TronNetwork, string> = {
  nile: 'https://nile.trongrid.io',
  mainnet: 'https://api.trongrid.io',
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

export function loadTronConfig(env: NodeJS.ProcessEnv = process.env): TronConfig {
  const network = (env.TRON_NETWORK ?? 'nile') as TronNetwork
  if (network !== 'nile' && network !== 'mainnet') {
    throw new Error(`TRON_NETWORK must be "nile" or "mainnet", got ${network}`)
  }

  return {
    network,
    fullHost: env.TRON_FULL_HOST ?? DEFAULT_HOSTS[network],
    apiKey: env.TRONGRID_API_KEY ?? null,
    usdtContract: required(env, 'TRON_USDT_CONTRACT'),
    confirmations: Number(env.TRON_CONFIRMATIONS ?? '19'),
    sweepMinMicros: BigInt(env.TRON_SWEEP_MIN_MICROS ?? '20000000'),
    hotWalletAddress: required(env, 'TRON_HOT_WALLET_ADDRESS'),
    xpub: required(env, 'TRON_XPUB'),
  }
}
