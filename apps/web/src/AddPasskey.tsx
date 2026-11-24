// Asking a member without a passkey to add one (passkey-ask.ts, LIN-215): the calm page right after signing in another
// way (AddPasskeyPage) and the quiet card in the app (PasskeyCard). Both add the passkey the way Account › Sign-in &
// security does (addPasskeyForThisDevice); "Not now" pauses both on this device for 14 days. Never blocking.

import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { signInAgain } from './localData.ts'
import { PAUSE_DAYS, pause } from './passkey-ask.ts'
import { lastSignInProvider } from './sign-in-methods.ts'
import { addPasskeyForThisDevice, SignInAgain } from './settings/account/account-api.ts'
import { AuthError } from './ui/AuthError.tsx'
import { HelpTip } from './ui/form.tsx'
import { Button, cx, Note, Spinner } from './ui/kit.tsx'
import { SignedInAuthPage } from './shell/SignedInAuthPage.tsx'

/**
 * The one line why, by how this device signed in: after a provider (Google, Microsoft, GitHub, an SSO) what a passkey
 * saves is that provider's page (named, unless the SSO kept its default label), else the email code. The longer
 * explanation sits behind the "?" (auth.addPasskey.help).
 */
function useWhy(): string {
  const t = useT()
  const provider = lastSignInProvider()
  if (provider === null) return t('auth.addPasskey.why')
  return provider ? t('auth.addPasskey.whyProvider', { provider }) : t('auth.addPasskey.whyUnnamedProvider')
}

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
  const t = useT()
  const why = useWhy()
  const request = useAddPasskey(() => {})
  if (request.step === 'added') {
    return (
      <SignedInAuthPage>
        <div className="auth-card">
          <h1>{t('auth.addPasskey.added')}</h1>
          <p>{t('auth.addPasskey.addedNext')}</p>
          <button
            type="button"
            className="k-btn k-btn-primary"
            onClick={() => {
              void onAdded()
              onDone()
            }}
          >
            {t('auth.addPasskey.continue')}
          </button>
        </div>
      </SignedInAuthPage>
    )
  }
  const adding = request.step === 'adding'
  return (
    <SignedInAuthPage>
      <div className="auth-card">
        <h1>{t('auth.addPasskey.title')}</h1>
        <p className="auth-why">
          {why} <HelpTip text={t('auth.addPasskey.help')} />
        </p>
        {request.error && <AuthError message={request.error} />}
        {request.needsSignIn ? (
          <button type="button" className="k-btn k-btn-primary" onClick={() => void signInAgain()}>
            {t('auth.addPasskey.signInAgain')}
          </button>
        ) : (
          <button
            type="button"
            className={cx('k-btn k-btn-primary', adding && 'is-busy')}
            disabled={adding}
            aria-busy={adding || undefined}
            onClick={() => void request.add()}
          >
            {adding && <Spinner />}
            {adding ? t('auth.addPasskey.waitingDevice') : t('auth.addPasskey.add')}
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
          {t('auth.addPasskey.notNow')}
        </button>
      </div>
    </SignedInAuthPage>
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
  const t = useT()
  const why = useWhy()
  const request = useAddPasskey(onAdded)
  const adding = request.step === 'adding'
  const notNow = () => {
    pause(account)
    onClose()
  }
  return (
    <section className="tour star-card passkey-card" role="dialog" aria-label={t('auth.addPasskey.title')}>
      <h2>
        {t('auth.addPasskey.title')} <HelpTip text={t('auth.addPasskey.help')} />
      </h2>
      <p>{why}</p>
      {request.error && <Note tone="danger">{request.error}</Note>}
      <div className="tour-foot">
        <span className="tour-count" />
        <Button
          size="sm"
          variant="ghost"
          onClick={notNow}
          disabled={adding}
          title={t('auth.addPasskey.askAgainIn', { days: PAUSE_DAYS })}
        >
          {t('auth.addPasskey.notNow')}
        </Button>
        {request.needsSignIn ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void signInAgain()}
            title={t('auth.addPasskey.signInAgainTitle')}
          >
            {t('auth.addPasskey.signInAgain')}
          </Button>
        ) : needsEnrolmentCode ? (
          <Button
            size="sm"
            variant="primary"
            title={t('auth.addPasskey.enrolmentTitle')}
            onClick={() => {
              window.location.hash = '#account/security'
              onClose()
            }}
          >
            {t('auth.addPasskey.add')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            busy={adding}
            disabled={adding}
            title={t('auth.addPasskey.addTitle')}
            onClick={() => void request.add()}
          >
            {adding ? t('auth.addPasskey.waiting') : t('auth.addPasskey.add')}
          </Button>
        )}
      </div>
    </section>
  )
}
