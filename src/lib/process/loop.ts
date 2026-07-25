export type LoopOptions = {
  intervalMs: number
  signal: AbortSignal
  onTick: () => Promise<void>
  onError?: (err: unknown) => void
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
  })
}

/**
 * Tick until aborted. A throwing tick is reported and the loop continues — a long-running
 * chain watcher that exits on the first RPC hiccup is worse than useless.
 */
export async function runLoop(opts: LoopOptions): Promise<void> {
  while (!opts.signal.aborted) {
    try {
      await opts.onTick()
    } catch (err) {
      opts.onError?.(err)
    }
    if (opts.signal.aborted) break
    await delay(opts.intervalMs, opts.signal)
  }
}
