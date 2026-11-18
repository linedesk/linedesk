// Shown instead of Server admin (and the setup pages that are part of it) until the session passed the passkey check
// (docs/architecture.md §12, apps/api/src/admin-second-factor.ts). An instance admin signs in with any method and uses
// their workspaces; opening Server admin asks for the passkey once, and that counts for 12 hours in this browser
// (server-side, bound to the session). No email code, password or provider sign-in counts for it.
// - `confirm`: one button, the passkey sign-in of this account (confirmWithPasskey: never another account's).
// - `enrol`: no passkey yet: the enrolment code (from the first-run setup, the server or another admin), add the
//   passkey, then confirm with it once.
// - `email`: the address is not confirmed yet (adding a passkey needs it): the sign-in with an email code confirms it.
// The page loads again afterwards at the same address, so it returns to the same admin page. Only a passkey sign-in the
// device verified (fingerprint, face or PIN) counts; one that did not says so here instead of loading again.
// Ending the admin's own agent setup links needs no passkey check (setupLink:end): offered here too, e.g. when a link
// leaked and the passkey is not at hand.
// The fallback to the passkey is the admin's authenticator app (LIN-275), for an emergency or a computer without the
// passkey: `confirm` offers it below the passkey button when the account has one. The passkey stays required (`enrol`
// never offers the app). After a check with the app the page offers to add a passkey on this computer.

import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { type AdminSecondFactor, fetchMe, passkeySupported } from '../auth.ts'
import { checkAuthenticator } from '../authenticator-api.ts'
import { brandName } from '../brand.ts'
import { readEnrolmentCode } from '../enrolment-code.ts'
import { i18n } from '../i18n/index.tsx'
import { Login } from '../Login.tsx'
import { signInAgain } from '../localData.ts'
import { addPasskeyForThisDevice, confirmWithPasskey, SignInAgain } from '../settings/account/account-api.ts'
import { passkeyAddCancelled } from '../settings/account/add-passkey.ts'
import { AUTHENTICATOR_HOURS, authenticatorErrorText } from '../settings/account/authenticator.tsx'
import { passkeyNotVerifiedText } from '../sign-in-code.ts'
import { AuthError } from '../ui/AuthError.tsx'
import { cx, Spinner } from '../ui/kit.tsx'
import { SignedInAuthPage } from '../shell/SignedInAuthPage.tsx'
import { NO_PASSWORD_MANAGER } from '../ui/passwordManager.ts'
import { runAdminOnce } from './api.ts'

type Props = { state: AdminSecondFactor; onExit: () => void }

/** How long the passkey check counts (apps/api/src/admin-second-factor.ts ADMIN_PASSKEY_HOURS). */
export const ADMIN_PASSKEY_HOURS = 12

/** The server command that prints a one-time enrolment code; said on the page and in its tests. */
export const enrolmentCommand = () =>
  `docker compose exec api node apps/api/src/user-passkeys.ts --enrol --email <${i18n().t('admin.secondFactor.yourEmail')}>`

/** The page's title and why, per state. */
function textOf(state: Exclude<AdminSecondFactor, 'email'>): { title: string; why: string } {
  const { t } = i18n()
  return state === 'confirm'
    ? {
        title: t('admin.stepUp.confirm.title'),
        why: t('admin.secondFactor.confirm.why', { hours: ADMIN_PASSKEY_HOURS }),
      }
    : { title: t('admin.secondFactor.enrol.title'), why: t('admin.secondFactor.enrol.why') }
}

/**
 * The button that opens this prompt from elsewhere (the start page by hand, New workspace): for `email` the next step
 * is confirming the address, not the passkey. Read when shown, in the active language.
 */
export const SECOND_FACTOR_BUTTON: Readonly<Record<AdminSecondFactor, string>> = {
  get email() {
    return i18n().t('admin.secondFactor.button.email')
  },
  get enrol() {
    return i18n().t('admin.secondFactor.button.enrol')
  },
  get confirm() {
    return i18n().t('admin.stepUp.confirm.title')
  },
}

/** A passkey sign-in that did not count for Server admin: the device did not check the person. */
export const passkeyNotVerifiedForAdmin = () =>
  i18n().t('admin.secondFactor.notVerified', { command: 'user-passkeys.ts --remove' })

/** The new session (or passkey) is in: load the app again at this address. The form stays busy until then. */
const reload = async () => {
  window.location.reload()
  await new Promise(() => {})
}

export function SecondFactorPrompt({ state, onExit }: Props) {
  const t = useT()
  const [hasAuthenticator, setHasAuthenticator] = useState(false)
  // The app's account data is loaded once: after confirming in another tab, ask again on the way in.
  useEffect(() => {
    let current = true
    void fetchMe().then(me => {
      if (current && me && (me.adminSecondFactor ?? null) !== state) window.location.reload()
      if (current && me) setHasAuthenticator(me.hasAuthenticator === true)
    })
    return () => {
      current = false
    }
  }, [state])

  if (state === 'email')
    return (
      <Login
        reauth={{
          title: t('admin.secondFactor.email.title'),
          why: t('admin.secondFactor.email.why'),
          onBack: onExit,
        }}
        onDone={reload}
      />
    )
  return <PasskeyGate state={state} onExit={onExit} hasAuthenticator={hasAuthenticator} />
}

