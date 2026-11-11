// "New workspace…" from the profile menu: name another business, then open it (its onboarding starts).
// Offered only where POST /v1/workspaces would allow it (`mayCreateWorkspace`, the rule from NoWorkspace);
// the server checks again.
import { useState } from 'react'
import { createWorkspace } from '../auth.ts'
import { Dialog, FormField, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'

export function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function create() {
    if (busy) return
    if (!name.trim()) return setError('Give the business a name.')
    setBusy(true)
    setError(null)
    try {
      // The new workspace is the session's active one now; reloading opens it with its own local store.
      await createWorkspace(name.trim())
      window.location.hash = ''
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="New workspace"
      description="For another business. Your assistant uses the name when it answers the phone."
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        void create()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy} shortcut={busy ? undefined : ['⏎']}>
            {busy ? 'Creating…' : 'Create workspace'}
          </Button>
        </>
      }
    >
      <FormField id="new-ws-name" label="Business name" error={error}>
        <Input
          id="new-ws-name"
          value={name}
          invalid={!!error}
          autoComplete="organization"
          placeholder="Riverside Electric"
          onChange={e => {
            setName(e.target.value)
            setError(null)
          }}
        />
      </FormField>
    </Dialog>
  )
}
