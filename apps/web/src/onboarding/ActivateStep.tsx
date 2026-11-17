// The last step before a number (docs/billing.md §3.2): the business set everything up without a card; here it sees
// what it set up, what the plan costs, when the first charge comes and that reminder emails come before it, accepts
// the terms next to the button (clickwrap, A9: recorded with what this step showed) and goes to Stripe Checkout for
// the card. Back from Checkout (CheckoutReturn.tsx) the trial runs and the onboarding goes on to the phone number.
import { T, useFormat, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import type { Activation, Me } from '../auth.ts'
import { goToCheckout } from '../checkout.ts'
import { useAssistantName } from '../store.tsx'
import { ExternalLink } from '../ui/AppLink.tsx'
import { Icon, Note } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { activationTimeline, type TimelineEntry } from './flow.ts'
import { Foot, useStepKeys } from './Frame.tsx'
import { rememberOwnerByHand } from './setup-choice.ts'

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
  const format = useFormat()
  const assistant = useAssistantName()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now] = useState(() => new Date())
  const trial = a.trialDays !== null
  const usd = (cents: number) =>
    format.currency(cents / 100, 'USD', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })
  const plan =
    a.interval === 'year'
      ? t('onboarding.activate.planYearly', { price: usd(a.planCents), monthly: usd(Math.round(a.planCents / 12)) })
      : t('onboarding.activate.planMonthly', { price: usd(a.planCents) })
  // "5¢", as the plan is priced (format.centRate).
  const perMinute = format.centRate(a.standardMicrosPerMinute / 1_000_000, 'USD')
  const timeline = activationTimeline(a, now)
  const firstCharge = timeline.at(-1)!
  const terms = a.terms

  async function start() {
    if (busy || !terms) return
    setBusy(true)
    setError(null)
    // Back from Checkout the onboarding goes on to the number, not to the agent setup page: set up by hand here.
    rememberOwnerByHand(me.workspace!.id, true)
    try {
      await goToCheckout(null, { termsVersion: terms.termsVersion, privacyVersion: terms.privacyVersion })
    } catch (e) {
      setBusy(false)
      // Changed while the step was open: the new links load, and the owner reads them and starts again.
      if ((e as { code?: string }).code === 'terms_changed') {
        onTermsChanged()
        setError(t('onboarding.activate.termsChanged'))
      } else setError(t('auth.checkout.startFailed'))
    }
  }
  useStepKeys({ onEnter: () => void start(), onEscape: onBack })
  const button = trial ? t('onboarding.activate.startTrial') : t('onboarding.activate.startPlan')

  return (
    <>
      <div className="ob-body">
        <h1>{trial ? t('onboarding.activate.title') : t('onboarding.activate.titleNoTrial')}</h1>
        <p className="ob-lede">
          {trial
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
        <div className="ob-activate-plan">
          <b>{plan}</b>
          <span>
            {t('onboarding.activate.includes', { minutes: a.includedMinutes, perMinute })}
            {trial ? ` ${t('onboarding.activate.trialFree', { days: a.trialDays })}` : ''}
          </span>
        </div>
        <ol className="ob-timeline" aria-label={t('onboarding.activate.timelineLabel')}>
          {timeline.map(entry => (
            <TimelineRow key={`${entry.kind}-${entry.day}`} entry={entry} plan={usd(a.planCents)} />
          ))}
        </ol>
        {trial && (
          <p className="ob-activate-note">
            <Icon name="mail" size={14} />
            <span>
              {t('onboarding.activate.reminderPromise', {
                count: a.reminderDays.length,
                date: format.date(firstCharge.at, { dateStyle: 'long' }),
              })}
            </span>
          </p>
        )}
        {a.recharge && (
          <p className="ob-activate-fine">
            {t(trial ? 'onboarding.activate.rechargeTrial' : 'onboarding.activate.rechargePlan', {
              recharge: usd(a.recharge.amountCents),
              threshold: usd(a.recharge.thresholdCents),
              cap: usd(a.recharge.capCents),
            })}
          </p>
        )}
        {error && <Note tone="danger">{error}</Note>}
        {terms ? (
          <p className="ob-activate-fine">
            <T
              k={trial ? 'onboarding.activate.terms' : 'onboarding.activate.termsPlan'}
              values={{
                terms: chunks => <ExternalLink href={terms.termsUrl}>{chunks}</ExternalLink>,
                privacy: chunks => <ExternalLink href={terms.privacyUrl}>{chunks}</ExternalLink>,
              }}
            />
          </p>
        ) : (
          <Note tone="danger">{t('auth.checkout.startFailed')}</Note>
        )}
      </div>
      <Foot
        onBack={onBack}
        onContinue={() => void start()}
        canContinue={Boolean(terms)}
        busy={busy}
        label={button}
        hint={t('onboarding.activate.cardHint')}
      />
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

function TimelineRow({ entry, plan }: { entry: TimelineEntry; plan: string }) {
  const t = useT()
  const format = useFormat()
  const date = format.date(entry.at, { month: 'short', day: 'numeric' })
  const when =
    entry.day === 0 ? t('onboarding.activate.today', { date }) : t('onboarding.activate.day', { day: entry.day, date })
  const what =
    entry.kind === 'start'
      ? t('onboarding.activate.stepStart')
      : entry.kind === 'reminder'
        ? t('onboarding.activate.stepReminder')
        : entry.day === 0
          ? t('onboarding.activate.stepChargeToday', { plan })
          : t('onboarding.activate.stepCharge', { plan })
  const detail =
    entry.kind === 'start'
      ? t('onboarding.activate.stepStartDetail')
      : entry.kind === 'reminder'
        ? t('onboarding.activate.stepReminderDetail')
        : entry.day === 0
          ? t('onboarding.activate.stepChargeTodayDetail')
          : t('onboarding.activate.stepChargeDetail')
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
