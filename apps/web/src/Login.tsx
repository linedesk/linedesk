// Sign-in. Shows what this install offers (GET /v1/auth-methods): SSO buttons, an email
// sign-in link, and a password. New people are signed up on first sign-in.
import { type FormEvent, useEffect, useState } from 'react'
import { type AuthMethods, auth, fetchAuthMethods, requestSignInLink, startSso, takeRedirectError } from './auth.ts'

type Step = 'email' | 'password' | 'signUp' | 'linkSent'
type Result = { error: { message?: string } | null }

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
        if (!m.magicLink && m.password) setStep('password')
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

  const actions: Record<Exclude<Step, 'linkSent'>, () => Promise<void>> = {
    email: async () => {
      fail(await requestSignInLink(form.email))
      setStep('linkSent')
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
    if (step !== 'linkSent') void attempt(actions[step])
  }

  if (!methods) return <main className="auth">{error ? <div className="auth-error" role="alert">{error}</div> : <p className="auth-wait">Connecting…</p>}</main>

  if (step === 'linkSent') {
    return (
      <main className="auth">
        <div className="auth-card">
          <h1>Check your email</h1>
          <p>We sent a sign-in link to {form.email}. It works once and expires in 10 minutes.</p>
          <button type="button" className="auth-switch" onClick={() => setStep('email')}>Use a different email</button>
        </div>
      </main>
    )
  }

  const withPassword = step !== 'email'
  const withEmail = methods.magicLink || methods.password
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
            {step === 'email' ? 'Email me a sign-in link' : step === 'signUp' ? 'Create account' : 'Sign in'}
          </button>
        )}
        <LoginSwitches step={step} methods={methods} onStep={s => { setStep(s); setError(null) }} />
      </form>
    </main>
  )
}

function LoginSwitches({ step, methods, onStep }: { step: Step; methods: AuthMethods; onStep: (s: Step) => void }) {
  const link = (to: Step, text: string) => <button type="button" className="auth-switch" onClick={() => onStep(to)}>{text}</button>
  return (
    <>
      {step === 'email' && methods.password && link('password', 'Use a password instead')}
      {step !== 'email' && methods.magicLink && link('email', 'Email me a sign-in link instead')}
      {step === 'password' && link('signUp', 'New here? Create an account')}
      {step === 'signUp' && link('password', 'Already have an account? Sign in')}
    </>
  )
}
