// Sign-in. Shows what this install offers (GET /v1/auth-methods): SSO buttons, a code sent by
// email, and a password. New people are signed up on first sign-in, unless sign-up is closed.
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { type AuthMethods, auth, fetchAuthMethods, requestSignInCode, signInWithCode, startSso, takeRedirectError } from './auth.ts'
import { CODE_LENGTH, codeErrorMessage, normalizeCode, RESEND_AFTER_S } from './sign-in-code.ts'

type Step = 'email' | 'code' | 'password' | 'signUp'
type Result = { error: { message?: string; code?: string } | null }

const fail = (res: Result) => {
  if (res.error) throw new Error(res.error.message ?? 'That did not work')
}

export function Login({ onDone }: { onDone: () => void }) {
  const [methods, setMethods] = useState<AuthMethods | null>(null)
  const [step, setStep] = useState<Step>('email')
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState<string | null>(takeRedirectError)
  const [busy, setBusy] = useState(false)
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))

  useEffect(() => {
    fetchAuthMethods()
      .then(m => {
        setMethods(m)
        if (!m.emailCode && m.password) setStep('password')
      })
      .catch(err => setError(String(err.message ?? err)))
  }, [])

  async function attempt(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const actions: Record<Exclude<Step, 'code'>, () => Promise<void>> = {
    email: async () => {
      fail(await requestSignInCode(form.email))
      setStep('code')
    },
    password: async () => {
      fail(await auth.signIn.email({ email: form.email, password: form.password }))
      onDone()
    },
    signUp: async () => {
      fail(await auth.signUp.email({ name: form.name, email: form.email, password: form.password }))
      onDone()
    },
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (step !== 'code') void attempt(actions[step])
  }

  if (!methods) return <main className="auth">{error ? <div className="auth-error" role="alert">{error}</div> : <p className="auth-wait">Connecting…</p>}</main>

  if (step === 'code') {
    return (
      <CodeStep email={form.email} onDone={onDone}
        onDifferentEmail={() => { setStep('email'); setError(null) }} />
    )
  }

  const withPassword = step !== 'email'
  const withEmail = methods.emailCode || methods.password
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>{step === 'signUp' ? 'Create your account' : 'Sign in to Linedesk'}</h1>
        <p>Your calls, handled.</p>
        {methods.sso.map(m => (
          <button key={m.id} type="button" className="k-btn k-btn-secondary" disabled={busy} onClick={() => attempt(async () => fail(await startSso(m)))}>
            Continue with {m.label}
          </button>
        ))}
        {methods.sso.length > 0 && withEmail && <div className="auth-or" role="separator">or</div>}
        {!withEmail && methods.sso.length === 0 && <div className="auth-error" role="alert">No sign-in method is set up on this server.</div>}
        {withEmail && step === 'signUp' && (
          <label>
            Your name
            <input required value={form.name} onChange={set('name')} autoComplete="name" />
          </label>
        )}
        {withEmail && (
          <label>
            Email
            <input required type="email" value={form.email} onChange={set('email')} autoComplete="email" autoFocus />
          </label>
        )}
        {withEmail && withPassword && (
          <label>
            Password
            <input required type="password" minLength={8} value={form.password} onChange={set('password')} autoComplete={step === 'signUp' ? 'new-password' : 'current-password'} />
          </label>
        )}
        {error && <div className="auth-error" role="alert">{error}</div>}
        {withEmail && (
          <button type="submit" className="k-btn k-btn-primary" disabled={busy}>
            {step === 'email' ? 'Email me a code' : step === 'signUp' ? 'Create account' : 'Sign in'}
          </button>
        )}
        <LoginSwitches step={step} methods={methods} onStep={s => { setStep(s); setError(null) }} />
      </form>
    </main>
  )
}

type CodeStepProps = { email: string; onDone: () => void; onDifferentEmail: () => void }

/** One field for the six digits: typing, pasting the whole code or the OS's one-time-code fill all work; the sixth digit submits. */
function CodeStep({ email, onDone, onDifferentEmail }: CodeStepProps) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
    setBusy(false)
    if (!res.error) return onDone()
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
    if (res.error) setError(res.error.message ?? 'Could not send a new code.')
    input.current?.focus()
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={e => { e.preventDefault(); if (code.length === CODE_LENGTH) void check(code) }}>
        <h1>Check your email</h1>
        <p>We sent a {CODE_LENGTH}-digit code to {email}. It expires in 10 minutes.</p>
        <label>
          Sign-in code
          <input ref={input} className="auth-code" value={code} onChange={e => change(e.target.value)} disabled={busy}
            inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={CODE_LENGTH + 6} autoFocus
            aria-describedby={error ? 'code-error' : undefined} />
        </label>
        {error && <div className="auth-error" role="alert" id="code-error">{error}</div>}
        <button type="submit" className="k-btn k-btn-primary" disabled={busy || code.length < CODE_LENGTH}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        {waitS > 0
          ? <p className="auth-note">You can ask for a new code in {waitS} s.</p>
          : <button type="button" className="auth-switch" onClick={() => void resend()}>Resend code</button>}
        <button type="button" className="auth-switch" onClick={onDifferentEmail}>Use a different email</button>
      </form>
    </main>
  )
}

function LoginSwitches({ step, methods, onStep }: { step: Step; methods: AuthMethods; onStep: (s: Step) => void }) {
  const link = (to: Step, text: string) => <button type="button" className="auth-switch" onClick={() => onStep(to)}>{text}</button>
  return (
    <>
      {step === 'email' && methods.password && link('password', 'Use a password instead')}
      {step !== 'email' && methods.emailCode && link('email', 'Email me a code instead')}
      {step === 'password' && methods.signUp !== false && link('signUp', 'New here? Create an account')}
      {methods.signUp === false && <p className="auth-note">Sign-up is closed on this server. Ask your administrator for an account.</p>}
      {step === 'signUp' && link('password', 'Already have an account? Sign in')}
    </>
  )
}
