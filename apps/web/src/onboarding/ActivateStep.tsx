// The last step before a number (docs/billing.md §3.2): the business set everything up without a card; here it sees
// what it set up, what the plan costs a month (a yearly plan's total in a grey note under it, and at its first charge), when the first
// charge comes and that reminder emails come before it, accepts
// the terms next to the button (clickwrap, A9: recorded with what this step showed) and goes to Stripe Checkout for
// the card. Back from Checkout (CheckoutReturn.tsx) the trial runs and the onboarding goes on to the phone number.
// The owner's agent setup page shows the same plan and terms in its Start your trial row (SetupRowActions.tsx).
import { T, useFormat, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import type { Activation, Me } from '../auth.ts'
import { goToCheckout } from '../checkout.ts'
import { useAssistantName } from '../store.tsx'
import { ExternalLink } from '../ui/AppLink.tsx'
import { Icon, Note } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { PriceLine, usePrice } from '../ui/price.tsx'
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
 * agent setup page (its Start your trial row, SetupRowActions.tsx). `byHand`: back from Checkout the onboarding goes on
 * by hand (this step); from the agent setup page it opens that page again.
 */
export function useStartTrial(me: Me, a: Activation, onTermsChanged: () => void, { byHand }: { byHand: boolean }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Extra calls at the same time (LIN-450), picked on the pick-up step; here only sold with the plan.
  const [extraCalls] = useExtraCalls(me.workspace!.id, a.calls)
  const trial = a.trialDays !== null
  const terms = a.terms

  async function start() {
    if (busy || !terms) return
    setBusy(true)
    setError(null)
    if (byHand) rememberOwnerByHand(me.workspace!.id, true)
    try {
      await goToCheckout(null, { termsVersion: terms.termsVersion, privacyVersion: terms.privacyVersion }, extraCalls)
    } catch (e) {
      setBusy(false)
      // Changed while the step was open: the new links load, and the owner reads them and starts again.
      if ((e as { code?: string }).code === 'terms_changed') {
        onTermsChanged()
        setError(t('onboarding.activate.termsChanged'))
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
 * ui/price.tsx), the first charge's real amount in the dated timeline, an error from the last try and the terms next to the button.
 */
export function ActivatePlan({ activation: a, trial: s }: { activation: Activation; trial: StartTrial }) {
  const t = useT()
  const format = useFormat()
  const [now] = useState(() => new Date())
  const prices = usePrice()
  const usd = prices.money
  const yearly = a.interval === 'year'
  // What the first charge is with the extra calls: they are billed at the plan's interval (a year is 12 months).
  const extraMonthlyCents = s.extraCalls * (a.calls?.extraCallCents ?? 0)
  const totalCents = a.planCents + extraMonthlyCents * (yearly ? 12 : 1)
  // "5¢", as the plan is priced (format.centRate).
  const perMinute = format.centRate(a.standardMicrosPerMinute / 1_000_000, 'USD')
  const timeline = activationTimeline(a, now)
  const terms = a.terms
  return (
    <>
      <div className="ob-activate-plan">
        <PriceLine note={prices.yearNote(a.planCents, a.interval)}>
          {t('onboarding.activate.perMonthWorkspace', { price: prices.perMonth(a.planCents, a.interval) })}
        </PriceLine>
        <span>
          {t('onboarding.activate.includes', { minutes: a.includedMinutes, perMinute })}
          {s.trial ? ` ${t('onboarding.activate.trialFree', { days: a.trialDays })}` : ''}
        </span>
        {s.extraCalls > 0 && (
          <span>
            {t('onboarding.activate.extraCalls', {
              count: (a.calls?.included ?? 0) + s.extraCalls,
              price: usd(extraMonthlyCents),
            })}
          </span>
        )}
      </div>
      <ol className="ob-timeline" aria-label={t('onboarding.activate.timelineLabel')}>
        {timeline.map(entry => (
          <TimelineRow key={entry.kind} entry={entry} amount={usd(totalCents)} />
        ))}
      </ol>
      {s.error && <Note tone="danger">{s.error}</Note>}
      {terms ? (
        <p className="ob-activate-fine">
          <T
            k={s.trial ? 'onboarding.activate.terms' : 'onboarding.activate.termsPlan'}
            values={{
              terms: chunks => <ExternalLink href={terms.termsUrl}>{chunks}</ExternalLink>,
              privacy: chunks => <ExternalLink href={terms.privacyUrl}>{chunks}</ExternalLink>,
            }}
          />
        </p>
      ) : (
        <Note tone="danger">{t('auth.checkout.startFailed')}</Note>
      )}
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
