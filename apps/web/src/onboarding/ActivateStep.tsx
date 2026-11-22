// The last step before a number: the business set everything up without a card; here it sees
// what the plan costs a month (a yearly plan's total in a grey note under it, and at its first charge),
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
import { IntervalSwitch } from '../ui/IntervalSwitch.tsx'
import { Note } from '../ui/kit.tsx'
import { PlanCard, usePlanPrice } from '../ui/PlanCard.tsx'
import { type BillingInterval, usePrice } from '../ui/price.tsx'
import { Foot, StepLoading } from './Frame.tsx'
import { activationTimeline, type TimelineEntry } from './flow.ts'
import { rememberOwnerByHand } from './setup-choice.ts'
import './onboarding.css'
import { useSetupKeys } from './setup-keys.ts'

type Props = { me: Me; onBack: () => void; onTermsChanged: () => void }

export function ActivateStep({ me, onBack, onTermsChanged }: Props) {
  const t = useT()
  const activation = me.workspace?.activation
  if (activation) return <Activate me={me} activation={activation} onBack={onBack} onTermsChanged={onTermsChanged} />
  return (
    <StepLoading title={t('onboarding.activate.title')} what={t('onboarding.activate.loading')} foot={{ onBack }} />
  )
}

function Activate({ me, activation: a, onBack, onTermsChanged }: Props & { activation: Activation }) {
  const t = useT()
  const assistant = useAssistantName()
  // Back from Checkout the onboarding goes on to the number, not to the agent setup page: set up by hand here.
  const trial = useStartTrial(me, a, onTermsChanged, { byHand: true })
  useSetupKeys({ onEnter: () => void trial.start(), onEscape: onBack })

  return (
    <>
      <div className="ob-body">
        <h1>{trial.title}</h1>
        <p className="ob-lede">
          {trial.trial
            ? t('onboarding.activate.lede', { assistant, days: a.trialDays })
            : t('onboarding.activate.ledeNoTrial', { assistant })}
        </p>
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
 * "Start your free trial" once it is done (the trial or the plan runs): what came of it, as the Checkout return said,
 * where Back from the number passes it, so the count goes 6, 5, 4 and never jumps over it. Nothing to start again here.
 */
export function ActivatedStep({ trial, onBack, onNext }: { trial: boolean; onBack: () => void; onNext: () => void }) {
  const t = useT()
  useSetupKeys({ onEnter: onNext, onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <h1>{trial ? t('auth.checkout.trialTitle') : t('auth.checkout.planTitle')}</h1>
        <p className="ob-lede">{trial ? t('auth.checkout.trialText') : t('auth.checkout.planText')}</p>
      </div>
      <Foot onBack={onBack} onContinue={onNext} />
    </>
  )
}

/**
 * Starting the trial (or the plan, after a refused trial) through Stripe Checkout, from this step or from the owner's
 * agent setup page (its Start your free trial row, SetupRowActions.tsx). `byHand`: back from Checkout the onboarding goes on
 * by hand (this step); from the agent setup page it opens that page again. `interval`: monthly or yearly to start with
 * (the trial link's `interval=`), else the bill's; the dialog's switch changes it, and Checkout sells the one picked.
 */
export function useStartTrial(
  me: Me,
  a: Activation,
  onTermsChanged: () => void,
  { byHand, interval: preset }: { byHand: boolean; interval?: BillingInterval | null },
) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  // Only an interval the server can price is offered (an older server sends one price: the bill's interval only).
  const [interval, setInterval] = useState<BillingInterval>(() =>
    preset && a.planCentsByInterval ? preset : a.interval,
  )
  const [error, setError] = useState<string | null>(null)
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
      // The bill's interval goes along only when the owner picked another one (an older server takes none).
      await goToCheckout(null, 0, interval !== a.interval ? interval : undefined)
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
    trial,
    interval,
    setInterval,
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
  // Monthly or yearly as picked on the switch (the bill's interval until then): price, note and charge follow it.
  const interval = s.interval
  const planCents = a.planCentsByInterval?.[interval] ?? a.planCents
  const totalCents = planCents
  const timeline = activationTimeline(a, now)
  return (
    <>
      {/* Monthly / Yearly before the card, so a yearly plan nobody noticed can still be monthly (Janik, 2026-11-19). */}
      {a.planCentsByInterval && (
        <IntervalSwitch
          value={interval}
          onChange={s.setInterval}
          centsByInterval={a.planCentsByInterval}
          disabled={s.busy}
        />
      )}
      {/* The shared plan card (ui/PlanCard.tsx): "14 days free" first, the price after it; the dates,
          reminders and cancelling are the timeline's, not repeated there. */}
      <PlanCard
        trialDays={s.trial ? a.trialDays : null}
        price={planPrice(prices.perMonth(planCents, interval))}
        unit={t('common.plan.perWorkspace')}
        // With the switch, a monthly plan says so too; a yearly plan's total stays the grey note.
        note={prices.yearNote(planCents, interval) ?? (a.planCentsByInterval ? t('common.price.billedMonthly') : null)}
        prices={a.prices}
        calls={a.calls}
      />
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
