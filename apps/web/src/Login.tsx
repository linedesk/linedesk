// Sign-in. Shows what this install offers (GET /v1/auth-methods): email first (a code sent by email),
// then the sign-in providers, and a password under "Show other options". New people are signed up on
// first sign-in, unless sign-up is closed. "Forgot password?" sets a new one with an emailed code.
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { type AuthMethods, auth, completeSetup, type LegalLinks, passkeySupported, type SsoMethod, fetchAuthMethods, requestPasswordResetCode, requestSignInCode, resetPasswordWithCode, signInWithCode, signInWithPasskey, startSso, takeRedirectError, lostSignInState, providerElsewhereMessage, providerSignInElsewhere } from './auth.ts'
import { authErrorMessage, authFormError, CODE_LENGTH, codeErrorMessage, emailError, newPasswordError, normalizeCode, passwordResetOffer, RESEND_AFTER_S, resetErrorMessage } from './sign-in-code.ts'
import { readLastUsedMethod, rememberSignInMethod } from './sign-in-methods.ts'
import { useQuery } from './cachedQuery.ts'
import { LastUsed, ProviderButton } from './ui/brand-logos.tsx'
import { AuthError } from './ui/AuthError.tsx'
import { HelpTip, type HelpTipContent } from './ui/HelpTip.tsx'
import { AuthPage, cx, Spinner } from './ui/kit.tsx'
import { brandName } from './brand.ts'
import { readDeleted } from './session.ts'

type Step = 'start' | 'code' | 'password' | 'reset'
type Intent = 'signIn' | 'signUp'
type Result = { error: { message?: string; code?: string; status?: number } | null }

/** Keeps trying while the server is unreachable (a restart), so the page recovers by itself. */
const loadAuthMethods = () => fetchAuthMethods()

const fail = (res: Result) => {
  if (res.error) throw res.error
}

/** Signing in again for a place that asks for a recent sign-in (the admin area): why, and the way back. */
export type Reauth = { title: string; why: string; onBack: () => void }

/**
 * `onDone` resolves once the app has loaded the account, so the form keeps its busy state until the app replaces it.
 * With `reauth`, the same methods sign a signed-in member in again; no sign-up and no switch to it.
 */
