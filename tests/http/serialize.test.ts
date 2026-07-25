import { describe, it, expect } from 'vitest'
import { jsonSafe } from '@/lib/http/serialize'

describe('jsonSafe', () => {
  it('converts bigints to decimal strings', () => {
    expect(jsonSafe({ stake: 25_000_000n })).toEqual({ stake: '25000000' })
  })

  it('converts dates to ISO strings', () => {
    const at = new Date('2026-07-25T12:00:00.000Z')
    expect(jsonSafe({ at })).toEqual({ at: '2026-07-25T12:00:00.000Z' })
  })

  it('recurses through arrays and nested objects', () => {
    expect(jsonSafe({ bets: [{ stake: 1n, meta: { payout: null } }] })).toEqual({
      bets: [{ stake: '1', meta: { payout: null } }],
    })
  })

  it('leaves primitives alone', () => {
    expect(jsonSafe({ a: 1, b: 'x', c: true, d: null })).toEqual({ a: 1, b: 'x', c: true, d: null })
  })

  it('survives JSON.stringify', () => {
    expect(() => JSON.stringify(jsonSafe({ stake: 1n }))).not.toThrow()
  })
})
