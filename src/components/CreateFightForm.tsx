'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { apiPost, ApiError } from '@/lib/client/api'
import { Button, Callout } from '@/components/ui'

export function CreateFightForm() {
  const router = useRouter()
  const [form, setForm] = useState({
    leagueName: '',
    fighterA: '',
    fighterB: '',
    streamEmbedUrl: '',
    lockAt: '',
    rakeBps: '500',
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost('/api/admin/fights', {
        leagueName: form.leagueName,
        fighterA: form.fighterA,
        fighterB: form.fighterB,
        streamEmbedUrl: form.streamEmbedUrl || null,
        lockAt: new Date(form.lockAt).toISOString(),
        rakeBps: Number(form.rakeBps),
      })
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
        <legend>New fight</legend>
        <label>
          League <input value={form.leagueName} onChange={set('leagueName')} required />
        </label>
        <label>
          Robot A <input value={form.fighterA} onChange={set('fighterA')} required />
        </label>
        <label>
          Robot B <input value={form.fighterB} onChange={set('fighterB')} required />
        </label>
        <label>
          Stream embed URL <input value={form.streamEmbedUrl} onChange={set('streamEmbedUrl')} />
        </label>
        <label>
          Locks at{' '}
          <input type="datetime-local" value={form.lockAt} onChange={set('lockAt')} required />
        </label>
        <label>
          Rake (bps, 0–2000) <input type="number" value={form.rakeBps} onChange={set('rakeBps')} />
        </label>
        {error && <Callout tone="danger">{error}</Callout>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create draft'}
        </Button>
      </fieldset>
    </form>
  )
}
