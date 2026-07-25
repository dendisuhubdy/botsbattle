export const DECIMALS = 6
export const MICRO = 1_000_000n
export const MIN_STAKE_MICROS = 1_000_000n

const AMOUNT_RE = /^(\d+)(?:\.(\d+))?$/

/**
 * Parse a non-negative decimal USDT string into micro-units.
 * Rejects anything that is not a plain decimal with at most 6 fractional digits.
 */
export function parseUsdt(input: string): bigint {
  const match = AMOUNT_RE.exec(input)
  if (!match) throw new RangeError(`not a valid USDT amount: ${JSON.stringify(input)}`)

  const [, whole, fraction = ''] = match
  if (fraction.length > DECIMALS) {
    throw new RangeError(`USDT has ${DECIMALS} decimals, got ${fraction.length}`)
  }

  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(DECIMALS, '0') || '0')
}

function split(micros: bigint): { sign: string; whole: bigint; fraction: string } {
  const negative = micros < 0n
  const abs = negative ? -micros : micros
  return {
    sign: negative ? '-' : '',
    whole: abs / MICRO,
    fraction: (abs % MICRO).toString().padStart(DECIMALS, '0'),
  }
}

/** Display form with exactly two decimal places. Truncates, never rounds up. */
export function formatUsdt(micros: bigint): string {
  const { sign, whole, fraction } = split(micros)
  return `${sign}${whole}.${fraction.slice(0, 2)}`
}

/** Lossless display form: up to six decimals, trailing zeros trimmed. */
export function formatUsdtExact(micros: bigint): string {
  const { sign, whole, fraction } = split(micros)
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`
}
