/**
 * Recursively convert values JSON cannot represent: `bigint` becomes a decimal string
 * (micro-units, never a Number — 2^53 is only ~9 billion USDT) and `Date` becomes ISO 8601.
 */
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]),
    )
  }
  return value
}
