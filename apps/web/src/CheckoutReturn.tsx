// Where Stripe Checkout returns to (/billing/return?session_id=…, docs/billing.md §3.2 step 4): the app confirms the
// session (`billing.confirmCheckout`) and says what came of it. The trial started: on to the phone number. No trial for
// this card (it had one, or it is prepaid): its subscription was canceled and nothing was charged; a partner can start
// the plan now, a business goes back to the onboarding's last step, which shows the plan without a trial. Every answer
// to a setup's Checkout shows in that setup's own shell: the owner's by-hand steps ("Step 5 of 7"), the owner's agent
// page ("With an AI agent") or the partner's setup ("Step 3 of 3 · Activate", in the install's brand).
import { useFormat, useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import {
  type ConfirmOutcome,
  confirmCheckout,
  goToCheckout,
  readCheckoutPartner,
  readCheckoutSession,
} from './checkout.ts'
import { installBrandName } from './brand.ts'
import { activationSteps, trialSteps } from './onboarding/flow.ts'
import { Foot, Frame, useStepKeys } from './onboarding/Frame.tsx'
import { SetupFoot } from './onboarding/SetupFoot.tsx'
import { setupProgress, SetupTopBar } from './onboarding/SetupTopBar.tsx'
import './onboarding/onboarding.css'
import { AuthError } from './ui/AuthError.tsx'
import { cx, Note, Spinner } from './ui/kit.tsx'
import { Loading, SkeletonFields } from './ui/LoadStates.tsx'
import { SignedInAuthPage } from './shell/SignedInAuthPage.tsx'

/**
 * `onDone`: leaves the page; the app reads the workspace again (no longer waiting for Checkout). `toBilling`: minutes
 * were bought from Settings › Billing, so the app goes back there. `partner`: the Checkout was a partner bill's, so
 * the app goes back to the partner's setup or area.
 */
export function CheckoutReturn({
  onDone,
  inSetup = false,
  planOnly = false,
  shell = 'steps',
}: {
  onDone: (toBilling: boolean, partner: boolean) => void | Promise<void>
  /**
   * Back from the onboarding's "Start your free trial" step: the answer shows inside the setup as that step's result
   * (Step 5 of 7), so the count and the bar run on to the number without a page of another kind in between.
   */
  inSetup?: boolean
  /** No free trial for this bill: the step was "Start your plan" (as the onboarding's Frame says it). */
  planOnly?: boolean
  /** Where the setup's Checkout was started: the by-hand steps, or the owner's agent page (its Start trial row). */
  shell?: 'steps' | 'agent'
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

  // White-label Cloud's Checkout: the partner's setup, at its last step (never minutes bought from the billing page).
  if (partnerId && outcome?.status !== 'topup')
    return (
      <PartnerResult
        outcome={outcome}
        busy={busy}
        startFailed={startFailed}
        onContinue={() => void leave()}
        onStartPlan={() => void startPlan()}
      />
    )

  // A business's own Checkout from its setup (never minutes bought from the settings).
  if (inSetup && outcome?.status !== 'topup')
    return (
      <SetupResult outcome={outcome} busy={busy} planOnly={planOnly} shell={shell} onContinue={() => void leave()} />
    )

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
      <SignedInAuthPage>
        <div className="auth-card">
          <h1>{t('auth.checkout.refusedTitle')}</h1>
          <p>{refusedText(outcome.reason, t)}</p>
          <p>{t('auth.checkout.refusedNothingChargedSetup')}</p>
          <button
            type="button"
            className={cx('k-btn k-btn-primary', busy && 'is-busy')}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void leave()}
          >
            {busy && <Spinner />}
            {t('auth.checkout.toActivate')}
          </button>
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

type Refusal = Extract<ConfirmOutcome, { status: 'trial_refused' }>['reason']

/** Why the card got no free trial. */
const refusedText = (reason: Refusal, t: ReturnType<typeof useT>) =>
  reason === 'prepaid'
    ? t('auth.checkout.refusedPrepaid')
    : reason === 'account_used'
      ? t('auth.checkout.refusedAccountUsed')
      : t('auth.checkout.refusedCardUsed')

/** What came of the Checkout, as a setup step's body: its heading, its lede, a note where something is wrong. */
function ResultBody({
  outcome,
  trialTitle,
  planTitle,
  planText,
  refusedNext,
}: {
  outcome: ConfirmOutcome | null
  trialTitle: string
  planTitle: string
  planText: string
  /** After "no free trial with this card": what happens next. */
  refusedNext: string
}) {
  const t = useT()
  if (!outcome) return <Loading what={t('auth.checkout.confirming')} loading skeleton={<SkeletonFields fields={1} />} />
  if (outcome.status === 'trialing')
    return (
      <>
        <h1>{trialTitle}</h1>
        <p className="ob-lede">{t('auth.checkout.trialText')}</p>
      </>
    )
  if (outcome.status === 'active')
    return (
      <>
        <h1>{planTitle}</h1>
        <p className="ob-lede">{planText}</p>
        {outcome.heldForReview && <Note tone="info">{t('auth.checkout.heldForReview')}</Note>}
      </>
    )
  if (outcome.status === 'trial_refused')
    return (
      <>
        <h1>{t('auth.checkout.refusedTitle')}</h1>
        <p className="ob-lede">
          {refusedText(outcome.reason, t)} {refusedNext}
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

/**
 * The Checkout's answer as the result of the "Start your free trial" step: inside the by-hand frame (the count runs on),
 * or under the agent page's top bar when the trial was started from its row. The trial (or the plan) started:
 * Continue goes on to the number; no trial for this card, or not confirmed: back to that step, which offers the plan.
 */
function SetupResult({
  outcome,
  busy,
  planOnly,
  shell,
  onContinue,
}: {
  outcome: ConfirmOutcome | null
  busy: boolean
  planOnly: boolean
  shell: 'steps' | 'agent'
  onContinue: () => void
}) {
  const t = useT()
  const started = outcome?.status === 'trialing' || outcome?.status === 'active'
  useStepKeys({ onEnter: outcome && !busy ? onContinue : undefined })
  const content = (
    <div className="ob-body">
      <ResultBody
        outcome={outcome}
        trialTitle={t('auth.checkout.trialTitle')}
        planTitle={t('auth.checkout.planTitle')}
        planText={t('auth.checkout.planText')}
        refusedNext={t('auth.checkout.refusedNothingChargedSetup')}
      />
    </div>
  )
  const foot = (
    <Foot
      onContinue={onContinue}
      canContinue={!!outcome}
      busy={busy}
      label={
        !outcome || started || shell === 'agent'
          ? t('auth.checkout.continue')
          : // Not started: the step it goes back to is "Start your free trial", which offers the plan again.
            t('auth.checkout.toActivate')
      }
    />
  )
  if (shell === 'agent')
    return (
      <div className="ob" role="main" aria-label={t('onboarding.agentSetup.topLabel')}>
        <SetupTopBar
          label={t('onboarding.agentSetup.topLabel')}
          progress={setupProgress({ n: trialSteps.indexOf('activate') + 1, m: trialSteps.length }, started)}
        />
        <div className="ob-main">
          {content}
          {foot}
        </div>
      </div>
    )
  return (
    <Frame
      step="activate"
      steps={activationSteps}
      counted={trialSteps}
      complete={started}
      planOnly={planOnly || outcome?.status === 'active'}
    >
      {content}
      {foot}
    </Frame>
  )
}

/**
 * The partner's Checkout for White-label Cloud, at the end of the partner's setup ("Step 3 of 3 · Activate", the
 * install's brand, as on its other steps): active, Continue goes on; no trial for this card (there is none for a
 * partner, but the bill may say so), Start plan opens Checkout again and Later leaves; not confirmed, Continue.
 */
function PartnerResult({
  outcome,
  busy,
  startFailed,
  onContinue,
  onStartPlan,
}: {
  outcome: ConfirmOutcome | null
  busy: boolean
  startFailed: boolean
  onContinue: () => void
  onStartPlan: () => void
}) {
  const t = useT()
  const refused = outcome?.status === 'trial_refused'
  const started = outcome?.status === 'trialing' || outcome?.status === 'active'
  useStepKeys({ onEnter: outcome && !busy ? (refused ? onStartPlan : onContinue) : undefined })
  return (
    <div
      className="ob k-install-brand"
      role="main"
      aria-label={t('onboarding.frame.title', { brand: installBrandName() })}
    >
      <SetupTopBar
        step={{ n: 3, m: 3, name: t('team.partner.setup.step.activate') }}
        ahead={started}
        // Not started: Activate waits in the partner's setup, as its own "Finish later" says.
        exit={
          refused ? { kind: 'finish-later', onExit: onContinue, title: t('team.partner.setup.finishLaterTitle') } : null
        }
        brand="install"
        away
      />
      <div className="ob-main">
        <div className="ob-body">
          <ResultBody
            outcome={outcome}
            trialTitle={t('auth.checkout.trialTitle')}
            planTitle={t('auth.checkout.partnerPlanTitle')}
            planText={t('auth.checkout.partnerPlanText')}
            refusedNext={t('auth.checkout.refusedNothingCharged')}
          />
          {startFailed && <Note tone="danger">{t('auth.checkout.startFailed')}</Note>}
        </div>
        <SetupFoot
          onContinue={refused ? onStartPlan : onContinue}
          canContinue={!!outcome}
          busy={busy}
          label={refused ? t('auth.checkout.startPlan') : t('auth.checkout.continue')}
        />
      </div>
    </div>
  )
}
