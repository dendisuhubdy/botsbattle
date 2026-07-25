'use client'

import { useEffect, useState, useRef } from 'react'
import { apiGet, apiPost, ApiError } from '@/lib/client/api'
import { formatUsdt } from '@/lib/money/units'

export type FightView = {
  fight: { id: string; fighterA: string; fighterB: string; status: string; outcome: string | null }
  totals: { total: string; a: string; b: string }
  estimated: { a: string | null; b: string | null }
}

const POLL_MS = 3000

export function BetForm({ fightId, initial }: { fightId: string; initial: FightView }) {
  const [view, setView] = useState(initial)
  const [side, setSide] = useState<'A' | 'B'>('A')
  const [stake, setStake] = useState('10')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A fresh key per successful submission, so a retried click cannot double-charge.
  const keyRef = useRef(crypto.randomUUID())

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        setView(await apiGet<FightView>(`/api/fights/${fightId}`))
      } catch {
        // A failed poll is not worth surfacing; the next one will refresh the numbers.
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [fightId])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await apiPost(`/api/fights/${fightId}/bets`, {
        side,
        stake,
        idempotencyKey: keyRef.current,
      })
      keyRef.current = crypto.randomUUID()
      setMessage(`Bet placed on ${side}.`)
      setView(await apiGet<FightView>(`/api/fights/${fightId}`))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const open = view.fight.status === 'OPEN'
  const estimate = side === 'A' ? view.estimated.a : view.estimated.b

  return (
    <>
      <table>
        <tbody>
          <tr>
            <th>Pool</th>
            <td>{formatUsdt(BigInt(view.totals.total))} USDT</td>
          </tr>
          <tr>
            <th>{view.fight.fighterA} (A)</th>
            <td>
              {formatUsdt(BigInt(view.totals.a))} USDT —{' '}
              {view.estimated.a ? `${formatUsdt(BigInt(view.estimated.a))}×` : '—'}
            </td>
          </tr>
          <tr>
            <th>{view.fight.fighterB} (B)</th>
            <td>
              {formatUsdt(BigInt(view.totals.b))} USDT —{' '}
              {view.estimated.b ? `${formatUsdt(BigInt(view.estimated.b))}×` : '—'}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="estimate">
        Estimated payouts move with the pool and are not fixed until betting locks.
      </p>

      {open ? (
        <form onSubmit={submit}>
          <fieldset>
            <legend>Place a bet</legend>
            <label>
              Robot
              <select value={side} onChange={(e) => setSide(e.target.value as 'A' | 'B')}>
                <option value="A">{view.fight.fighterA} (A)</option>
                <option value="B">{view.fight.fighterB} (B)</option>
              </select>
            </label>
            <label>
              Stake (USDT, minimum 1)
              <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" />
            </label>
            <p className="estimate">
              At the current pool that would return about{' '}
              {estimate ? `${formatUsdt(BigInt(estimate))}× your stake` : 'an unknown multiple'}.
            </p>
            {error && <p className="error">{error}</p>}
            {message && <p>{message}</p>}
            <button type="submit" disabled={busy}>
              {busy ? 'Placing…' : 'Place bet'}
            </button>
          </fieldset>
        </form>
      ) : (
        <p>
          Betting is closed — this fight is {view.fight.status}
          {view.fight.outcome ? ` (${view.fight.outcome})` : ''}.
        </p>
      )}
    </>
  )
}
