'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'
import { formatUsdt } from '@/lib/money/units'
import { Button, Callout } from '@/components/ui'

export function WithdrawForm({
  availableMicros,
  minimumMicros,
}: {
  availableMicros: string
  minimumMicros: string
}) {
  const router = useRouter()
  const [address, setAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await apiPost('/api/me/withdrawals', { address, amount, totpCode })
      setMessage('Withdrawal requested. It will be reviewed before it is sent.')
      setAmount('')
      setTotpCode('')
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>Withdraw USDT</legend>
        <p className="estimate">
          Available: <span className="mono">{formatUsdt(BigInt(availableMicros))} USDT</span> ·
          minimum <span className="mono">{formatUsdt(BigInt(minimumMicros))} USDT</span>
        </p>
        <label>
          Destination Tron address
          <input className="mono" value={address} onChange={(e) => setAddress(e.target.value)} required />
        </label>
        <p className="estimate">
          USDT-TRC20 only. Check the address carefully — a sent withdrawal cannot be reversed.
        </p>
        <label>
          Amount (USDT)
          <input
            className="mono"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            required
          />
        </label>
        <label>
          Authenticator code
          <input
            className="mono"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            inputMode="numeric"
            required
          />
        </label>
        {error && <Callout tone="danger">{error}</Callout>}
        {message && <p>{message}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Requesting…' : 'Request withdrawal'}
        </Button>
      </fieldset>
    </form>
  )
}
