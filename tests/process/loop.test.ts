import { describe, it, expect } from 'vitest'
import { runLoop } from '@/lib/process/loop'

describe('runLoop', () => {
  it('ticks repeatedly until aborted', async () => {
    const controller = new AbortController()
    let ticks = 0

    await runLoop({
      intervalMs: 1,
      signal: controller.signal,
      onTick: async () => {
        ticks++
        if (ticks >= 5) controller.abort()
      },
    })

    expect(ticks).toBe(5)
  })

  it('survives a throwing tick and reports it', async () => {
    const controller = new AbortController()
    const errors: unknown[] = []
    let ticks = 0

    await runLoop({
      intervalMs: 1,
      signal: controller.signal,
      onTick: async () => {
        ticks++
        if (ticks === 1) throw new Error('transient')
        if (ticks >= 3) controller.abort()
      },
      onError: (err) => errors.push(err),
    })

    expect(ticks).toBe(3)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('transient')
  })

  it('does not tick at all if aborted before starting', async () => {
    const controller = new AbortController()
    controller.abort()
    let ticks = 0

    await runLoop({
      intervalMs: 1,
      signal: controller.signal,
      onTick: async () => {
        ticks++
      },
    })

    expect(ticks).toBe(0)
  })
})
