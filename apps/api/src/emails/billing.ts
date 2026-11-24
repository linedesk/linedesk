// The bill owner's billing emails: a failed auto-recharge, the monthly recharge cap
// reached, a low balance with auto-recharge off, and the trial ending in three days. Each is sent once per occasion (a `billing_alerts` row, made in
// the transaction that queued it; call-billing.ts). Every word comes from packages/i18n/locales/en/email.json.
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
import { trialStartUrl } from '../trial-link.ts'
import { BILLING_PATH } from './billing-lifecycle.ts'
import { type Block, linkedText, type RenderedEmail, renderEmail, siteHost } from './layout.ts'
import { appLink, type EmailLocale, emailSafeName, WEB_ORIGIN } from './templates.ts'

export type BillingOwnerEmail =
  /** `invoiceUrl`: the invoice's own page, where the owner confirms the payment (3DS); null when it was voided. */
  (
    | { kind: 'recharge_failed'; amountCents: number; invoiceUrl: string | null }
    /** `rechargedCents`: this UTC month's recharges the cap counts; `minimumCents`: the smallest recharge. */
    | { kind: 'recharge_cap_reached'; capCents: number; rechargedCents: number; minimumCents: number }
    | { kind: 'low_balance'; balanceMicros: number }
    /**
     * A trial reminder, `daysBefore` the trial's end (7 and 1 by default), and the trial's confirmation
     * when it starts (`trial_started`, with the days the reminders go out): the plan's charge then (the plan only:
     * nothing else is charged at the trial's end), its date and how to cancel. `workspaceId`: the bill's oldest
     * workspace, whose Settings › Billing the buttons open (cancel is there); null: no buttons.
     */
    | (TrialFacts & { kind: 'trial_will_end'; daysBefore: number })
    | (TrialFacts & { kind: 'trial_started'; reminderDays: number[] })
    /**
     * The one "one step left" email to a sign-up that has not started its trial (ACTIVATION_NUDGE_DAYS
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
    /**
     * The trial prompt: most of the trial's included minutes used (`trial_minutes_low`), or all of them
     * with calls answered on the trial grace (`trial_minutes_used`). The purchase "Keep calls answered" makes
     * (`amountCents` on `card`; null: the card could not be read), the automatic top-up below `thresholdCents`, the
     * trial's end (`freeUntil`) and the Standard price of a minute. `workspaceId`: the button's workspace.
     */
    | (TrialMinutesFacts & { kind: 'trial_minutes_low' })
    | (TrialMinutesFacts & { kind: 'trial_minutes_used' })
    /**
     * `callers` of `workspace` heard a busy line on `day` (YYYY-MM-DD, the workspace's day) because its `limit` calls
     * at the same time were in use (LIN-450). `next`: what the owner can do: add `step` more for `stepCents` a month
     * (`add`), once the plan is paid (`after_trial`), or nothing (`none`). `partnerBill`: the button opens
     * Partner › Billing instead of the workspace's Settings › Billing.
     */
    | {
        kind: 'busy_line'
        workspaceId: string
        workspace: string
        day: string
        callers: number
        limit: number
        next: 'add' | 'after_trial' | 'none'
        step: number
        stepCents: number
        partnerBill: boolean
      }
  ) & {
    /** How far below zero calls go on (the install's rules). */
    bufferMicros: number
  }

/**
 * What the minutes prompt's emails say (`BillingOwnerEmail`, `trial_minutes_low` and `trial_minutes_used`). `paid`: a
 * paid plan's month with auto-recharge off (the low email only), not the trial.
 */
type TrialMinutesFacts = {
  paid?: boolean
  usedMinutes: number
  includedMinutes: number
  amountCents: number
  thresholdCents: number
  card: { brand: string | null; last4: string | null } | null
  freeUntil: string | null
  standardMicrosPerMinute: number
  workspaceId: string | null
}

/** What both trial emails say about the trial's end. */
type TrialFacts = {
  planCents: number
  interval: 'month' | 'year'
  trialEnd: string
  workspaceId: string | null
}

