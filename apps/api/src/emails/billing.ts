// The bill owner's billing emails (docs/billing.md §3.2, §3.4, §4.3): a failed auto-recharge, the monthly recharge cap
// reached, a low balance with auto-recharge off, and the trial ending in three days. Each is sent once per occasion (a `billing_alerts` row, made in
// the transaction that queued it; call-billing.ts). Every word comes from packages/i18n/locales/en/email.json.
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
import { type Block, type RenderedEmail, renderEmail, siteHost } from './layout.ts'
import { BILLING_PATH } from './billing-lifecycle.ts'
import { appLink, type EmailLocale, emailSafeName, WEB_ORIGIN } from './templates.ts'

export type BillingOwnerEmail =
  /** `invoiceUrl`: the invoice's own page, where the owner confirms the payment (3DS); null when it was voided. */
  (
    | { kind: 'recharge_failed'; amountCents: number; invoiceUrl: string | null }
    /** `rechargedCents`: this UTC month's recharges the cap counts; `minimumCents`: the smallest recharge. */
    | { kind: 'recharge_cap_reached'; capCents: number; rechargedCents: number; minimumCents: number }
    | { kind: 'low_balance'; balanceMicros: number }
    /**
     * A trial reminder (§3.2 step 8), `daysBefore` the trial's end (7 and 1 by default), and the trial's confirmation
     * when it starts (`trial_started`, with the days the reminders go out): the plan's charge then, its date, the
     * first recharge with it (null when auto-recharge is off) and how to cancel. `workspaceId`: the bill's oldest
     * workspace, whose Settings › Billing the buttons open (cancel is there); null: no buttons.
     */
    | (TrialFacts & { kind: 'trial_will_end'; daysBefore: number })
    | (TrialFacts & { kind: 'trial_started'; reminderDays: number[] })
    /**
     * The one "one step left" email to a sign-up that has not started its trial (§3.2 step 2, ACTIVATION_NUDGE_DAYS
     * after sign-up): what it set up, that nothing is charged when it starts, and the day the sign-up is deleted
     * (`deleteOn`, the sign-up sweep). `trialDays`: null when the install gives no trial. `workspaceId`: the button's
     * workspace; null: no button.
     */
    | {
        kind: 'activation_nudge'
        workspaceId: string | null
        workspace: string | null
        assistant: string | null
        trialDays: number | null
        deleteOn: string
      }
  ) & {
    /** How far below zero calls go on (the install's rules). */
    bufferMicros: number
  }

/** What both trial emails say about the trial's end. */
type TrialFacts = {
  planCents: number
  interval: 'month' | 'year'
  trialEnd: string
  rechargeCents: number | null
  workspaceId: string | null
}

export function billingOwnerEmail(email: BillingOwnerEmail, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  if (email.kind === 'trial_will_end' || email.kind === 'trial_started') return trialEmail(email, origin, locale)
  if (email.kind === 'activation_nudge') return activationNudgeEmail(email, origin, locale)
  return balanceEmail(email, origin, locale)
}

/** Settings › Billing with the cancel dialog open: the reminders' one direct way to cancel (after signing in). */
export const CANCEL_PATH = `${BILLING_PATH}?cancel=1`

function balanceEmail(
  email: Exclude<BillingOwnerEmail, { kind: 'trial_will_end' | 'trial_started' | 'activation_nudge' }>,
  origin: string,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  const usd = (cents: number) => format.currency(cents / 100, 'USD')
  const key = (
    { recharge_failed: 'rechargeFailed', recharge_cap_reached: 'capReached', low_balance: 'lowBalance' } as const
  )[email.kind]
  const values = {
    brand: brandName(),
    amount: email.kind === 'recharge_failed' ? usd(email.amountCents) : '',
    cap: email.kind === 'recharge_cap_reached' ? usd(email.capCents) : '',
    recharged: email.kind === 'recharge_cap_reached' ? usd(email.rechargedCents) : '',
    minimum: email.kind === 'recharge_cap_reached' ? usd(email.minimumCents) : '',
    balance: email.kind === 'low_balance' ? usd(Math.floor(email.balanceMicros / 10_000)) : '',
    buffer: usd(Math.floor(email.bufferMicros / 10_000)),
  }
  // i18n-dynamic: email.billing.*
  const subject = t(`email.billing.${key}.subject`, values)
  const blocks: Block[] = [
    { kind: 'text', text: t(`email.billing.${key}.text`, values) },
    // What the cap counted this month, so the email never claims the whole cap was recharged (billing review B7).
    ...(email.kind === 'recharge_cap_reached'
      ? [{ kind: 'text' as const, text: t('email.billing.capReached.recharged', values) }]
      : []),
    { kind: 'text', text: t(`email.billing.${key}.effect`, values) },
  ]
  if (email.kind === 'recharge_failed' && email.invoiceUrl)
    blocks.push({ kind: 'button', label: t('email.billing.rechargeFailed.pay'), url: email.invoiceUrl })
  return renderEmail({
    locale: lang,
    subject,
    preheader: t(`email.billing.${key}.text`, values),
    eyebrow: t('email.billing.eyebrow'),
    ...(key === 'lowBalance' ? {} : { urgent: t(`email.billing.${key}.urgent`) }),
    heading: subject,
    blocks,
    reason: t('email.billing.reason', { site: siteHost(origin) }),
    origin,
  })
}

