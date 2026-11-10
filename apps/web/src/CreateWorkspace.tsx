import { type FormEvent, useState } from 'react'
import { auth, createWorkspace } from './auth.ts'

/** First sign-in: name the business. Creates the workspace and its assistant. */
export function CreateWorkspace({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createWorkspace(name)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>Name your business</h1>
        <p>Your assistant uses it when it answers the phone.</p>
        <label>
          Business name
          <input required value={name} onChange={e => setName(e.target.value)} autoComplete="organization" autoFocus />
        </label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button type="submit" className="k-btn k-btn-primary" disabled={busy}>Continue</button>
        <button type="button" className="auth-switch" onClick={() => auth.signOut().then(onDone)}>Use a different account</button>
      </form>
    </main>
  )
}
