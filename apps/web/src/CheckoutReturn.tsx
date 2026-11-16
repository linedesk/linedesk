// Where Stripe Checkout returns to (/billing/return?session_id=…, docs/billing.md §3.2 step 4): the app confirms the
// session (`billing.confirmCheckout`) and says what came of it. The trial started: on to the setup. No trial for this
// card (it had one, or it is prepaid): its subscription was canceled, nothing was charged, and the plan can start now.
import { useFormat, useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { type ConfirmOutcome, confirmCheckout, goToCheckout, readCheckoutSession } from './checkout.ts'
import { AuthError } from './ui/AuthError.tsx'
import { AuthPage, cx, Spinner } from './ui/kit.tsx'

/** `onDone`: leaves the page; the app reads the workspace again (no longer waiting for Checkout). */
export function CheckoutReturn({ onDone }: { onDone: () => void | Promise<void> }) {
  const t = useT()
  const format = useFormat()
  const [outcome, setOutcome] = useState<ConfirmOutcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [startFailed, setStartFailed] = useState(false)

  useEffect(() => {
    const session = readCheckoutSession()
    if (!session) {
      setOutcome({ status: 'not_found' })
      return
    }
    void confirmCheckout(session).then(setOutcome)
  }, [])

  const leave = async () => {
    setBusy(true)
    await onDone()
  }
  const startPlan = async () => {
    setBusy(true)
    setStartFailed(false)
    try {
      await goToCheckout()
    } catch {
      setStartFailed(true)
      setBusy(false)
    }
  }

  if (!outcome)
    return (
      <AuthPage>
        <div className="auth-card" aria-busy>
          <p className="auth-wait">{t('auth.checkout.confirming')}</p>
        </div>
      </AuthPage>
    )

  const done = (title: string, text: string, extra?: string) => (
    <AuthPage>
      <div className="auth-card">
        <h1>{title}</h1>
        <p>{text}</p>
        {extra && <p>{extra}</p>}
        <button
          type="button"
          className={cx('k-btn k-btn-primary', busy && 'is-busy')}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => void leave()}
        >
          {busy && <Spinner />}
          {t('auth.checkout.continue')}
        </button>
      </div>
    </AuthPage>
  )

  if (outcome.status === 'trialing') return done(t('auth.checkout.trialTitle'), t('auth.checkout.trialText'))
  if (outcome.status === 'active')
    return done(
      t('auth.checkout.planTitle'),
      t('auth.checkout.planText'),
      outcome.heldForReview ? t('auth.checkout.heldForReview') : undefined,
    )
  if (outcome.status === 'topup')
    return done(
      t('auth.checkout.topupTitle'),
      t('auth.checkout.topupText', { amount: format.currency(outcome.amountCents / 100, 'USD') }),
    )
  if (outcome.status === 'trial_refused')
    return (
      <AuthPage>
        <div className="auth-card">
          <h1>{t('auth.checkout.refusedTitle')}</h1>
          <p>{outcome.reason === 'prepaid' ? t('auth.checkout.refusedPrepaid') : t('auth.checkout.refusedCardUsed')}</p>
          <p>{t('auth.checkout.refusedNothingCharged')}</p>
          {startFailed && <AuthError message={t('auth.checkout.startFailed')} />}
          <button
            type="button"
            className={cx('k-btn k-btn-primary', busy && 'is-busy')}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void startPlan()}
          >
            {busy && <Spinner />}
            {busy ? t('auth.checkout.opening') : t('auth.checkout.startPlan')}
          </button>
          <button type="button" className="auth-switch" disabled={busy} onClick={() => void leave()}>
            {t('auth.checkout.notNow')}
          </button>
        </div>
      </AuthPage>
    )
  return (
    <AuthPage>
      <div className="auth-card">
        <h1>{t('auth.checkout.failedTitle')}</h1>
        <AuthError
          message={outcome.status === 'not_found' ? t('auth.checkout.notFound') : t('auth.checkout.failedText')}
        />
        <button type="button" className="auth-switch" disabled={busy} onClick={() => void leave()}>
          {t('auth.checkout.back')}
        </button>
      </div>
    </AuthPage>
  )
}