export function Login({ onDone, reauth }: { onDone: () => Promise<void>; reauth?: Reauth }) {
  // What this install offers: the last known at once (kept across visits), checked again in the background.
  const methods = useQuery('auth-methods', loadAuthMethods, { persist: true }).data ?? null
  const [step, setStep] = useState<Step>('start')
  const [intent, setIntent] = useState<Intent>('signIn')
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  // A failed provider sign-in comes back with ?error=CODE: read once, then shown like any other error.
  const [redirectError] = useState(takeRedirectError)
  const [error, setError] = useState<string | null>(redirectError?.message ?? null)
  // An owner who deleted their workspace and, with it, their own account lands here: say so (until this tab opens
  // a workspace again, Workspace.tsx).
  const [deleted] = useState(() => (reauth ? null : readDeleted()))
  // `busy` is what is running ('email', 'password', a provider id); it stays set after a success that leaves this page.
  const [busy, setBusy] = useState<string | null>(null)
  const [lastUsed] = useState(readLastUsedMethod)
  const [otherOptions, setOtherOptions] = useState(lastUsed === 'password')
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))

  /** Runs one sign-in attempt; `leaves` is true when success hands over to another page (no flash of the form). */
  async function attempt(what: string, action: () => Promise<boolean>) {
    setBusy(what)
    setError(null)
    try {
      if (await action()) return
    } catch (err) {
      setError(authErrorMessage(err))
    }
    setBusy(null)
  }

  const go = (to: Step) => {
    setStep(to)
    setError(null)
  }

  function sendCode(e: FormEvent) {
    e.preventDefault()
    const invalid = authFormError('email', form)
    if (invalid) return setError(invalid)
    void attempt('email', async () => {
      fail(await requestSignInCode(form.email))
      go('code')
      return false
    })
  }

  function signInWithPassword(e: FormEvent) {
    e.preventDefault()
    const invalid = authFormError(intent === 'signUp' ? 'signUp' : 'password', form)
    if (invalid) return setError(invalid)
    void attempt('password', async () => {
      if (intent === 'signUp') fail(await auth.signUp.email({ name: form.name, email: form.email, password: form.password }))
      else fail(await auth.signIn.email({ email: form.email, password: form.password }))
      rememberSignInMethod('password')
      await onDone()
      return true
    })
  }

  function continueWith(method: SsoMethod) {
    void attempt(method.id, async () => {
      rememberSignInMethod(method.id)
      fail(await startSso(method))
      return true
    })
  }

  function continueWithPasskey() {
    void attempt('passkey', async () => {
      fail(await signInWithPasskey())
      rememberSignInMethod('passkey')
      await onDone()
      return true
    })
  }

  if (!methods) return <AuthPage>{error ? <AuthError message={error} /> : <p className="auth-wait">Connecting…</p>}</AuthPage>

  if (methods.setupNeeded && !reauth) return <SetupStep onDone={onDone} />

  if (step === 'code') {
    return <CodeStep email={form.email} onDone={onDone} onDifferentEmail={() => go('start')} />
  }

  if (step === 'reset') {
    return <ResetStep initialEmail={form.email} onDone={onDone} onBack={() => go('password')} />
  }

  const title = reauth ? reauth.title : intent === 'signUp' ? `Create your ${brandName()} account` : `Sign in to ${brandName()}`
  const errorLine = error && <AuthError message={error} />
  // Without email codes the password is the main form, not one of the other options.
  const passwordFirst = methods.password && !methods.emailCode
  const intro = reauth && <p>{reauth.why}</p>
  // Signing in again: a way back instead of the switch to creating an account.
  const footer = reauth
    ? <button type="button" className="auth-switch" title="Back to where you were" onClick={reauth.onBack}>Back</button>
    : <AuthFooter methods={methods} intent={intent} onIntent={setIntent} />
  // Not while signing in again: a reset ends every session, the one being confirmed too.
  const resetOffer = intent === 'signIn' && !reauth ? passwordResetOffer(methods) : null
  const forgotPassword = resetOffer === 'reset'
    ? <button type="button" className="auth-switch" onClick={() => go('reset')}>Forgot password?</button>
    : resetOffer === 'ask-admin' && <p className="auth-note">Forgot your password? Ask your administrator.</p>
  const passwordForm = (
    <PasswordForm intent={intent} form={form} set={set} busy={busy === 'password'} disabled={busy !== null} error={errorLine}
      autoFocus={step === 'password'} onSubmit={signInWithPassword} />
  )

  if (step === 'password') {
    return (
      <AuthPage>
        <div className="auth-card">
          <h1>{title}</h1>
          {intro}
          {passwordForm}
          {forgotPassword}
          <button type="button" className="auth-switch" onClick={() => go('start')}>
            {intent === 'signIn' ? 'Other ways to sign in' : 'Other ways to sign up'}
          </button>
          {footer}
        </div>
      </AuthPage>
    )
  }

  // Provider sign-ins started at this address cannot finish here: say where they work, with a link.
  const elsewhere = methods.sso.length ? providerSignInElsewhere(methods) : null
  const lostHere = Boolean(elsewhere && error && error === redirectError?.message && lostSignInState(redirectError?.code))
  const errorPanel = (id?: string) =>
    lostHere && elsewhere ? (
      <AuthError id={id} message={providerElsewhereMessage(elsewhere.host)} link={{ href: elsewhere.href, label: `Open ${elsewhere.host}` }} />
    ) : (
      error && <AuthError id={id} message={error} />
    )
  const withPasskey = methods.passkey && passkeySupported()
  const passkeyButton = withPasskey && (
    <ProviderButton method="passkey" label="Passkey" lastUsed={lastUsed === 'passkey'} busy={busy === 'passkey'} busyText="Signing in…"
      disabled={busy !== null} onClick={continueWithPasskey} />
  )
  const hasOtherOptions = methods.password && methods.emailCode
  // A passkey alone is no way in: it is added after signing in some other way.
  const nothing = !methods.emailCode && !methods.password && methods.sso.length === 0
  return (
    <AuthPage>
      <div className="auth-card">
        <h1>{title}</h1>
        {intro}
        {deleted?.accountDeleted && (
          <p className="auth-lost" role="status">
            Workspace and account deleted.
          </p>
        )}
        {/* Signing in again: the passkey first, the way that also counts longest (12 hours). */}
        {reauth && passkeyButton}
        {reauth && passkeyButton && (methods.emailCode || methods.password || methods.sso.length > 0) && <hr className="auth-separator" />}
        {methods.emailCode && (
          <form className="auth-form" onSubmit={sendCode} noValidate>
            <input type="email" aria-label="Email" placeholder="Email address" value={form.email} onChange={set('email')} autoComplete="email" autoFocus
              aria-describedby={error ? 'auth-error' : undefined} />
            <button type="submit" className={cx('k-btn k-btn-primary auth-provider', busy === 'email' && 'is-busy')} disabled={busy !== null}
              aria-busy={busy === 'email' || undefined}>
              {busy === 'email' && <Spinner />}
              <span>{busy === 'email' ? 'Sending…' : 'Continue with Email'}</span>
              {lastUsed === 'email' && <LastUsed />}
            </button>
            {errorPanel('auth-error')}
          </form>
        )}
        {passwordFirst && passwordForm}
        {passwordFirst && forgotPassword}
        {(methods.emailCode || passwordFirst) && (methods.sso.length > 0 || (withPasskey && !reauth)) && <hr className="auth-separator" />}
        {!methods.emailCode && !passwordFirst && errorPanel()}
        {nothing && <AuthError message="No sign-in method is set up on this server. Ask your administrator to turn one on." />}
        {methods.sso.map(m => (
          <ProviderButton key={m.id} method={m.id} label={m.label} lastUsed={lastUsed === m.id} busy={busy === m.id}
            disabled={busy !== null} onClick={() => continueWith(m)} />
        ))}
        {elsewhere && !lostHere && (
          <p className="auth-hint">
            Google, Microsoft and GitHub sign in at <a href={elsewhere.href}>{elsewhere.host}</a>.
          </p>
        )}
        {!reauth && passkeyButton}
        {hasOtherOptions && (otherOptions
          ? <ProviderButton method="password" label="Password" lastUsed={lastUsed === 'password'} disabled={busy !== null} onClick={() => go('password')} />
          : <button type="button" className="auth-switch auth-more" onClick={() => setOtherOptions(true)}>Show other options</button>)}
        {footer}
      </div>
    </AuthPage>
  )
}

