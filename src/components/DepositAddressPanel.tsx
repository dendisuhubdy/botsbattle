'use client'

import { useState } from 'react'
import { apiPost, ApiError } from '@/lib/client/api'

export function DepositAddressPanel({ initialAddress }: { initialAddress: string | null }) {
  const [address, setAddress] = useState(initialAddress)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function reveal() {
    setBusy(true)
    setError(null)
    try {
      const result = await apiPost<{ address: string }>('/api/me/deposit-address')
      setAddress(result.address)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  if (address) {
    return (
      <fieldset>
        <legend>Your deposit address</legend>
        <p>
          <code>{address}</code>
        </p>
        <button onClick={() => navigator.clipboard.writeText(address)}>Copy</button>
      </fieldset>
    )
  }

  return (
    <fieldset>
      <legend>Your deposit address</legend>
      {error && <p className="error">{error}</p>}
      <button onClick={reveal} disabled={busy}>
        {busy ? 'Generating…' : 'Show my deposit address'}
      </button>
    </fieldset>
  )
}
