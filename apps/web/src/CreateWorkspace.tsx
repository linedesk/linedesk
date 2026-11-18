import { T, useT } from '@linedesk/i18n/react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { SecondFactorPrompt } from './admin/SecondFactorPrompt.tsx'
import { type AdminSecondFactor, createWorkspace, fetchMe, type Me } from './auth.ts'
import { useCountryHint } from './countryHint.ts'
import { type CreatingPhase, CreatingStatus } from './CreatingStatus.tsx'
import { CountrySelect } from './settings/CountrySelect.tsx'
import { signOutAndForget } from './localData.ts'
import { deletedOnPurpose, leftOnPurpose } from './session.ts'
import { Note, Spinner } from './ui/kit.tsx'
import { SignedInAuthPage } from './shell/SignedInAuthPage.tsx'

/** How long "Opening…" may last before the page says to reload. */
const OPENING_MS = 15_000

/**
 * After POST /v1/workspaces refused: the passkey check this server admin's session still has to pass (the API's 403
 * `admin_second_factor`, "Confirm it is you first"), or null when the refusal had another reason. Read from /v1/me,
 * which says the same thing the server decided on.
 */
export async function secondFactorDue(loadMe: () => Promise<Me | null> = fetchMe): Promise<AdminSecondFactor | null> {
  return (await loadMe().catch(() => null))?.adminSecondFactor ?? null
}

/**
 * First sign-in: name the business. Creates the workspace and its assistant. `lostWorkspace`: the
 * workspace this browser had open, which the member was removed from; said first, so the form is not
 * a surprise. `children`: shown under the form (invitations, Admin). `embedded`: only the form, as the secondary way
 * on a server admin's start page (NoWorkspace.tsx, AdminStart): no page around it, its button not the primary one.
 * `onSecondFactor`: creating was refused until the passkey check (the session's 12 hours ran out meanwhile); the page
 * around opens the passkey prompt. Without it, this page shows the prompt itself instead of an error line.
 */
export function CreateWorkspace({
  onDone,
  lostWorkspace = null,
  children,
  embedded = false,
  onSecondFactor,
}: {
  onDone: () => void | Promise<void>
  lostWorkspace?: string | null
  children?: ReactNode
  embedded?: boolean
  onSecondFactor?: (state: AdminSecondFactor) => void
}) {
  const t = useT()
  const [name, setName] = useState('')
  // Where the business is: the country hint until picked (countryHint.ts). Saved as set only when picked.
  const hint = useCountryHint()
  const [picked, setPicked] = useState<string | null>(null)
  const country = picked ?? hint?.country ?? ''
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<CreatingPhase>('idle')
  const busy = phase !== 'idle'
  // Made, but the app did not open it: from here the button reloads, so a second try never makes a second workspace.
  const [created, setCreated] = useState(false)
  const [secondFactor, setSecondFactor] = useState<AdminSecondFactor | null>(null)
  const notOpened = t('auth.create.notOpened')
  // The app replaces this page once the new workspace has loaded. If that does not happen, don't hang on
  // "Opening…": the workspace exists, so the way on is a reload, not another try (that would make a second one).
  useEffect(() => {
    if (phase !== 'opening') return
    const timer = setTimeout(() => {
      setPhase('idle')
      setError(t('auth.create.notOpened'))
    }, OPENING_MS)
    return () => clearTimeout(timer)
  }, [phase, t])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (created) return window.location.reload()
    if (!name.trim()) return setError(t('auth.create.nameMissing'))
    if (!country) return setError(t('shell.newWorkspace.countryMissing'))
    setPhase('creating')
    setError(null)
    let made = false // state would be stale in the catch below
    try {
      await createWorkspace(name, picked)
      made = true
      setCreated(true)
      // Stays until the app has loaded the new workspace and replaces this page.
      setPhase('opening')
      await onDone()
    } catch (err) {
      const due = made ? null : await secondFactorDue()
      setPhase('idle')
      if (due) {
        if (onSecondFactor) onSecondFactor(due)
        else setSecondFactor(due)
        return
      }
      setError(made ? notOpened : err instanceof Error ? err.message : String(err))
    }
  }

  if (secondFactor) return <SecondFactorPrompt state={secondFactor} onExit={() => setSecondFactor(null)} />

  const form = (
    <form className={embedded ? 'auth-form' : 'auth-card'} onSubmit={submit} noValidate>
      {lostWorkspace && <LostWorkspace name={lostWorkspace} />}
      {embedded ? (
        <p>{t('auth.create.intro')}</p>
      ) : (
        <>
          <h1>{t('auth.create.title')}</h1>
          <p>{t('auth.create.text')}</p>
        </>
      )}
      <label>
        {t('shell.newWorkspace.name')}
        <input
          required
          value={name}
          onChange={e => setName(e.target.value)}
          autoComplete="organization"
          autoFocus
          disabled={busy}
        />
      </label>
      <div className="auth-field">
        <label htmlFor="create-ws-country">{t('settings.general.country.label')}</label>
        <CountrySelect id="create-ws-country" value={country} onChange={setPicked} disabled={busy} />
      </div>
      {error && <Note tone="danger">{error}</Note>}
      <button
        type="submit"
        className={`k-btn ${embedded ? 'k-btn-secondary' : 'k-btn-primary'}${busy ? ' is-busy' : ''}`}
        disabled={busy}
        aria-busy={busy || undefined}
      >
        {busy && <Spinner />}
        {phase === 'opening'
          ? t('shell.newWorkspace.opening')
          : busy
            ? t('auth.setup.busy')
            : created
              ? t('shell.tabNotice.reload')
              : t('shell.tabNotice.continue')}
      </button>
      <CreatingStatus phase={phase} name={name.trim()} />
      {children}
      {!embedded && (
        <button type="button" className="auth-switch" onClick={() => void signOutAndForget().then(onDone)}>
          {t('auth.differentAccount')}
        </button>
      )}
    </form>
  )
  return embedded ? form : <SignedInAuthPage>{form}</SignedInAuthPage>
}

/** The workspace this browser had open and the member is no longer in: said first, so the page is not a surprise. */
export function LostWorkspace({ name }: { name: string }) {
  return (
    <p className="auth-lost" role="status">
      {deletedOnPurpose(name) ? (
        <T k="auth.lost.deletedLong" values={{ workspace: name, b: chunks => <b>{chunks}</b> }} />
      ) : leftOnPurpose(name) ? (
        <T k="auth.lost.leftLong" values={{ workspace: name, b: chunks => <b>{chunks}</b> }} />
      ) : (
        <T k="auth.lost.noAccessLong" values={{ workspace: name, b: chunks => <b>{chunks}</b> }} />
      )}
    </p>
  )
}