type PasswordFormProps = {
  intent: Intent; form: { name: string; email: string; password: string }
  set: (key: 'name' | 'email' | 'password') => (e: { target: { value: string } }) => void
  busy: boolean; disabled: boolean; error: ReactNode; autoFocus: boolean; onSubmit: (e: FormEvent) => void
}

/** Email and password (and a name when creating an account). */
function PasswordForm({ intent, form, set, busy, disabled, error, autoFocus, onSubmit }: PasswordFormProps) {
  const signUp = intent === 'signUp'
  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      {signUp && <input aria-label="Your name" placeholder="Your name" value={form.name} onChange={set('name')} autoComplete="name" autoFocus={autoFocus} />}
      <input type="email" aria-label="Email" placeholder="Email address" value={form.email} onChange={set('email')} autoComplete="email" autoFocus={autoFocus && !signUp} />
      <input type="password" aria-label="Password" placeholder="Password" value={form.password} onChange={set('password')}
        autoComplete={signUp ? 'new-password' : 'current-password'} />
      <button type="submit" className="k-btn k-btn-primary" disabled={disabled}>
        {signUp ? (busy ? 'Creating account…' : 'Create account') : busy ? 'Signing in…' : 'Sign in'}
      </button>
      {error}
    </form>
  )
}

/** Who can get an account, then Terms · Privacy · Help, each only when this install set it. */
function AuthFooter({ methods, intent, onIntent }: { methods: AuthMethods; intent: Intent; onIntent: (i: Intent) => void }) {
  const switchTo = (to: Intent, question: string, action: string) => (
    <p className="auth-note">{question} <button type="button" className="auth-inline" onClick={() => onIntent(to)}>{action}</button></p>
  )
  return (
    <footer className="auth-footer">
      {methods.signUp === false ? (
        <p className="auth-note">
          Ask your administrator for an account.
          {methods.links.supportEmail && <> Or write to <a className="k-link" href={`mailto:${methods.links.supportEmail}`}>{methods.links.supportEmail}</a>.</>}
        </p>
      ) : intent === 'signIn'
        ? switchTo('signUp', "Don't have an account?", 'Sign up')
        : switchTo('signIn', 'Already have an account?', 'Sign in')}
      <LegalLinksLine links={methods.links} />
    </footer>
  )
}

