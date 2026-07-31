'use client'

import { useState } from 'react'
import { apiPost, ApiError } from '@/lib/client/api'
import { Button, Callout, Panel } from '@/components/ui'

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
      <Panel title="Your deposit address">
        <p className="mono depositAddress">{address}</p>
        <Callout tone="info" title="Before you send">
          USDT on the TRON network (TRC-20) only. Sending any other asset or using any
          other network will lose the funds permanently. Deposits credit after the
          required confirmations.
        </Callout>
        <Button type="button" variant="ghost" onClick={() => navigator.clipboard.writeText(address)}>
          Copy
        </Button>
      </Panel>
    )
  }

  return (
    <Panel title="Your deposit address">
      {error && <Callout tone="danger">{error}</Callout>}
      <Button type="button" onClick={reveal} disabled={busy}>
        {busy ? 'Generating…' : 'Show my deposit address'}
      </Button>
    </Panel>
  )
}
