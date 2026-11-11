// Shown instead of the admin area when an instance admin's session has no second factor
// (docs/architecture.md §12): add a passkey first, or sign in with it again (it counts 12 hours).
import { useEffect, useState } from 'react'
import { type AdminSecondFactor, fetchMe, passkeySupported, signInWithPasskey } from '../auth.ts'
import { authErrorMessage } from '../sign-in-code.ts'
import { Button } from '../ui/kit.tsx'

type Props = { state: AdminSecondFactor; onExit: () => void }

export function SecondFactorPrompt({ state, onExit }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The app's account data is loaded once: after adding a passkey elsewhere, ask again on the way in.
  useEffect(() => {
    let current = true
    void fetchMe().then(me => {
      if (current && me && (me.adminSecondFactor ?? null) !== state) window.location.reload()
    })
    return () => {
      current = false
    }
  }, [state])

  async function confirm() {
    setBusy(true)
    setError(null)
    const res = await signInWithPasskey()
    if (res.error) {
      setBusy(false)
      setError(authErrorMessage(res.error))
      return
    }
    // A new session, started by the passkey: load the app again with it. Stays busy until then.
    window.location.reload()
  }

  const setup = state === 'setup'
  return (
    <main className="adm-2fa">
      <div className="adm-2fa-card" role="region" aria-labelledby="adm-2fa-title">
        <h1 id="adm-2fa-title">{setup ? 'Set up a passkey' : 'Confirm with passkey'}</h1>
        <p>
          {setup
            ? 'Admin needs a passkey. Add one, then sign in with it.'
            : 'Admin needs a passkey sign-in in the last 12 hours.'}
        </p>
        {!setup && !passkeySupported() && <p>Passkeys need https or localhost.</p>}
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        <div className="adm-2fa-actions">
          <Button variant="ghost" title="Back to where you were" onClick={onExit}>
            Back
          </Button>
          {setup ? (
            <Button
              variant="primary"
              title="Open Account, Sign-in & security"
              onClick={() => {
                window.location.hash = '#account/security'
              }}
            >
              Go to Sign-in & security
            </Button>
          ) : (
            <Button
              variant="primary"
              title="Sign in with your passkey"
              disabled={busy || !passkeySupported()}
              onClick={() => void confirm()}
            >
              {busy ? 'Waiting for your device…' : 'Confirm with passkey'}
            </Button>
          )}
        </div>
      </div>
    </main>
  )
}