function LegalLinksLine({ links }: { links: LegalLinks }) {
  const items = [
    links.terms && <a key="terms" href={links.terms} target="_blank" rel="noreferrer">Terms</a>,
    links.privacy && <a key="privacy" href={links.privacy} target="_blank" rel="noreferrer">Privacy</a>,
    links.supportEmail && <a key="help" href={`mailto:${links.supportEmail}`}>Help</a>,
  ].filter(Boolean)
  if (!items.length) return null
  return <nav className="auth-legal" aria-label="Legal and help">{items}</nav>
}

type CodeStepProps = { email: string; onDone: () => Promise<void>; onDifferentEmail: () => void }

/** One field for the six digits: typing, pasting the whole code or the OS's one-time-code fill all work; the sixth digit submits. */
export function CodeStep({ email, onDone, onDifferentEmail }: CodeStepProps) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [waitS, setWaitS] = useState(RESEND_AFTER_S)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (waitS <= 0) return
    const timer = setTimeout(() => setWaitS(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [waitS])

  async function check(value: string) {
    setBusy(true)
    setError(null)
    const res = await signInWithCode(email, value).catch(error => ({ error }))
    if (!res.error) {
      // Stay on "Signing in…" until the app has the account and replaces this page: no flash of the form.
      setSignedIn(true)
      rememberSignInMethod('email')
      return onDone()
    }
    setBusy(false)
    setError(codeErrorMessage(res.error))
    setCode('')
    input.current?.focus()
  }

  function change(value: string) {
    const digits = normalizeCode(value)
    setCode(digits)
    if (digits.length === CODE_LENGTH && !busy) void check(digits)
  }

  async function resend() {
    setError(null)
    setCode('')
    setWaitS(RESEND_AFTER_S)
    const res = await requestSignInCode(email).catch(error => ({ error }))
    if (res.error) setError(authErrorMessage(res.error))
    input.current?.focus()
  }

  return (
    <AuthPage>
      <form className="auth-card" noValidate onSubmit={e => { e.preventDefault(); if (code.length === CODE_LENGTH) void check(code) }}>
        <h1>Check your email</h1>
        {/* The same words for every address: whether it may sign in here is not told (no account enumeration). */}
        <p>
          If {email} can sign in here, a {CODE_LENGTH}-digit code is on its way. It expires in 10 minutes.
        </p>
        <input ref={input} className="auth-code" aria-label="Sign-in code" value={code} onChange={e => change(e.target.value)} disabled={busy}
          inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={CODE_LENGTH + 6} autoFocus
          aria-describedby={error ? 'code-error' : undefined} />
        {error && <AuthError message={error} id="code-error" />}
        <button type="submit" className={cx('k-btn k-btn-primary', (busy || signedIn) && 'is-busy')}
          disabled={busy || code.length < CODE_LENGTH} aria-busy={busy || signedIn || undefined}>
          {(busy || signedIn) && <Spinner />}
          {signedIn ? 'Signing in…' : busy ? 'Checking…' : 'Sign in'}
        </button>
        {waitS > 0
          ? <p className="auth-note">You can ask for a new code in {waitS} s.</p>
          : <button type="button" className="auth-switch" onClick={() => void resend()}>Resend code</button>}
        <button type="button" className="auth-switch" onClick={onDifferentEmail}>Use a different email</button>
      </form>
    </AuthPage>
  )
}

