'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'
import { formatUsdt } from '@/lib/money/units'

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
          Available: {formatUsdt(BigInt(availableMicros))} USDT · minimum{' '}
          {formatUsdt(BigInt(minimumMicros))} USDT
        </p>
        <label>
          Destination Tron address
          <input value={address} onChange={(e) => setAddress(e.target.value)} required />
        </label>
        <p className="estimate">
          USDT-TRC20 only. Check the address carefully — a sent withdrawal cannot be reversed.
        </p>
        <label>
          Amount (USDT)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
        </label>
        <label>
          Authenticator code
          <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} inputMode="numeric" required />
        </label>
        {error && <p className="error">{error}</p>}
        {message && <p>{message}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Requesting…' : 'Request withdrawal'}
        </button>
      </fieldset>
    </form>
  )
}
