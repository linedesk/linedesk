// Where Stripe Checkout returns to (/billing/return?session_id=…, docs/billing.md §3.2 step 4): the app confirms the
// session (`billing.confirmCheckout`) and says what came of it. The trial started: on to the phone number. No trial for
// this card (it had one, or it is prepaid): its subscription was canceled and nothing was charged; a partner can start
// the plan now, a business goes back to the onboarding's last step, which shows the plan without a trial and asks for
// the terms next to its button again.
import { useFormat, useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import {
  type ConfirmOutcome,
  confirmCheckout,
  goToCheckout,
  readCheckoutPartner,
  readCheckoutSession,
} from './checkout.ts'
import { AuthError } from './ui/AuthError.tsx'
import { cx, Spinner } from './ui/kit.tsx'
import { SignedInAuthPage } from './shell/SignedInAuthPage.tsx'

/**
 * `onDone`: leaves the page; the app reads the workspace again (no longer waiting for Checkout). `toBilling`: minutes
 * were bought from Settings › Billing, so the app goes back there. `partner`: the Checkout was a partner bill's, so
 * the app goes back to the partner area.
 */
export function CheckoutReturn({ onDone }: { onDone: (toBilling: boolean, partner: boolean) => void | Promise<void> }) {
  const t = useT()
  const format = useFormat()
  const [outcome, setOutcome] = useState<ConfirmOutcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [startFailed, setStartFailed] = useState(false)
  // Checkout for a white-label partner's bill (Partner › Billing): confirmed for that partner.
  const [partnerId] = useState(readCheckoutPartner)

  useEffect(() => {
    const session = readCheckoutSession()
    if (!session) {
      setOutcome({ status: 'not_found' })
      return
    }
    void confirmCheckout(session, partnerId).then(setOutcome)
  }, [partnerId])

  const leave = async () => {
    setBusy(true)
    await onDone(outcome?.status === 'topup', !!partnerId)
  }
  const startPlan = async () => {
    setBusy(true)
    setStartFailed(false)
    try {
      await goToCheckout(partnerId)
    } catch {
      setStartFailed(true)
      setBusy(false)
    }
  }

  if (!outcome)
    return (
      <SignedInAuthPage>
        <div className="auth-card" aria-busy>
          <p className="auth-wait">{t('auth.checkout.confirming')}</p>
        </div>
      </SignedInAuthPage>
    )

  const done = (title: string, text: string, extra?: string) => (
    <SignedInAuthPage>
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
    </SignedInAuthPage>
  )

  if (outcome.status === 'trialing') return done(t('auth.checkout.trialTitle'), t('auth.checkout.trialText'))
  if (outcome.status === 'active')
    return done(
      t('auth.checkout.planTitle'),
      partnerId ? t('auth.checkout.partnerPlanText') : t('auth.checkout.planText'),
      outcome.heldForReview ? t('auth.checkout.heldForReview') : undefined,
    )
  if (outcome.status === 'topup')
    return done(
      t('auth.checkout.topupTitle'),
      t('auth.checkout.topupText', { amount: format.currency(outcome.amountCents / 100, 'USD') }),
    )
  if (outcome.status === 'trial_refused')
    return (
      <SignedInAuthPage>
        <div className="auth-card">
          <h1>{t('auth.checkout.refusedTitle')}</h1>
          <p>
            {outcome.reason === 'prepaid'
              ? t('auth.checkout.refusedPrepaid')
              : outcome.reason === 'account_used'
                ? t('auth.checkout.refusedAccountUsed')
                : t('auth.checkout.refusedCardUsed')}
          </p>
          <p>{partnerId ? t('auth.checkout.refusedNothingCharged') : t('auth.checkout.refusedNothingChargedSetup')}</p>
          {startFailed && <AuthError message={t('auth.checkout.startFailed')} />}
          <button
            type="button"
            className={cx('k-btn k-btn-primary', busy && 'is-busy')}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void (partnerId ? startPlan() : leave())}
          >
            {busy && <Spinner />}
            {!partnerId
              ? t('auth.checkout.toActivate')
              : busy
                ? t('auth.checkout.opening')
                : t('auth.checkout.startPlan')}
          </button>
          {partnerId && (
            <button type="button" className="auth-switch" disabled={busy} onClick={() => void leave()}>
              {t('auth.checkout.notNow')}
            </button>
          )}
        </div>
      </SignedInAuthPage>
    )
  return (
    <SignedInAuthPage>
      <div className="auth-card">
        <h1>{t('auth.checkout.failedTitle')}</h1>
        <AuthError
          message={outcome.status === 'not_found' ? t('auth.checkout.notFound') : t('auth.checkout.failedText')}
        />
        <button type="button" className="auth-switch" disabled={busy} onClick={() => void leave()}>
          {t('auth.checkout.back')}
        </button>
      </div>
    </SignedInAuthPage>
  )
}
