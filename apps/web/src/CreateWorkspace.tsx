import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { createWorkspace } from './auth.ts'
import { type CreatingPhase, CreatingStatus } from './CreatingStatus.tsx'
import { signOutAndForget } from './localData.ts'
import { deletedOnPurpose, leftOnPurpose } from './session.ts'
import { AuthPage, Note, Spinner } from './ui/kit.tsx'

/** How long "Opening…" may last before the page says to reload. */
const OPENING_MS = 15_000

/**
 * First sign-in: name the business. Creates the workspace and its assistant. `lostWorkspace`: the
 * workspace this browser had open, which the member was removed from; said first, so the form is not
 * a surprise. `children`: shown under the form (invitations, Admin). `embedded`: only the form, as the secondary way
 * on an instance admin's start page (NoWorkspace.tsx, AdminStart): no page around it, its button not the primary one.
 */
export function CreateWorkspace({
  onDone,
  lostWorkspace = null,
  children,
  embedded = false,
}: {
  onDone: () => void | Promise<void>
  lostWorkspace?: string | null
  children?: ReactNode
  embedded?: boolean
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<CreatingPhase>('idle')
  const busy = phase !== 'idle'
  // Made, but the app did not open it: from here the button reloads, so a second try never makes a second workspace.
  const [created, setCreated] = useState(false)
  const notOpened = 'Your workspace is ready, but it did not open. Reload the page to go on.'
  // The app replaces this page once the new workspace has loaded. If that does not happen, don't hang on
  // "Opening…": the workspace exists, so the way on is a reload, not another try (that would make a second one).
  useEffect(() => {
    if (phase !== 'opening') return
    const timer = setTimeout(() => {
      setPhase('idle')
      setError(notOpened)
    }, OPENING_MS)
    return () => clearTimeout(timer)
  }, [phase])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (created) return window.location.reload()
    if (!name.trim()) return setError('Give your business a name.')
    setPhase('creating')
    setError(null)
    let made = false // state would be stale in the catch below
    try {
      await createWorkspace(name)
      made = true
      setCreated(true)
      // Stays until the app has loaded the new workspace and replaces this page.
      setPhase('opening')
      await onDone()
    } catch (err) {
      setError(made ? notOpened : err instanceof Error ? err.message : String(err))
      setPhase('idle')
    }
  }

  const form = (
    <form className={embedded ? 'auth-form' : 'auth-card'} onSubmit={submit} noValidate>
      {lostWorkspace && <LostWorkspace name={lostWorkspace} />}
      {embedded ? (
        <p>Name your business. Your assistant uses it when it answers the phone.</p>
      ) : (
        <>
          <h1>Name your business</h1>
          <p>Your assistant uses it when it answers the phone.</p>
        </>
      )}
      <label>
        Business name
        <input
          required
          value={name}
          onChange={e => setName(e.target.value)}
          autoComplete="organization"
          autoFocus
          disabled={busy}
        />
      </label>
      {error && <Note tone="danger">{error}</Note>}
      <button
        type="submit"
        className={`k-btn ${embedded ? 'k-btn-secondary' : 'k-btn-primary'}${busy ? ' is-busy' : ''}`}
        disabled={busy}
        aria-busy={busy || undefined}
      >
        {busy && <Spinner />}
        {phase === 'opening' ? 'Opening…' : busy ? 'Setting up…' : created ? 'Reload' : 'Continue'}
      </button>
      <CreatingStatus phase={phase} name={name.trim()} />
      {children}
      {!embedded && (
        <button type="button" className="auth-switch" onClick={() => void signOutAndForget().then(onDone)}>
          Use a different account
        </button>
      )}
    </form>
  )
  return embedded ? form : <AuthPage>{form}</AuthPage>
}

/** The workspace this browser had open and the member is no longer in: said first, so the page is not a surprise. */
export function LostWorkspace({ name }: { name: string }) {
  return (
    <p className="auth-lost" role="status">
      {deletedOnPurpose(name) ? (
        <>
          You deleted <b>{name}</b>. Set up a new business, or join one you are invited to.
        </>
      ) : leftOnPurpose(name) ? (
        <>
          You left <b>{name}</b>. Set up your own business, or join one you are invited to.
        </>
      ) : (
        <>
          You no longer have access to <b>{name}</b>. Ask its owner to invite you again, or set up your own business.
        </>
      )}
    </p>
  )
}
