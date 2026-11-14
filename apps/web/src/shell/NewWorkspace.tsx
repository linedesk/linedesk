// "New workspace…" from the workspace menu: name another business, then open it (its onboarding starts).
// Offered only where POST /v1/workspaces would allow it (`mayCreateWorkspace`, the rule from NoWorkspace);
// the server checks again.
import { useState } from 'react'
import { createWorkspace } from '../auth.ts'
import { type CreatingPhase, CreatingStatus } from '../CreatingStatus.tsx'
import { Dialog, FormField, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'

/** `returnTo`: the page the app opens on in the new workspace (its onboarding when left out; the setup page passes its own). */
export function NewWorkspaceDialog({ onClose, returnTo = '' }: { onClose: () => void; returnTo?: string }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<CreatingPhase>('idle')
  const busy = phase !== 'idle'

  async function create() {
    if (busy) return
    if (!name.trim()) return setError('Give the business a name.')
    setPhase('creating')
    setError(null)
    try {
      // The new workspace is the session's active one now; reloading opens it with its own local store.
      await createWorkspace(name.trim())
      // The page stays on screen until the reload has loaded the app again: say so meanwhile.
      setPhase('opening')
      window.location.hash = returnTo
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle')
    }
  }

  return (
    <Dialog
      title="New workspace"
      description="The assistant says this name on calls."
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
          <Button type="submit" variant="primary" busy={busy} shortcut={['⏎']}>
            {phase === 'opening' ? 'Opening…' : busy ? 'Creating…' : 'Create workspace'}
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
          disabled={busy}
          placeholder="Riverside Electric"
          onChange={e => {
            setName(e.target.value)
            setError(null)
          }}
        />
      </FormField>
      <CreatingStatus phase={phase} name={name.trim()} />
    </Dialog>
  )
}