export function billingOwnerEmail(email: BillingOwnerEmail, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  if (email.kind === 'trial_will_end' || email.kind === 'trial_started') return trialEmail(email, origin, locale)
  if (email.kind === 'activation_nudge') return activationNudgeEmail(email, origin, locale)
  if (email.kind === 'trial_minutes_low' || email.kind === 'trial_minutes_used')
    return trialMinutesEmail(email, origin, locale)
  if (email.kind === 'busy_line') return busyLineEmail(email, origin, locale)
  return balanceEmail(email, origin, locale)
}

/** Settings › Billing opens the "add calls at the same time" dialog for the workspace (`?addCalls=1`, the busy-line email). */
export const ADD_CALLS_PARAM = 'addCalls'

/** Settings › Billing with the cancel dialog open: the reminders' one direct way to cancel (after signing in). */
export const CANCEL_PATH = `${BILLING_PATH}?cancel=1`

function balanceEmail(
  email: Exclude<
    BillingOwnerEmail,
    {
      kind:
        | 'trial_will_end'
        | 'trial_started'
        | 'activation_nudge'
        | 'trial_minutes_low'
        | 'trial_minutes_used'
        | 'busy_line'
    }
  >,
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
 * The trial's emails: its confirmation when it starts, and a reminder on each reminder day before it
 * ends. Both say the first charge's date and amount (the plan only), and how to cancel before: a button to
 * Settings › Billing and one that opens the cancel dialog there.
 */
function trialEmail(
  email: Extract<BillingOwnerEmail, { kind: 'trial_will_end' | 'trial_started' }>,
  origin: string,
  locale?: EmailLocale,
): RenderedEmail {
  const translator = getT(locale)
  const { t, format, locale: lang } = translator
  const usd = (cents: number) => format.currency(cents / 100, 'USD')
  const values = {
    brand: brandName(),
    date: format.dateTime(new Date(email.trialEnd), { dateStyle: 'long', timeZone: 'UTC' }),
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
  // Each fact once (LIN-780): the date and amount only in the facts below, so the reminder has no lede that repeats
  // them; the confirmation keeps its own (nothing is charged today).
  const lead = started ? t('email.billing.trialStarted.lede') : null
  const cancel = t('email.billing.trialWillEnd.cancel', values)
  // "Settings › Billing" is a link to the page wherever the email names it.
  const billing = email.workspaceId ? appLink(origin, email.workspaceId, BILLING_PATH) : null
  const blocks: Block[] = [
    ...(lead ? [{ kind: 'text' as const, text: lead }] : []),
    {
      kind: 'facts',
      rows: [
        [t('email.billing.trial.firstCharge'), values.date],
        [
          t('email.billing.trial.amount'),
          t('email.billing.trial.amountThen', { price: usd(email.planCents), interval: email.interval }),
        ],
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
    linkedText(translator, 'email.billing.trialWillEnd.balance', billing),
    { kind: 'text', text: cancel },
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
    preheader: lead ?? cancel,
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
  // The trial link (trial-link.ts): the app opens the Start your free trial dialog at once, over the setup.
  if (email.workspaceId)
    blocks.push({
      kind: 'button',
      label: trial ? t('email.billing.activationNudge.button') : t('email.billing.activationNudge.buttonPlan'),
      url: trialStartUrl(origin, email.workspaceId),
    })
  blocks.push({ kind: 'text', text: t('email.billing.activationNudge.deleted', values) })
  return renderEmail({
    locale: lang,
    subject,
    preheader: lead,
    eyebrow: t('email.billing.activationNudge.eyebrow'),
    heading: subject,
    blocks,
    reason: t('email.billing.activationNudge.reason', { site: siteHost(origin) }),
    origin,
  })
}

/**
 * The trial prompt, short: the minutes used (or used up, calls answered for a short time), the one
 * purchase that keeps every call answered with the saved card and the automatic top-up after it, until when the plan
 * stays free and what a minute costs. The button opens the app's inbox, where the banner has "Keep calls answered".
 */
function trialMinutesEmail(
  email: Extract<BillingOwnerEmail, { kind: 'trial_minutes_low' | 'trial_minutes_used' }>,
  origin: string,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  // Whole dollars without cents ("$25"), as the prompt says it.
  const usd = (cents: number) =>
    format.currency(cents / 100, 'USD', cents % 100 === 0 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {})
  const card =
    email.card?.brand && email.card.last4
      ? t('email.billing.trialMinutes.card', {
          brand: email.card.brand.charAt(0).toUpperCase() + email.card.brand.slice(1),
          last4: email.card.last4,
        })
      : t('email.billing.trialMinutes.cardUnknown')
  const values = {
    used: email.usedMinutes,
    included: email.includedMinutes,
    left: Math.max(0, email.includedMinutes - email.usedMinutes),
    amount: usd(email.amountCents),
    card,
    threshold: usd(email.thresholdCents),
    date: email.freeUntil ? format.dateTime(new Date(email.freeUntil), { dateStyle: 'long', timeZone: 'UTC' }) : '',
    rate: format.rate(email.standardMicrosPerMinute / 1_000_000, 'USD'),
  }
  const usedUp = email.kind === 'trial_minutes_used'
  const subject = usedUp
    ? t('email.billing.trialMinutesUsed.subject', values)
    : email.paid
      ? t('email.billing.planMinutesLow.subject', values)
      : t('email.billing.trialMinutesLow.subject', values)
  const lead = usedUp
    ? t('email.billing.trialMinutesUsed.text', values)
    : email.paid
      ? t('email.billing.planMinutesLow.text', values)
      : t('email.billing.trialMinutesLow.text', values)
  const blocks: Block[] = [
    { kind: 'text', text: lead },
    { kind: 'text', text: t('email.billing.trialMinutes.keep', values) },
    ...(values.date ? [{ kind: 'text' as const, text: t('email.billing.trialMinutes.free', values) }] : []),
  ]
  if (email.workspaceId)
    blocks.push({
      kind: 'button',
      label: t('email.billing.trialMinutes.button'),
      // The app's inbox, under the banner that has the button (the banner is not shown in the settings).
      url: appLink(origin, email.workspaceId, 'calls'),
    })
  return renderEmail({
    locale: lang,
    subject,
    preheader: lead,
    eyebrow: email.paid ? t('email.billing.planMinutes.eyebrow') : t('email.billing.trialMinutes.eyebrow'),
    heading: subject,
    blocks,
    reason: t('email.billing.reason', { site: siteHost(origin) }),
    origin,
  })
}

/**
 * The busy-line notice (LIN-450), at most once per workspace and day: all its calls at the same time were in use, so a
 * caller heard that the business will call back, and the call is in the inbox as missed. Says how to add more when the
 * owner can (the button opens Settings › Billing), or that it can be done once the plan is paid.
 */
function busyLineEmail(
  email: Extract<BillingOwnerEmail, { kind: 'busy_line' }>,
  origin: string,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  const values = {
    workspace: emailSafeName(email.workspace, t('email.fallback.yourBusiness')),
    count: email.limit,
    callers: email.callers,
    step: email.step,
    price: format.currency(
      email.stepCents / 100,
      'USD',
      email.stepCents % 100 === 0 ? { minimumFractionDigits: 0 } : {},
    ),
    // The workspace's own day, written as a date (noon UTC never crosses a day boundary).
    date: format.dateTime(new Date(`${email.day}T12:00:00Z`), { dateStyle: 'long', timeZone: 'UTC' }),
  }
  const subject = t('email.billing.busyLine.subject', values)
  const lead = t('email.billing.busyLine.text', values)
  const blocks: Block[] = [{ kind: 'text', text: lead }]
  if (email.next === 'add') blocks.push({ kind: 'text', text: t('email.billing.busyLine.add', values) })
  if (email.next === 'after_trial') blocks.push({ kind: 'text', text: t('email.billing.busyLine.afterTrial', values) })
  if (email.next === 'add')
    blocks.push({
      kind: 'button',
      label: t('email.billing.busyLine.button', values),
      // Settings › Billing with the "add calls" dialog open for this workspace (a partner bill: Partner › Billing).
      url: email.partnerBill
        ? `${origin}/#partner/billing`
        : appLink(origin, email.workspaceId, `${BILLING_PATH}?${ADD_CALLS_PARAM}=1`),
    })
  blocks.push({ kind: 'text', text: t('email.billing.busyLine.once'), tone: 'muted' })
  return renderEmail({
    locale: lang,
    subject,
    preheader: lead,
    eyebrow: t('email.billing.eyebrow'),
    heading: subject,
    blocks,
    reason: t('email.billing.reason', { site: siteHost(origin) }),
    origin,
  })
}
