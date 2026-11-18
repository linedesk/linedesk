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
import { activationSteps, trialSteps } from './onboarding/flow.ts'
import { Foot, Frame } from './onboarding/Frame.tsx'
import './onboarding/onboarding.css'
import { AuthError } from './ui/AuthError.tsx'
import { cx, Note, Spinner } from './ui/kit.tsx'
import { Loading, SkeletonFields } from './ui/LoadStates.tsx'
import { SignedInAuthPage } from './shell/SignedInAuthPage.tsx'

/**
 * `onDone`: leaves the page; the app reads the workspace again (no longer waiting for Checkout). `toBilling`: minutes
 * were bought from Settings › Billing, so the app goes back there. `partner`: the Checkout was a partner bill's, so
 * the app goes back to the partner area.
 */
export function CheckoutReturn({
  onDone,
  inSetup = false,
}: {
  onDone: (toBilling: boolean, partner: boolean) => void | Promise<void>
  /**
   * Back from the onboarding's "Start your free trial" step: the answer shows inside the setup frame as that step's
   * result (Step 5 of 7), so the count and the bar run on to the number without a page of another kind in between.
   */
  inSetup?: boolean
}) {
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

  // A business's own Checkout from its setup (never a partner's bill, never minutes bought from the settings).
  if (inSetup && !partnerId && outcome?.status !== 'topup')
    return <SetupResult outcome={outcome} busy={busy} onContinue={() => void leave()} />

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
      partnerId ? t('auth.checkout.partnerPlanTitle') : t('auth.checkout.planTitle'),
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

/**
 * The Checkout's answer inside the onboarding frame, as the result of the "Start your free trial" step: the trial (or the
 * plan) started and Continue goes on to the number; no trial for this card, or not confirmed: Continue goes back to
 * that step, which offers the plan again.
 */
function SetupResult({
  outcome,
  busy,
  onContinue,
}: {
  outcome: ConfirmOutcome | null
  busy: boolean
  onContinue: () => void
}) {
  const t = useT()
  const started = outcome?.status === 'trialing' || outcome?.status === 'active'
  const body = () => {
    if (!outcome)
      return <Loading what={t('auth.checkout.confirming')} loading skeleton={<SkeletonFields fields={1} />} />
    if (outcome.status === 'trialing')
      return (
        <>
          <h1>{t('auth.checkout.trialTitle')}</h1>
          <p className="ob-lede">{t('auth.checkout.trialText')}</p>
        </>
      )
    if (outcome.status === 'active')
      return (
        <>
          <h1>{t('auth.checkout.planTitle')}</h1>
          <p className="ob-lede">{t('auth.checkout.planText')}</p>
          {outcome.heldForReview && <Note tone="info">{t('auth.checkout.heldForReview')}</Note>}
        </>
      )
    if (outcome.status === 'trial_refused')
      return (
        <>
          <h1>{t('auth.checkout.refusedTitle')}</h1>
          <p className="ob-lede">
            {outcome.reason === 'prepaid'
              ? t('auth.checkout.refusedPrepaid')
              : outcome.reason === 'account_used'
                ? t('auth.checkout.refusedAccountUsed')
                : t('auth.checkout.refusedCardUsed')}{' '}
            {t('auth.checkout.refusedNothingChargedSetup')}
          </p>
        </>
      )
    return (
      <>
        <h1>{t('auth.checkout.failedTitle')}</h1>
        <Note tone="danger">
          {outcome.status === 'not_found' ? t('auth.checkout.notFound') : t('auth.checkout.failedText')}
        </Note>
      </>
    )
  }
  return (
    <Frame step="activate" steps={activationSteps} counted={trialSteps} complete={started}>
      <div className="ob-body">{body()}</div>
      <Foot
        onContinue={onContinue}
        canContinue={!!outcome}
        busy={busy}
        label={
          !outcome || started
            ? t('auth.checkout.continue')
            : outcome.status === 'trial_refused'
              ? t('auth.checkout.toActivate')
              : t('auth.checkout.back')
        }
      />
    </Frame>
  )
}
