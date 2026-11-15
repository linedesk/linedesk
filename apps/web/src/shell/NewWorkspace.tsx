// "New workspace…" from the workspace menu: name another business, then open it (its onboarding starts).
// Offered only where POST /v1/workspaces would allow it (`mayCreateWorkspace`, the rule from NoWorkspace);
// the server checks again. Refused because the session's passkey check ran out meanwhile (403 `admin_second_factor`):
// the dialog offers the passkey prompt (Server admin opens on it) instead of an error line.
import { useState } from 'react'
import { type AdminSecondFactor, createWorkspace } from '../auth.ts'
import { secondFactorDue } from '../CreateWorkspace.tsx'
import { type CreatingPhase, CreatingStatus } from '../CreatingStatus.tsx'
import { Dialog, FormField, Input } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'

/** Server admin opens on the passkey check while it is due (Workspace.tsx, AdminMode). */
const openPasskeyCheck = () => {
  window.location.hash = '#admin'
}

import { useT } from '@linedesk/i18n/react'

/** `returnTo`: the page the app opens on in the new workspace (its onboarding when left out; the setup page passes its own). */
export function NewWorkspaceDialog({ onClose, returnTo = '' }: { onClose: () => void; returnTo?: string }) {
  const t = useT()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<CreatingPhase>('idle')
  const [passkeyFirst, setPasskeyFirst] = useState<AdminSecondFactor | null>(null)
  const busy = phase !== 'idle'

  async function create() {
    if (busy) return
    if (!name.trim()) return setError(t('shell.newWorkspace.nameMissing'))
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
      const due = await secondFactorDue()
      setPhase('idle')
      if (due) setPasskeyFirst(due)
      else setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Dialog
      title={t('shell.newWorkspace.title')}
      description={t('shell.newWorkspace.description')}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        if (passkeyFirst) openPasskeyCheck()
        else void create()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          {passkeyFirst ? (
            <Button type="submit" variant="primary" shortcut={['⏎']} title={t('shell.newWorkspace.passkey.openCheck')}>
              {/* i18n-dynamic: shell.newWorkspace.passkey.button.* */}
              {t(`shell.newWorkspace.passkey.button.${passkeyFirst}`)}
            </Button>
          ) : (
            <Button type="submit" variant="primary" busy={busy} shortcut={['⏎']}>
              {phase === 'opening'
                ? t('shell.newWorkspace.opening')
                : busy
                  ? t('shell.newWorkspace.creating')
                  : t('shell.newWorkspace.create')}
            </Button>
          )}
        </>
      }
    >
      {passkeyFirst && (
        <Note tone="info">
          {/* i18n-dynamic: shell.newWorkspace.passkey.note.* */}
          {t(`shell.newWorkspace.passkey.note.${passkeyFirst}`)}
        </Note>
      )}
      <FormField id="new-ws-name" label={t('shell.newWorkspace.name')} error={error}>
        <Input
          id="new-ws-name"
          value={name}
          invalid={!!error}
          autoComplete="organization"
          disabled={busy}
          placeholder={t('shell.newWorkspace.namePlaceholder')}
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
