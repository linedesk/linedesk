// The last step before a number (docs/billing.md §3.2): the business set everything up without a card; here it sees
// what it set up, what the plan costs a month (a yearly plan's total in a grey note under it, and at its first charge),
// when the first charge comes and that reminder emails come before it, and goes to Stripe Checkout for the card. No
// terms here: they were accepted once, at sign-up (A9, decision of 2026-11-18); starting records the consent to the
// trial and its charge with what this step showed. Changed since sign-up, the app's "We updated our terms" dialog asks
// first. Back from Checkout (CheckoutReturn.tsx) the trial runs and the onboarding goes on to the phone number.
// The owner's agent setup page shows the same plan in its Start your free trial row (SetupRowActions.tsx).
import { useFormat, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import type { Activation, Me } from '../auth.ts'
import { goToCheckout } from '../checkout.ts'
import { askTermsAgain } from '../shell/TermsUpdate.tsx'
import { useAssistantName } from '../store.tsx'
import { Icon, Note } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { PlanCard, usePlanPrice } from '../ui/PlanCard.tsx'
import { usePrice } from '../ui/price.tsx'
import { useExtraCalls } from './ExtraCalls.tsx'
import { activationTimeline, type TimelineEntry } from './flow.ts'
import { Foot, useStepKeys } from './Frame.tsx'
import { rememberOwnerByHand } from './setup-choice.ts'
import './onboarding.css'

type Props = { me: Me; onBack: () => void; onTermsChanged: () => void }

export function ActivateStep({ me, onBack, onTermsChanged }: Props) {
  const t = useT()
  const activation = me.workspace?.activation
  if (activation) return <Activate me={me} activation={activation} onBack={onBack} onTermsChanged={onTermsChanged} />
  return (
    <>
      <div className="ob-body">
        <h1>{t('onboarding.activate.title')}</h1>
        <Loading what={t('onboarding.activate.loading')} loading skeleton={<SkeletonFields fields={3} />} />
      </div>
      <Foot onBack={onBack} canContinue={false} />
    </>
  )
}

function Activate({ me, activation: a, onBack, onTermsChanged }: Props & { activation: Activation }) {
  const t = useT()
  const assistant = useAssistantName()
  // Back from Checkout the onboarding goes on to the number, not to the agent setup page: set up by hand here.
  const trial = useStartTrial(me, a, onTermsChanged, { byHand: true })
  useStepKeys({ onEnter: () => void trial.start(), onEscape: onBack })

  return (
    <>
      <div className="ob-body">
        <h1>{trial.title}</h1>
        <p className="ob-lede">
          {trial.trial
            ? t('onboarding.activate.lede', { assistant, days: a.trialDays })
            : t('onboarding.activate.ledeNoTrial', { assistant })}
        </p>
        <section className="ob-points" aria-label={t('onboarding.activate.summaryLabel')}>
          <SummaryRow icon="globe" label={t('onboarding.activate.business')} value={me.workspace!.name} />
          <SummaryRow icon="headset" label={t('onboarding.activate.assistant')} value={assistant} />
          <SummaryRow
            icon="phone"
            label={t('onboarding.activate.number')}
            value={t('onboarding.activate.numberNext')}
            muted
          />
        </section>
        <ActivatePlan activation={a} trial={trial} />
      </div>
      <Foot
        onBack={onBack}
        onContinue={() => void trial.start()}
        canContinue={Boolean(a.terms)}
        busy={trial.busy}
        label={trial.label}
        hint={t('onboarding.activate.cardHint')}
      />
    </>
  )
}

export type StartTrial = ReturnType<typeof useStartTrial>

/**
 * Starting the trial (or the plan, after a refused trial) through Stripe Checkout, from this step or from the owner's
 * agent setup page (its Start your free trial row, SetupRowActions.tsx). `byHand`: back from Checkout the onboarding goes on
 * by hand (this step); from the agent setup page it opens that page again.
 */
export function useStartTrial(me: Me, a: Activation, onTermsChanged: () => void, { byHand }: { byHand: boolean }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Extra calls at the same time (LIN-450), picked on the pick-up step; here only sold with the plan.
  const [extraCalls] = useExtraCalls(me.workspace!.id, a.calls)
  const trial = a.trialDays !== null

  /** The terms changed since sign-up and are not accepted yet: the app's dialog asks first (also after Later). */
  function acceptTermsFirst() {
    askTermsAgain()
    setError(t('onboarding.activate.termsChanged'))
  }

  async function start() {
    // `a.terms` null: the install has no terms set, and Checkout cannot start.
    if (busy || !a.terms) return
    if (me.termsUpdate) return acceptTermsFirst()
    setBusy(true)
    setError(null)
    if (byHand) rememberOwnerByHand(me.workspace!.id, true)
    try {
      await goToCheckout(null, extraCalls)
    } catch (e) {
      setBusy(false)
      // Changed since this page loaded: /v1/me is read again, and its dialog asks for the new terms.
      if ((e as { code?: string }).code === 'terms_changed') {
        onTermsChanged()
        acceptTermsFirst()
      } else setError(t('auth.checkout.startFailed'))
    }
  }
  return {
    start,
    busy,
    error,
    extraCalls,
    trial,
    title: trial ? t('onboarding.activate.title') : t('onboarding.activate.titleNoTrial'),
    label: trial ? t('onboarding.activate.startTrial') : t('onboarding.activate.startPlan'),
  }
}

/**
 * What the owner reads before starting: the plan's price a month (a yearly plan's total in the grey note under it,
 * ui/price.tsx), the first charge's real amount in the dated timeline and an error from the last try. No terms (accepted
 * at sign-up) and no renewal line (Stripe Checkout's own note carries it).
 */
export function ActivatePlan({ activation: a, trial: s }: { activation: Activation; trial: StartTrial }) {
  const t = useT()
  const [now] = useState(() => new Date())
  const prices = usePrice()
  const planPrice = usePlanPrice()
  const usd = prices.money
  const yearly = a.interval === 'year'
  // What the first charge is with the extra calls: they are billed at the plan's interval (a year is 12 months).
  const extraMonthlyCents = s.extraCalls * (a.calls?.extraCallCents ?? 0)
  const totalCents = a.planCents + extraMonthlyCents * (yearly ? 12 : 1)
  const timeline = activationTimeline(a, now)
  return (
    <>
      {/* The shared plan card (ui/PlanCard.tsx): "14 days free" first, the price after it; the dates,
          reminders and cancelling are the timeline's, not repeated there. */}
      <PlanCard
        trialDays={s.trial ? a.trialDays : null}
        price={planPrice(prices.perMonth(a.planCents, a.interval))}
        unit={t('common.plan.perWorkspace')}
        note={prices.yearNote(a.planCents, a.interval)}
        prices={a.prices}
        calls={a.calls}
      >
        {s.extraCalls > 0 && (
          <span className="help">
            {t('onboarding.activate.extraCalls', {
              count: (a.calls?.included ?? 0) + s.extraCalls,
              price: usd(extraMonthlyCents),
            })}
          </span>
        )}
      </PlanCard>
      <ol className="ob-timeline" aria-label={t('onboarding.activate.timelineLabel')}>
        {timeline.map(entry => (
          <TimelineRow key={entry.kind} entry={entry} amount={usd(totalCents)} />
        ))}
      </ol>
      {s.error && <Note tone="danger">{s.error}</Note>}
      {/* No renewal line here: Stripe Checkout's own note says what is charged and when; the terms were accepted at sign-up. */}
      {!a.terms && <Note tone="danger">{t('auth.checkout.startFailed')}</Note>}
    </>
  )
}

function SummaryRow({
  icon,
  label,
  value,
  muted,
}: {
  icon: 'globe' | 'headset' | 'phone'
  label: string
  value: string
  muted?: boolean
}) {
  return (
    <div className="ob-point">
      <span className="ob-pi">
        <Icon name={muted ? icon : 'check'} size={16} />
      </span>
      <div>
        <b>{label}</b>
        <span>{value}</span>
      </div>
    </div>
  )
}

/** One row of the trial's timeline; the charge row names the first charge's amount, the one place it shows. */
function TimelineRow({ entry, amount }: { entry: TimelineEntry; amount: string }) {
  const t = useT()
  const format = useFormat()
  const short = (at: Date) => format.date(at, { month: 'short', day: 'numeric' })
  let when: string
  let what: string
  let detail: string
  if (entry.kind === 'reminders') {
    when = format.list(entry.at.map(short))
    what = t('onboarding.activate.stepReminders', {
      days: format.list(entry.before.map(count => t('onboarding.activate.daysBefore', { count }))),
    })
    detail = t('onboarding.activate.stepRemindersDetail')
  } else {
    const date = short(entry.at)
    when =
      entry.day === 1
        ? t('onboarding.activate.today', { date })
        : t('onboarding.activate.day', { day: entry.day, date })
    what = entry.kind === 'start' ? t('onboarding.activate.stepStart') : t('onboarding.activate.stepCharge')
    detail =
      entry.kind === 'start'
        ? t('onboarding.activate.stepStartDetail')
        : entry.day === 1
          ? t('onboarding.activate.stepChargeTodayDetail', { amount })
          : t('onboarding.activate.stepChargeDetail', { amount })
  }
  return (
    <li className={`ob-timeline-${entry.kind}`}>
      <span className="ob-timeline-dot" aria-hidden="true" />
      <div>
        <span className="ob-timeline-when">{when}</span>
        <b>{what}</b>
        <span>{detail}</span>
      </div>
    </li>
  )
}
