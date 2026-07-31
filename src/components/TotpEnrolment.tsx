'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'
import { Button, Callout } from '@/components/ui'

export function TotpEnrolment() {
  const router = useRouter()
  const [enrolment, setEnrolment] = useState<{ uri: string; secret: string } | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function begin() {
    setBusy(true)
    setError(null)
    try {
      setEnrolment(await apiPost<{ uri: string; secret: string }>('/api/me/totp'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost('/api/me/totp/confirm', { code })
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  if (!enrolment) {
    return (
      <fieldset>
        <legend>Two-factor authentication required</legend>
        <p>Withdrawals are protected by an authenticator app. Set one up to continue.</p>
        {error && <Callout tone="danger">{error}</Callout>}
        <Button type="button" onClick={begin} disabled={busy}>
          {busy ? 'Starting…' : 'Set up two-factor authentication'}
        </Button>
      </fieldset>
    )
  }

  return (
    <form onSubmit={confirm}>
      <fieldset>
        <legend>Finish setting up two-factor authentication</legend>
        <p>Add this to your authenticator app, then enter the six-digit code it shows.</p>
        <p>
          Setup key: <code className="mono">{enrolment.secret}</code>
        </p>
        <p className="estimate">
          Store this key somewhere safe. Losing it means losing the ability to withdraw.
        </p>
        <label>
          Code
          <input
            className="mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            required
          />
        </label>
        {error && <Callout tone="danger">{error}</Callout>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Confirm'}
        </Button>
      </fieldset>
    </form>
  )
}
