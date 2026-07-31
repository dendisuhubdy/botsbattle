'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'
import { Button, Callout } from '@/components/ui'

export function CreditForm({ users }: { users: { id: string; email: string }[] }) {
  const router = useRouter()
  const [userId, setUserId] = useState(users[0]?.id ?? '')
  const [amount, setAmount] = useState('100')
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost('/api/admin/credits', { userId, amount, reference })
      setReference('')
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
        <legend>Credit a balance (stands in for a deposit)</legend>
        <label>
          User
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount (USDT){' '}
          <input className="mono" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Reference (unique; replaying it is a no-op)
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            minLength={4}
            required
          />
        </label>
        {error && <Callout tone="danger">{error}</Callout>}
        <Button type="submit" disabled={busy || !userId}>
          {busy ? 'Crediting…' : 'Credit'}
        </Button>
      </fieldset>
    </form>
  )
}
