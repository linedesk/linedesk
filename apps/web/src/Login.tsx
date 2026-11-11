// Sign-in. Shows what this install offers (GET /v1/auth-methods): email first (a code sent by email),
// then the sign-in providers, and a password under "Show other options". New people are signed up on
// first sign-in, unless sign-up is closed.
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { type AuthMethods, auth, type LegalLinks, type SsoMethod, fetchAuthMethods, requestSignInCode, signInWithCode, startSso, takeRedirectError } from './auth.ts'
import { authErrorMessage, authFormError, CODE_LENGTH, codeErrorMessage, normalizeCode, RESEND_AFTER_S } from './sign-in-code.ts'
import { readLastUsedMethod, rememberSignInMethod } from './sign-in-methods.ts'
import { LastUsed, ProviderButton } from './ui/brand-logos.tsx'
import { AuthPage } from './ui/kit.tsx'

type Step = 'start' | 'code' | 'password'
type Intent = 'signIn' | 'signUp'
type Result = { error: { message?: string; code?: string; status?: number } | null }

const fail = (res: Result) => {
  if (res.error) throw new Error(authErrorMessage(res.error))
}

/** `onDone` resolves once the app has loaded the account, so the form keeps its busy state until the app replaces it. */
export function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [step, setStep] = useState<Step>('start')
  const [intent, setIntent] = useState<Intent>('signIn')
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState<string | null>(takeRedirectError)
  // `busy` is what is running ('email', 'password', a provider id); it stays set after a success that leaves this page.
  const [busy, setBusy] = useState<string | null>(null)
  const [lastUsed] = useState(readLastUsedMethod)
  const [otherOptions, setOtherOptions] = useState(lastUsed === 'password')
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))

  useEffect(() => {
    fetchAuthMethods()
      .then(setMethods)
      .catch(err => setError(String(err.message ?? err)))
  }, [])

  /** Runs one sign-in attempt; `leaves` is true when success hands over to another page (no flash of the form). */
  async function attempt(what: string, action: () => Promise<boolean>) {
    setBusy(what)
    setError(null)
    try {
      if (await action()) return
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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

  if (!methods) return <AuthPage>{error ? <div className="auth-error" role="alert">{error}</div> : <p className="auth-wait">Connecting…</p>}</AuthPage>

  if (step === 'code') {
    return <CodeStep email={form.email} onDone={onDone} onDifferentEmail={() => go('start')} />
  }

  const title = intent === 'signUp' ? 'Create your Linedesk account' : 'Sign in to Linedesk'
  const errorLine = error && <div className="auth-error" role="alert">{error}</div>
  // Without email codes the password is the main form, not one of the other options.
  const passwordFirst = methods.password && !methods.emailCode
  const passwordForm = (
    <PasswordForm intent={intent} form={form} set={set} busy={busy === 'password'} disabled={busy !== null} error={errorLine}
      autoFocus={step === 'password'} onSubmit={signInWithPassword} />
  )

  if (step === 'password') {
    return (
      <AuthPage>
        <div className="auth-card">
          <h1>{title}</h1>
          {passwordForm}
          <button type="button" className="auth-switch" onClick={() => go('start')}>
            {intent === 'signIn' ? 'Forgot your password? Sign in with an email code' : 'Other ways to sign up'}
          </button>
          <AuthFooter methods={methods} intent={intent} onIntent={setIntent} />
        </div>
      </AuthPage>
    )
  }

  const hasProviders = methods.sso.length > 0
  const hasOtherOptions = methods.password && methods.emailCode
  const nothing = !methods.emailCode && !methods.password && !hasProviders
  return (
    <AuthPage>
      <div className="auth-card">
        <h1>{title}</h1>
        {methods.emailCode && (
          <form className="auth-form" onSubmit={sendCode} noValidate>
            <input type="email" aria-label="Email" placeholder="Email address" value={form.email} onChange={set('email')} autoComplete="email" autoFocus
              aria-describedby={error ? 'auth-error' : undefined} />
            <button type="submit" className="k-btn k-btn-primary auth-provider" disabled={busy !== null}>
              <span>{busy === 'email' ? 'Sending…' : 'Continue with Email'}</span>
              {lastUsed === 'email' && <LastUsed />}
            </button>
            {error && <div className="auth-error" role="alert" id="auth-error">{error}</div>}
          </form>
        )}
        {passwordFirst && passwordForm}
        {(methods.emailCode || passwordFirst) && hasProviders && <hr className="auth-separator" />}
        {!methods.emailCode && !passwordFirst && errorLine}
        {nothing && <div className="auth-error" role="alert">No sign-in method is set up on this server.</div>}
        {methods.sso.map(m => (
          <ProviderButton key={m.id} method={m.id} label={m.label} lastUsed={lastUsed === m.id} busy={busy === m.id}
            disabled={busy !== null} onClick={() => continueWith(m)} />
        ))}
        {hasOtherOptions && (otherOptions
          ? <ProviderButton method="password" label="Password" lastUsed={lastUsed === 'password'} disabled={busy !== null} onClick={() => go('password')} />
          : <button type="button" className="auth-switch auth-more" onClick={() => setOtherOptions(true)}>Show other options</button>)}
        <AuthFooter methods={methods} intent={intent} onIntent={setIntent} />
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
    const res = await signInWithCode(email, value)
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
    const res = await requestSignInCode(email)
    if (res.error) setError(authErrorMessage(res.error))
    input.current?.focus()
  }

  return (
    <AuthPage>
      <form className="auth-card" noValidate onSubmit={e => { e.preventDefault(); if (code.length === CODE_LENGTH) void check(code) }}>
        <h1>Check your email</h1>
        <p>We sent a {CODE_LENGTH}-digit code to {email}. It expires in 10 minutes.</p>
        <input ref={input} className="auth-code" aria-label="Sign-in code" value={code} onChange={e => change(e.target.value)} disabled={busy}
          inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={CODE_LENGTH + 6} autoFocus
          aria-describedby={error ? 'code-error' : undefined} />
        {error && <div className="auth-error" role="alert" id="code-error">{error}</div>}
        <button type="submit" className="k-btn k-btn-primary" disabled={busy || code.length < CODE_LENGTH}>
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
