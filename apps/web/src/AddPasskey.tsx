// Asking a member without a passkey to add one (passkey-ask.ts, LIN-215): the calm page right after signing in another
// way (AddPasskeyPage) and the quiet card in the app (PasskeyCard). Both add the passkey the way Account › Sign-in &
// security does (addPasskeyForThisDevice); "Not now" pauses both on this device for 14 days. Never blocking.
import { useState } from 'react'
import { signInAgain } from './localData.ts'
import { PAUSE_DAYS, pause } from './passkey-ask.ts'
import { addPasskeyForThisDevice, SignInAgain } from './settings/account/account-api.ts'
import { AuthError } from './ui/AuthError.tsx'
import { HelpTip } from './ui/form.tsx'
import { AuthPage, Button, cx, Note, Spinner } from './ui/kit.tsx'

/** The one line why, and the longer explanation behind the "?". */
export const PASSKEY_WHY = 'Sign in faster next time, with no code.'
export const PASSKEY_HELP =
  'A passkey lets you sign in with your fingerprint, face or screen lock. It stays on your device and only works for this site, so nobody can trick you into giving it away. Email codes keep working.'

type Step = 'ask' | 'adding' | 'added'

/** Adds a passkey on this device; keeps what happened for the page or card to show. */
function useAddPasskey(onAdded: () => void | Promise<void>) {
  const [step, setStep] = useState<Step>('ask')
  const [error, setError] = useState<string | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  async function add() {
    setStep('adding')
    setError(null)
    try {
      await addPasskeyForThisDevice()
      setStep('added')
      await onAdded()
    } catch (err) {
      // A sign-in older than a day may not add one (Better Auth's fresh age): signing in again comes back here.
      setNeedsSignIn(err instanceof SignInAgain)
      setError(err instanceof Error ? err.message : String(err))
      setStep('ask')
    }
  }
  return { step, error, needsSignIn, add }
}

type PageProps = {
  /** Whose "Not now" it is (the account id). */
  account: string
  /** The account knows its passkey now (the app reads /v1/me again). */
  onAdded: () => void | Promise<void>
  /** On into the app: after "Not now", or "Continue" once the passkey is added. */
  onDone: () => void
}

/** Right after signing in without a passkey: one calm question before the app. */
export function AddPasskeyPage({ account, onAdded, onDone }: PageProps) {
  const request = useAddPasskey(() => {})
  if (request.step === 'added') {
    return (
      <AuthPage>
        <div className="auth-card">
          <h1>Passkey added</h1>
          <p>Next time, choose Sign in with passkey.</p>
          <button
            type="button"
            className="k-btn k-btn-primary"
            autoFocus
            onClick={() => {
              void onAdded()
              onDone()
            }}
          >
            Continue
          </button>
        </div>
      </AuthPage>
    )
  }
  const adding = request.step === 'adding'
  return (
    <AuthPage>
      <div className="auth-card">
        <h1>Add a passkey</h1>
        <p className="auth-why">
          {PASSKEY_WHY} <HelpTip text={PASSKEY_HELP} />
        </p>
        {request.error && <AuthError message={request.error} />}
        {request.needsSignIn ? (
          <button type="button" className="k-btn k-btn-primary" autoFocus onClick={() => void signInAgain()}>
            Sign in again
          </button>
        ) : (
          <button
            type="button"
            className={cx('k-btn k-btn-primary', adding && 'is-busy')}
            disabled={adding}
            aria-busy={adding || undefined}
            autoFocus
            onClick={() => void request.add()}
          >
            {adding && <Spinner />}
            {adding ? 'Waiting for your device…' : 'Add passkey'}
          </button>
        )}
        <button
          type="button"
          className="auth-switch"
          disabled={adding}
          onClick={() => {
            pause(account)
            onDone()
          }}
        >
          Not now
        </button>
      </div>
    </AuthPage>
  )
}

type CardProps = {
  account: string
  /** An instance admin's first passkey needs their enrolment code: the card opens Account › Sign-in & security. */
  needsEnrolmentCode: boolean
  /** Added: the app says so (a toast), closes the card and reads the account again. */
  onAdded: () => void | Promise<void>
  /** Gone for this page: answered with "Not now", or sent to Account settings. */
  onClose: () => void
}

/** In the app, for members without a passkey: a small card at the bottom right, like the star prompt. */
export function PasskeyCard({ account, needsEnrolmentCode, onAdded, onClose }: CardProps) {
  const request = useAddPasskey(onAdded)
  const adding = request.step === 'adding'
  const notNow = () => {
    pause(account)
    onClose()
  }
  return (
    <section className="tour star-card passkey-card" role="dialog" aria-label="Add a passkey">
      <h2>
        Add a passkey <HelpTip text={PASSKEY_HELP} />
      </h2>
      <p>{PASSKEY_WHY}</p>
      {request.error && <Note tone="danger">{request.error}</Note>}
      <div className="tour-foot">
        <span className="tour-count" />
        <Button size="sm" variant="ghost" onClick={notNow} disabled={adding} title={`Ask again in ${PAUSE_DAYS} days`}>
          Not now
        </Button>
        {request.needsSignIn ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void signInAgain()}
            title="Sign out and sign in again, then add it"
          >
            Sign in again
          </Button>
        ) : needsEnrolmentCode ? (
          <Button
            size="sm"
            variant="primary"
            title="Add it in Account settings with your enrolment code"
            onClick={() => {
              window.location.hash = '#account/security'
              onClose()
            }}
          >
            Add passkey
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            busy={adding}
            disabled={adding}
            title="Create a passkey on this device for your account"
            onClick={() => void request.add()}
          >
            {adding ? 'Waiting…' : 'Add passkey'}
          </Button>
        )}
      </div>
    </section>
  )
}
