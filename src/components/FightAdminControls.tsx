'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'
import { Button, Callout, Panel, Tape } from '@/components/ui'

/**
 * Settlement asks for a typed confirmation because it is irreversible and moves real
 * balances. The same gate arms the void button.
 */
export function FightAdminControls({
  fightId,
  status,
  fighterA,
  fighterB,
}: {
  fightId: string
  status: string
  fighterA: string
  fighterB: string
}) {
  const router = useRouter()
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function call(path: string, body?: unknown) {
    setBusy(true)
    setError(null)
    try {
      await apiPost(path, body)
      setConfirm('')
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const canSettle = status === 'LOCKED'
  const canVoid = status === 'OPEN' || status === 'LOCKED'
  const armed = confirm === 'SETTLE'

  return (
    <fieldset>
      <legend>Controls — fight is {status}</legend>

      {status === 'DRAFT' && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => call(`/api/admin/fights/${fightId}/publish`)}
        >
          Publish (open betting)
        </Button>
      )}

      {(canSettle || canVoid) && (
        <>
          <label>
            Type SETTLE to enable outcome buttons
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>

          <Tape />
          <Panel title="Settle or void" tone="danger">
            {canSettle && (
              <>
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy || !armed}
                  onClick={() => call(`/api/admin/fights/${fightId}/settle`, { outcome: 'A' })}
                >
                  {fighterA} (A) won
                </Button>{' '}
                <Button
                  type="button"
                  variant="danger"
                  disabled={busy || !armed}
                  onClick={() => call(`/api/admin/fights/${fightId}/settle`, { outcome: 'B' })}
                >
                  {fighterB} (B) won
                </Button>{' '}
              </>
            )}

            {canVoid && (
              <Button
                type="button"
                variant="danger"
                disabled={busy || !armed}
                onClick={() => call(`/api/admin/fights/${fightId}/settle`, { outcome: 'VOID' })}
              >
                Void and refund
              </Button>
            )}
          </Panel>
        </>
      )}

      {error && <Callout tone="danger">{error}</Callout>}
    </fieldset>
  )
}
