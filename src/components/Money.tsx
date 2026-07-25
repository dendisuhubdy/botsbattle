import { formatUsdt } from '@/lib/money/units'

export function Money({ micros }: { micros: string | bigint | null }) {
  if (micros === null) return <span>—</span>
  return <span>{formatUsdt(BigInt(micros))} USDT</span>
}

export function Multiplier({ micros }: { micros: string | bigint | null }) {
  if (micros === null) return <span>—</span>
  return <span>{formatUsdt(BigInt(micros))}×</span>
}