type ResetStepProps = { initialEmail: string; onDone: () => Promise<void>; onBack: () => void }

/**
 * "Forgot password?": the email, then the emailed code and a new password. The server ends every
 * session of the account; this browser then signs in with the new password.
 */
function ResetStep({ initialEmail, onDone, onBack }: ResetStepProps) {
  const [email, setEmail] = useState(initialEmail)
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'send' | 'reset' | 'signIn' | null>(null)
  const [waitS, setWaitS] = useState(0)

  useEffect(() => {
    if (waitS <= 0) return
    const timer = setTimeout(() => setWaitS(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [waitS])

  async function send(e?: FormEvent) {
    e?.preventDefault()
    const invalid = emailError(email)
    if (invalid) return setError(invalid)
    setBusy('send')
    setError(null)
    const res = await requestPasswordResetCode(email.trim()).catch(error => ({ error }))
    setBusy(null)
    if (res.error) return setError(authErrorMessage(res.error))
    setSent(true)
    setCode('')
    setWaitS(RESEND_AFTER_S)
  }

  async function reset(e: FormEvent) {
    e.preventDefault()
    if (code.length < CODE_LENGTH) return setError(`Enter the ${CODE_LENGTH}-digit code from the email.`)
    const invalid = newPasswordError(password)
    if (invalid) return setError(invalid)
    setBusy('reset')
    setError(null)
    const res = await resetPasswordWithCode(email.trim(), code, password).catch(error => ({ error }))
    if (res.error) {
      setBusy(null)
      return setError(resetErrorMessage(res.error))
    }
    // The password is set; sign in with it. Stay busy until the app replaces this page.
    setBusy('signIn')
    const signedIn = await auth.signIn.email({ email: email.trim(), password }).catch(error => ({ error }))
    if (signedIn.error) {
      setBusy(null)
      return setError('Your password is changed, but signing in did not work. Go back to sign in and use your new password.')
    }
    rememberSignInMethod('password')
    await onDone()
  }

  if (!sent) {
    return (
      <AuthPage>
        <form className="auth-card" noValidate onSubmit={send}>
          <h1>Reset your password</h1>
          <p>Enter your email. We send you a code to set a new password.</p>
          <div className="auth-form">
            <input type="email" aria-label="Email" placeholder="Email address" value={email} onChange={e => setEmail(e.target.value)}
              autoComplete="email" autoFocus aria-describedby={error ? 'reset-error' : undefined} />
            <button type="submit" className={cx('k-btn k-btn-primary', busy === 'send' && 'is-busy')} disabled={busy !== null}
              aria-busy={busy === 'send' || undefined}>
              {busy === 'send' && <Spinner />}
              {busy === 'send' ? 'Sending…' : 'Send code'}
            </button>
            {error && <AuthError message={error} id="reset-error" />}
          </div>
          <button type="button" className="auth-switch" onClick={onBack}>Back to sign in</button>
        </form>
      </AuthPage>
    )
  }

  const working = busy === 'reset' || busy === 'signIn'
  return (
    <AuthPage>
      <form className="auth-card" noValidate onSubmit={reset}>
        <h1>Check your email</h1>
        {/* The same words for every address: whether it has an account here is not told (no account enumeration). */}
        <p>
          If {email.trim()} has an account here, a {CODE_LENGTH}-digit code is on its way. It expires in 10 minutes.
        </p>
        <div className="auth-form">
          <input className="auth-code" aria-label="Reset code" value={code} onChange={e => setCode(normalizeCode(e.target.value))}
            disabled={working} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={CODE_LENGTH + 6} autoFocus
            aria-describedby={error ? 'reset-error' : undefined} />
          <input type="password" aria-label="New password" placeholder="New password (at least 8 characters)" value={password}
            onChange={e => setPassword(e.target.value)} disabled={working} autoComplete="new-password" />
          <button type="submit" className={cx('k-btn k-btn-primary', working && 'is-busy')} disabled={busy !== null}
            aria-busy={working || undefined}>
            {working && <Spinner />}
            {busy === 'signIn' ? 'Signing in…' : busy === 'reset' ? 'Saving…' : 'Set new password'}
          </button>
          {error && <AuthError message={error} id="reset-error" />}
        </div>
        <p className="auth-note">This signs you out on every other device.</p>
        {waitS > 0
          ? <p className="auth-note">You can ask for a new code in {waitS} s.</p>
          : <button type="button" className="auth-switch" disabled={busy !== null} onClick={() => void send()}>Resend code</button>}
        <button type="button" className="auth-switch" onClick={() => { setSent(false); setError(null) }}>Use a different email</button>
      </form>
    </AuthPage>
  )
}

/** Where the setup code is: the API prints it at start, setup-code.ts prints it again (apps/api/src/setup.ts; docs/hosting.md). */
const SETUP_CODE_HELP: HelpTipContent = {
  text: `${brandName()} prints a one-time setup code when it starts without an admin.`,
  commands: [
    { label: "In the server's log", code: 'docker compose logs api | grep -A2 "no admin yet"' },
    { label: 'Or print it again', code: 'docker compose exec api node apps/api/src/setup-code.ts' },
    { label: 'Local development (also in the terminal running pnpm dev)', code: 'pnpm --filter @linedesk/api setup:code' },
  ],
}

/** A fresh install: the setup code from the server log makes the first admin (apps/api/src/setup.ts). */
function SetupStep({ onDone }: { onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ code: '', name: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!form.code.trim() || !form.name.trim() || !form.email.trim()) return setError('Fill in every field.')
    if (form.password.length < 12) return setError('Use a password with at least 12 characters.')
    setBusy(true)
    setError(null)
    try {
      const result = await completeSetup(form)
      if (result.signedIn === false) return window.location.reload()
      await onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <AuthPage>
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1>Set up {brandName()}</h1>
        <p>Create the first admin account.</p>
        <div className="auth-form">
          <span className="k-has-help">
            <input aria-label="Setup code" placeholder="Setup code" value={form.code} onChange={set('code')} autoComplete="one-time-code"
              autoCapitalize="characters" spellCheck={false} autoFocus />
            <HelpTip inField label="Where is the setup code?" {...SETUP_CODE_HELP} />
          </span>
          <input aria-label="Your name" placeholder="Your name" value={form.name} onChange={set('name')} autoComplete="name" />
          <input type="email" aria-label="Email" placeholder="Email address" value={form.email} onChange={set('email')} autoComplete="email" />
          <input type="password" aria-label="Password" placeholder="Password (at least 12 characters)" value={form.password}
            onChange={set('password')} autoComplete="new-password" />
          <button type="submit" className="k-btn k-btn-primary" disabled={busy}>{busy ? 'Setting up…' : 'Create admin account'}</button>
          {error && <AuthError message={error} />}
        </div>
        <p className="auth-note">Next, your AI agent (Claude, ChatGPT, Codex…) sets up the rest with you: AI, phone, email and your business.</p>
      </form>
    </AuthPage>
  )
}
