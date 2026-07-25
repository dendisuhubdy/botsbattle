'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'

/**
 * Approval sends real money and is irreversible, so it requires a typed confirmation before
 * the button is enabled — same gate as FightAdminControls uses for settlement. Rejection has
 * no such gate (it only returns ring-fenced funds) but requires a non-empty note, enforced
 * both here and server-side.
 */
export function WithdrawalReviewControls({
  requestId,
  address,
  amountLabel,
}: {
  requestId: string
  address: string
  amountLabel: string
}) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const armed = confirm === 'SEND'

  async function call(path: string, body?: unknown) {
    setBusy(true)
    setError(null)
    try {
      await apiPost(path, body)
      setConfirm('')
      setNote('')
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset>
      <legend>
        Review — {amountLabel} to <code>{address}</code>
      </legend>
      <label>
        Note
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label>
        Type SEND to enable approval
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <button
        disabled={busy || !armed}
        onClick={() => call(`/api/admin/withdrawals/${requestId}/approve`, { note: note || undefined })}
      >
        Approve and send
      </button>{' '}
      <button
        disabled={busy || note.trim().length === 0}
        onClick={() => call(`/api/admin/withdrawals/${requestId}/reject`, { note })}
      >
        Reject and refund
      </button>
      {error && <p className="error">{error}</p>}
    </fieldset>
  )
}