type Busy = 'add' | 'confirm' | null

type GateProps = { state: 'confirm' | 'enrol'; onExit: () => void; hasAuthenticator: boolean }

function PasskeyGate({ state, onExit, hasAuthenticator }: GateProps) {
  const t = useT()
  // `app`: confirm with a code from the authenticator app; `addHere`: after that, offer a passkey on this computer.
  const [mode, setMode] = useState<'passkey' | 'app' | 'addHere'>('passkey')
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  // The first admin's code came back with the first-run setup (enrolment-code.ts): filled in already.
  const [code, setCode] = useState(() => readEnrolmentCode() ?? '')
  // Added here, but the confirmation was cancelled or failed: only the confirm button is left.
  const [added, setAdded] = useState(false)
  const supported = passkeySupported()
  const enrol = state === 'enrol' && !added

  const confirm = async () => {
    setBusy('confirm')
    setError(null)
    try {
      await confirmWithPasskey()
      // Signed in with the passkey, but Server admin still asks: the device did not verify the person.
      if ((await fetchMe())?.adminSecondFactor === 'confirm') {
        setError(passkeyNotVerifiedForAdmin())
        setBusy(null)
        return
      }
      await reload()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message === passkeyNotVerifiedText() ? passkeyNotVerifiedForAdmin() : message)
      setBusy(null)
    }
  }
  const addThenConfirm = async () => {
    if (!code.trim()) return setError(t('admin.secondFactor.codeFirst'))
    setBusy('add')
    setError(null)
    setNeedsSignIn(false)
    try {
      await addPasskeyForThisDevice(code)
      setAdded(true)
    } catch (e) {
      // A sign-in older than a day may not add a passkey (Better Auth's fresh age): sign in again, then come back.
      setNeedsSignIn(e instanceof SignInAgain)
      setError(passkeyAddCancelled(e) ? t('admin.secondFactor.notAdded') : String((e as Error).message ?? e))
      setBusy(null)
      return
    }
    // One sign-in with the new passkey is the check itself.
    await confirm()
  }

  const text = textOf(state === 'enrol' && added ? 'confirm' : state)
  // Without passkey support here (no https) the app is the only way in, so it shows at once.
  const appMode = mode === 'app' || (hasAuthenticator && state === 'confirm' && !supported && mode === 'passkey')
  if (mode === 'addHere') return <AddPasskeyHere />
  if (appMode)
    return (
      <SignedInAuthPage>
        <div className="auth-card" role="main" aria-label={t('account.authenticator.title')}>
          <h1>{t('account.authenticator.title')}</h1>
          <p className="auth-why">{t('account.authenticator.checkWhy', { hours: AUTHENTICATOR_HOURS })}</p>
          <AuthenticatorCode
            submitLabel={t('account.authenticator.check')}
            submitTitle={t('account.authenticator.checkTitle')}
            onSubmit={async code => {
              await checkAuthenticator(code)
              // Checked: Server admin is open. A passkey on this computer makes the app unnecessary next time.
              if (supported) setMode('addHere')
              else await reload()
            }}
          />
          {supported && (
            <button
              type="button"
              className="auth-switch"
              title={t('account.authenticator.usePasskeyTitle')}
              onClick={() => setMode('passkey')}
            >
              {t('account.authenticator.usePasskey')}
            </button>
          )}
          <EndAgentAccess />
          <button type="button" className="auth-switch" title={t('account.authenticator.backTitle')} onClick={onExit}>
            {t('account.authenticator.back')}
          </button>
        </div>
      </SignedInAuthPage>
    )
  return (
    <SignedInAuthPage>
      <div className="auth-card" role="main" aria-label={text.title}>
        <h1>{text.title}</h1>
        <p className="auth-why">{text.why}</p>
        {!supported && <AuthError message={t('admin.stepUp.httpsNeeded', { brand: brandName() })} />}
        {enrol && supported && (
          <form
            className="auth-form"
            noValidate
            onSubmit={e => {
              e.preventDefault()
              void addThenConfirm()
            }}
          >
            <p className="auth-hint">
              {t('admin.secondFactor.enrolmentWhere')} <code className="auth-command">{enrolmentCommand()}</code>
            </p>
            <input
              aria-label={t('admin.secondFactor.codeLabel')}
              placeholder={t('admin.secondFactor.codeLabel')}
              value={code}
              onChange={e => setCode(e.target.value)}
              // From the server's enrolment command, not a code by SMS or email: no one-time-code suggestions.
              {...NO_PASSWORD_MANAGER}
              autoFocus={!code}
              disabled={busy !== null}
            />
            {error && <AuthError message={error} />}
            {needsSignIn ? (
              <button type="button" className="k-btn k-btn-primary" onClick={() => void signInAgain()}>
                {t('admin.secondFactor.signInAgain')}
              </button>
            ) : (
              <button
                type="submit"
                className={cx('k-btn k-btn-primary', busy && 'is-busy')}
                disabled={busy !== null || !code.trim()}
                aria-busy={busy !== null || undefined}
                title={t('admin.secondFactor.addTip')}
              >
                {busy && <Spinner />}
                {busy ? t('admin.stepUp.waiting') : t('admin.secondFactor.add')}
              </button>
            )}
          </form>
        )}
        {!enrol && supported && (
          <>
            {error && <AuthError message={error} />}
            <button
              type="button"
              className={cx('k-btn k-btn-primary', busy && 'is-busy')}
              disabled={busy !== null}
              aria-busy={busy !== null || undefined}
              autoFocus
              title={t('admin.stepUp.confirm.tip')}
              onClick={() => void confirm()}
            >
              {busy && <Spinner />}
              {busy ? t('admin.stepUp.waiting') : t('admin.stepUp.confirm.button')}
            </button>
          </>
        )}
        {!enrol && hasAuthenticator && (
          <button
            type="button"
            className="auth-switch"
            title={t('account.authenticator.useTitle')}
            onClick={() => setMode('app')}
          >
            {t('account.authenticator.use')}
          </button>
        )}
        <EndAgentAccess />
        <button type="button" className="auth-switch" title={t('admin.secondFactor.backTip')} onClick={onExit}>
          {t('admin.secondFactor.back')}
        </button>
      </div>
    </SignedInAuthPage>
  )
}

