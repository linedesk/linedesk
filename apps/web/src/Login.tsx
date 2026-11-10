import { useState, type FormEvent } from 'react'
import { auth, createWorkspace, fetchMe } from './auth.ts'

type Mode = 'signIn' | 'signUp'

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('signIn')
  const [form, setForm] = useState({ name: '', business: '', email: '', password: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [key]: e.target.value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = mode === 'signIn'
        ? await auth.signIn.email({ email: form.email, password: form.password })
        : await auth.signUp.email({ name: form.name, email: form.email, password: form.password })
      if (res.error) throw new Error(res.error.message ?? 'That did not work')
      if (!(await fetchMe())?.workspace) await createWorkspace(form.business || `${form.name}'s business`)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const signUp = mode === 'signUp'
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>{signUp ? 'Create your account' : 'Sign in to Callfront'}</h1>
        <p>{signUp ? 'Your assistant answers every call.' : 'Your calls, handled.'}</p>
        {signUp && <label>Your name<input required value={form.name} onChange={set('name')} autoComplete="name" /></label>}
        {signUp && <label>Business name<input required value={form.business} onChange={set('business')} autoComplete="organization" /></label>}
        <label>Email<input required type="email" value={form.email} onChange={set('email')} autoComplete="email" autoFocus /></label>
        <label>Password<input required type="password" minLength={8} value={form.password} onChange={set('password')} autoComplete={signUp ? 'new-password' : 'current-password'} /></label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button type="submit" className="k-btn k-btn-primary" disabled={busy}>{signUp ? 'Create account' : 'Sign in'}</button>
        <button type="button" className="auth-switch" onClick={() => { setMode(signUp ? 'signIn' : 'signUp'); setError(null) }}>
          {signUp ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </form>
    </main>
  )
}
