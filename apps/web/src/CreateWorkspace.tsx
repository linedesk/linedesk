import { type FormEvent, useState } from 'react'
import { createWorkspace } from './auth.ts'
import { signOutAndForget } from './localData.ts'
import { AuthPage } from './ui/kit.tsx'

/** First sign-in: name the business. Creates the workspace and its assistant. */
export function CreateWorkspace({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Give your business a name.')
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
    <AuthPage>
      <form className="auth-card" onSubmit={submit} noValidate>
        <h1>Name your business</h1>
        <p>Your assistant uses it when it answers the phone.</p>
        <label>
          Business name
          <input required value={name} onChange={e => setName(e.target.value)} autoComplete="organization" autoFocus />
        </label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button type="submit" className="k-btn k-btn-primary" disabled={busy}>Continue</button>
        <button type="button" className="auth-switch" onClick={() => void signOutAndForget().then(onDone)}>Use a different account</button>
      </form>
    </AuthPage>
  )
}