/** The 6-digit code from the authenticator app, with its button; `onSubmit` throws in the app's words. */
function AuthenticatorCode({
  submitLabel,
  submitTitle,
  onSubmit,
}: {
  submitLabel: string
  submitTitle: string
  onSubmit: (code: string) => Promise<void>
}) {
  const t = useT()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value.trim())
    } catch (e) {
      setError(authenticatorErrorText(e, t))
      setBusy(false)
    }
  }
  return (
    <form
      className="auth-form"
      noValidate
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      <input
        aria-label={t('account.authenticator.code')}
        placeholder={t('account.authenticator.codePlaceholder')}
        value={value}
        onChange={e => setValue(e.target.value)}
        name="totp"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        autoFocus
        disabled={busy}
      />
      {error && <AuthError message={error} />}
      <button
        type="submit"
        className={cx('k-btn k-btn-primary', busy && 'is-busy')}
        disabled={busy || value.trim().length < 6}
        aria-busy={busy || undefined}
        title={submitTitle}
      >
        {busy && <Spinner />}
        {submitLabel}
      </button>
    </form>
  )
}

/**
 * After a check with the authenticator app: Server admin is open, and this computer had no passkey at hand. Offers to
 * add one here (the checked session may, without a code); Not now goes on to Server admin.
 */
function AddPasskeyHere() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      await addPasskeyForThisDevice()
      await reload()
    } catch (e) {
      setError(passkeyAddCancelled(e) ? t('account.authenticator.addHereCancelled') : String((e as Error).message ?? e))
      setBusy(false)
    }
  }
  return (
    <SignedInAuthPage>
      <div className="auth-card" role="main" aria-label={t('account.authenticator.addHereTitle')}>
        <h1>{t('account.authenticator.addHereTitle')}</h1>
        <p className="auth-why">{t('account.authenticator.addHereWhy')}</p>
        {error && <AuthError message={error} />}
        <button
          type="button"
          className={cx('k-btn k-btn-primary', busy && 'is-busy')}
          disabled={busy}
          aria-busy={busy || undefined}
          autoFocus
          title={t('account.authenticator.addHereButtonTitle')}
          onClick={() => void add()}
        >
          {busy && <Spinner />}
          {busy ? t('account.passkeys.waiting') : t('account.passkeys.add')}
        </button>
        <button
          type="button"
          className="auth-switch"
          title={t('account.authenticator.notNowTitle')}
          disabled={busy}
          onClick={() => void reload()}
        >
          {t('account.authenticator.notNow')}
        </button>
      </div>
    </SignedInAuthPage>
  )
}

/** Ends the admin's own agent setup links without the passkey check (agentSetup.revoke, setupLink:end). */
function EndAgentAccess() {
  const t = useT()
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'none' | 'failed'>('idle')
  const end = async () => {
    setState('busy')
    try {
      const { ended } = (await runAdminOnce('agentSetup.revoke', {})) as { ended?: number }
      setState(ended ? 'done' : 'none')
    } catch {
      setState('failed')
    }
  }
  if (state === 'done') return <p className="auth-note">{t('admin.secondFactor.agent.ended')}</p>
  if (state === 'none') return <p className="auth-note">{t('admin.secondFactor.agent.none')}</p>
  return (
    <>
      {state === 'failed' && <AuthError message={t('admin.secondFactor.agent.failed')} />}
      <button
        type="button"
        className="auth-switch"
        disabled={state === 'busy'}
        title={t('admin.secondFactor.agent.tip')}
        onClick={() => void end()}
      >
        {t('admin.secondFactor.agent.end')}
      </button>
    </>
  )
}