/**
 * The trial's emails (§3.2 step 8): its confirmation when it starts, and a reminder on each reminder day before it
 * ends. Both say the first charge's date and amount, the first recharge with it, and how to cancel before: a button to
 * Settings › Billing and one that opens the cancel dialog there.
 */
function trialEmail(
  email: Extract<BillingOwnerEmail, { kind: 'trial_will_end' | 'trial_started' }>,
  origin: string,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  const usd = (cents: number) => format.currency(cents / 100, 'USD')
  const price = usd(email.planCents)
  const values = {
    brand: brandName(),
    plan:
      email.interval === 'year'
        ? t('email.billing.trial.planYearly', { price })
        : t('email.billing.trial.planMonthly', { price }),
    date: format.dateTime(new Date(email.trialEnd), { dateStyle: 'long', timeZone: 'UTC' }),
    recharge: email.rechargeCents === null ? '' : usd(email.rechargeCents),
  }
  const started = email.kind === 'trial_started'
  const reminders =
    started && email.reminderDays.length
      ? new Intl.ListFormat(lang, { type: 'conjunction' }).format(
          email.reminderDays.map(count => t('email.billing.trial.reminderDay', { count })),
        )
      : null
  const subject = started
    ? t('email.billing.trialStarted.subject', values)
    : t('email.billing.trialWillEnd.subject', { ...values, days: email.daysBefore })
  const lead = started ? t('email.billing.trialStarted.text', values) : t('email.billing.trialWillEnd.text', values)
  const blocks: Block[] = [
    { kind: 'text', text: lead },
    {
      kind: 'facts',
      rows: [
        [t('email.billing.trial.firstCharge'), values.date],
        [t('email.billing.trial.amount'), t('email.billing.trial.amountValue', values)],
        ...(reminders
          ? [
              [t('email.billing.trial.reminders'), t('email.billing.trial.remindersValue', { days: reminders })] as [
                string,
                string,
              ],
            ]
          : []),
      ],
    },
    {
      kind: 'text',
      text:
        email.rechargeCents === null
          ? t('email.billing.trialWillEnd.noRecharge', values)
          : t('email.billing.trialWillEnd.recharge', values),
    },
    { kind: 'text', text: t('email.billing.trialWillEnd.cancel', values) },
  ]
  // Settings › Billing, and the cancel dialog there: the plan is canceled in two clicks (the portal has no cancel).
  if (email.workspaceId)
    blocks.push({
      kind: 'button',
      label: t('email.billing.trial.manage'),
      url: appLink(origin, email.workspaceId, BILLING_PATH),
      second: { label: t('email.billing.trial.cancel'), url: appLink(origin, email.workspaceId, CANCEL_PATH) },
    })
  return renderEmail({
    locale: lang,
    subject,
    preheader: lead,
    eyebrow: t('email.billing.eyebrow'),
    heading: subject,
    blocks,
    reason: started
      ? t('email.billing.reason', { site: siteHost(origin) })
      : t('email.billing.trialWillEnd.reason', { site: siteHost(origin) }),
    origin,
  })
}

/**
 * Day 3 of a sign-up that has not started its trial: one step is left (the activate step, with the card at Stripe
 * Checkout). Says that nothing is charged when the trial starts and when the sign-up is deleted if it never does.
 */
function activationNudgeEmail(
  email: Extract<BillingOwnerEmail, { kind: 'activation_nudge' }>,
  origin: string,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  const trial = email.trialDays !== null
  const values = {
    brand: brandName(),
    workspace: emailSafeName(email.workspace, t('email.fallback.yourBusiness')),
    assistant: emailSafeName(email.assistant, t('email.fallback.assistant')),
    days: email.trialDays ?? 0,
    date: format.dateTime(new Date(email.deleteOn), { dateStyle: 'long', timeZone: 'UTC' }),
  }
  const subject = trial
    ? t('email.billing.activationNudge.subject', values)
    : t('email.billing.activationNudge.subjectPlan', values)
  const lead = trial
    ? t('email.billing.activationNudge.text', values)
    : t('email.billing.activationNudge.textPlan', values)
  const blocks: Block[] = [{ kind: 'text', text: lead }]
  if (trial) blocks.push({ kind: 'text', text: t('email.billing.activationNudge.noCharge', values) })
  // The app opens on the onboarding where the owner left it; its last step starts the trial.
  if (email.workspaceId)
    blocks.push({
      kind: 'button',
      label: trial ? t('email.billing.activationNudge.button') : t('email.billing.activationNudge.buttonPlan'),
      url: appLink(origin, email.workspaceId, 'calls'),
    })
  blocks.push({ kind: 'text', text: t('email.billing.activationNudge.deleted', values) })
  return renderEmail({
    locale: lang,
    subject,
    preheader: lead,
    eyebrow: t('email.billing.eyebrow'),
    heading: subject,
    blocks,
    reason: t('email.billing.activationNudge.reason', { site: siteHost(origin) }),
    origin,
  })
}
