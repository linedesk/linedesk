// Someone who signed up with an email code has no name yet: teammates would see their address twice
// and emails would say "A teammate". Ask once, right in the app; Later hides it for this session.
import { type FormEvent, useState } from 'react'
import { auth } from '../auth.ts'
import { changeName } from '../settings/account/account-api.ts'
import { Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'

const LATER_KEY = 'linedesk.askName.later'

function laterChosen() {
  try {
    return sessionStorage.getItem(LATER_KEY) === '1'
  } catch {
    return false
  }
}

/** Shown while the signed-in user has no name (not while an admin is signed in as them). */
export function AskName({ impersonating }: { impersonating: boolean }) {
  const session = auth.useSession()
  const [later, setLater] = useState(laterChosen)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const user = session.data?.user
  if (!user || user.name?.trim() || impersonating || later) return null

  function postpone() {
    try {
      sessionStorage.setItem(LATER_KEY, '1')
    } catch {
      // Private mode: it asks again on the next load.
    }
    setLater(true)
  }
  async function save(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return setError('Enter your name.')
    setBusy(true)
    setError(null)
    try {
      await changeName(trimmed)
      await session.refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="What's your name?"
      size="sm"
      onClose={busy ? () => {} : postpone}
      onSubmit={save}
      footer={
        <>
          <Button variant="ghost" onClick={postpone} disabled={busy}>
            Later
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <FormField id="ask-name" label="Name">
        <Input id="ask-name" value={name} autoComplete="name" maxLength={80} onChange={e => setName(e.target.value)} />
      </FormField>
      {error && <FormMessage>{error}</FormMessage>}
    </Dialog>
  )
}
