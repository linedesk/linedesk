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
import { useEffect, useState } from 'react'
import { type AdminSecondFactor, fetchMe, passkeySupported } from '../auth.ts'
import { brandName } from '../brand.ts'
import { readEnrolmentCode } from '../enrolment-code.ts'
import { PASSKEY_NOT_VERIFIED } from '../sign-in-code.ts'
import { runAdminOnce } from './api.ts'
import { signInAgain } from '../localData.ts'
import { Login } from '../Login.tsx'
import { addPasskeyForThisDevice, confirmWithPasskey, SignInAgain } from '../settings/account/account-api.ts'
import { passkeyAddCancelled } from '../settings/account/add-passkey.ts'
import { AuthError } from '../ui/AuthError.tsx'
import { AuthPage, cx, Spinner } from '../ui/kit.tsx'

type Props = { state: AdminSecondFactor; onExit: () => void }

/** How long the passkey check counts (apps/api/src/admin-second-factor.ts ADMIN_PASSKEY_HOURS). */
export const ADMIN_PASSKEY_HOURS = 12

/** Where an admin without a passkey gets the one-time enrolment code; said on the page and in its tests. */
export const ENROLMENT_CODE_WHERE =
  'Use the code from your first-run setup, ask another admin for one (Server admin › Users › Give passkey code), or run this on the server:'
export const ENROLMENT_COMMAND = 'docker compose exec api node apps/api/src/user-passkeys.ts --enrol --email <your email>'

const TEXT: Record<Exclude<AdminSecondFactor, 'email'>, { title: string; why: string }> = {
  confirm: {
    title: 'Confirm with your passkey',
    why: `Server admin needs your passkey. Confirm once and it counts for ${ADMIN_PASSKEY_HOURS} hours in this browser. Your workspaces work without it.`,
  },
  enrol: {
    title: 'Add a passkey for Server admin',
    why: 'Server admin needs a passkey, so only you can change this server. Your workspaces work without it.',
  },
}

/** A passkey sign-in that did not count for Server admin: the device did not check the person. */
export const PASSKEY_NOT_VERIFIED_FOR_ADMIN =
  "This passkey doesn't check your fingerprint, face or PIN, so it can't open Server admin. Use one that does, or ask another admin to reset your passkeys (on the server: user-passkeys.ts --remove)."

/** The new session (or passkey) is in: load the app again at this address. The form stays busy until then. */
const reload = async () => {
  window.location.reload()
  await new Promise(() => {})
}

export function SecondFactorPrompt({ state, onExit }: Props) {
  // The app's account data is loaded once: after confirming in another tab, ask again on the way in.
  useEffect(() => {
    let current = true
    void fetchMe().then(me => {
      if (current && me && (me.adminSecondFactor ?? null) !== state) window.location.reload()
    })
    return () => {
      current = false
    }
  }, [state])

  if (state === 'email')
    return (
      <Login
        reauth={{
          title: 'Confirm your email for Server admin',
          why: 'Server admin needs a passkey, and adding one needs a confirmed email address. Continue with Email: signing in with the code confirms it.',
          onBack: onExit,
        }}
        onDone={reload}
      />
    )
  return <PasskeyGate state={state} onExit={onExit} />
}

type Busy = 'add' | 'confirm' | null

function PasskeyGate({ state, onExit }: { state: 'confirm' | 'enrol'; onExit: () => void }) {
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
        setError(PASSKEY_NOT_VERIFIED_FOR_ADMIN)
        setBusy(null)
        return
      }
      await reload()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message === PASSKEY_NOT_VERIFIED ? PASSKEY_NOT_VERIFIED_FOR_ADMIN : message)
      setBusy(null)
    }
  }
  const addThenConfirm = async () => {
    if (!code.trim()) return setError('Enter your passkey enrolment code first.')
    setBusy('add')
    setError(null)
    setNeedsSignIn(false)
    try {
      await addPasskeyForThisDevice(code)
      setAdded(true)
    } catch (e) {
      // A sign-in older than a day may not add a passkey (Better Auth's fresh age): sign in again, then come back.
      setNeedsSignIn(e instanceof SignInAgain)
      setError(passkeyAddCancelled(e) ? 'No passkey was added. Try again when you are ready.' : String((e as Error).message ?? e))
      setBusy(null)
      return
    }
    // One sign-in with the new passkey is the check itself.
    await confirm()
  }

  const text = state === 'enrol' && added ? TEXT.confirm : TEXT[state]
  return (
    <AuthPage>
      <div className="auth-card" role="main" aria-label={text.title}>
        <h1>{text.title}</h1>
        <p className="auth-why">{text.why}</p>
        {!supported && <AuthError message={`Passkeys need https. Open ${brandName()} at its https address.`} />}
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
              {ENROLMENT_CODE_WHERE} <code className="auth-command">{ENROLMENT_COMMAND}</code>
            </p>
            <input
              aria-label="Enrolment code"
              placeholder="Enrolment code"
              value={code}
              onChange={e => setCode(e.target.value)}
              autoComplete="one-time-code"
              autoFocus={!code}
              disabled={busy !== null}
            />
            {error && <AuthError message={error} />}
            {needsSignIn ? (
              <button type="button" className="k-btn k-btn-primary" onClick={() => void signInAgain()}>
                Sign in again
              </button>
            ) : (
              <button
                type="submit"
                className={cx('k-btn k-btn-primary', busy && 'is-busy')}
                disabled={busy !== null || !code.trim()}
                aria-busy={busy !== null || undefined}
                title="Create a passkey on this device, then confirm with it"
              >
                {busy && <Spinner />}
                {busy ? 'Waiting for your device…' : 'Add passkey'}
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
              title="Sign in with your passkey"
              onClick={() => void confirm()}
            >
              {busy && <Spinner />}
              {busy ? 'Waiting for your device…' : 'Confirm with passkey'}
            </button>
          </>
        )}
        <EndAgentAccess />
        <button type="button" className="auth-switch" title="Back to where you were" onClick={onExit}>
          Back
        </button>
      </div>
    </AuthPage>
  )
}

/** Ends the admin's own agent setup links without the passkey check (agentSetup.revoke, setupLink:end). */
function EndAgentAccess() {
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
  if (state === 'done') return <p className="auth-note">Agent access ended: your setup link no longer works.</p>
  if (state === 'none') return <p className="auth-note">No setup link of yours was active.</p>
  return (
    <>
      {state === 'failed' && <AuthError message="Could not end agent access. Try again." />}
      <button
        type="button"
        className="auth-switch"
        disabled={state === 'busy'}
        title="Every AI agent setup link you made stops working at once. No passkey needed."
        onClick={() => void end()}
      >
        End agent access
      </button>
    </>
  )
}
