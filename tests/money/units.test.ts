import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { MICRO, parseUsdt, formatUsdt, formatUsdtExact } from '@/lib/money/units'

describe('parseUsdt', () => {
  it('parses whole and fractional amounts', () => {
    expect(parseUsdt('1')).toBe(1_000_000n)
    expect(parseUsdt('48.2')).toBe(48_200_000n)
    expect(parseUsdt('48.20')).toBe(48_200_000n)
    expect(parseUsdt('0.000001')).toBe(1n)
    expect(parseUsdt('0')).toBe(0n)
  })

  it('rejects malformed input', () => {
    for (const bad of ['', ' ', 'abc', '1.2.3', '-1', '1e6', '.5', '1.']) {
      expect(() => parseUsdt(bad)).toThrow(RangeError)
    }
  })

  it('rejects more precision than USDT has', () => {
    expect(() => parseUsdt('0.0000001')).toThrow(RangeError)
  })
})

describe('formatUsdt', () => {
  it('renders two decimal places', () => {
    expect(formatUsdt(48_200_000n)).toBe('48.20')
    expect(formatUsdt(0n)).toBe('0.00')
    expect(formatUsdt(1n)).toBe('0.00')
    expect(formatUsdt(-3_000_000n)).toBe('-3.00')
  })
})

describe('formatUsdtExact', () => {
  it('trims trailing zeros but keeps significant precision', () => {
    expect(formatUsdtExact(48_200_000n)).toBe('48.2')
    expect(formatUsdtExact(1n)).toBe('0.000001')
    expect(formatUsdtExact(1_000_000n)).toBe('1')
    expect(formatUsdtExact(-1_500_000n)).toBe('-1.5')
  })
})

describe('round trip', () => {
  it('parseUsdt(formatUsdtExact(x)) === x for any micro amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (micros) => {
        expect(parseUsdt(formatUsdtExact(micros))).toBe(micros)
      }),
      { numRuns: 500 },
    )
  })
})

describe('MICRO', () => {
  it('is one million', () => {
    expect(MICRO).toBe(1_000_000n)
  })
})
