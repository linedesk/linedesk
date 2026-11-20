// The bill owner's emails about the bill's life: an extra number whose month could
// not be paid, the yearly renewal reminder, dunning (suspended, the reminders, canceled, numbers released) and a
// port-out request. Each is sent once per occasion (a `billing_alerts`
// row made in the transaction that queued it; billing-periods.ts, billing-lifecycle.ts). Also the note that someone
// else who manages the bill (an owner or admin of its only workspace, bill-manager.ts) changed it. Every word comes
// from packages/i18n/locales/en/email.json.
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
import { type Block, type RenderedEmail, renderEmail, siteHost } from './layout.ts'
import { appLink, deletedWhen, type EmailLocale, WEB_ORIGIN } from './templates.ts'

/** Settings › Billing in the web app (built by the billing UI PR): where the owner pays, cancels and sees the bill. */
export const BILLING_PATH = 'workspace/billing'

/** One line of what a yearly renewal charges: a plan item (seats or the partner base) with its price per unit. */
export type RenewalLine = { item: 'seats' | 'partner' | 'extraCalls'; quantity: number; unitCents: number }

export type LifecycleEmail =
  | { kind: 'number_unpaid'; e164: string; priceCents: number; releaseAt: string }
  | {
      kind: 'renewal_reminder'
      renewsAt: string
      lines: RenewalLine[]
      /** Auto-recharge on: the threshold and amount it charges; null when it is off. */
      autoRecharge: { thresholdCents: number; amountCents: number } | null
    }
  /** The plan fee is unpaid: calls get the fixed line from now on; the plan is canceled on `cancelAt` unless paid. */
  | { kind: 'suspended'; cancelAt: string }
  /** Day 14 and 21 of an unpaid plan fee, still suspended. */
  | { kind: 'dunning_reminder'; cancelAt: string }
  /** The plan was canceled: the numbers are kept until `releaseAt` (port-out), the data until `dataUntil` (export). */
  | { kind: 'canceled'; releaseAt: string; dataUntil: string }
  /** 30 days after the cancellation: the numbers were released. */
  | { kind: 'numbers_released'; numbers: string[]; dataUntil: string }
  /** A port-out of one of the bill's numbers was requested at another carrier (recorded by an instance admin). */
  | { kind: 'port_out_requested'; e164: string }

/** The camel-case key of each email under `email.billing.*`. */
const KEYS = {
  number_unpaid: 'numberUnpaid',
  renewal_reminder: 'renewalReminder',
  suspended: 'suspended',
  dunning_reminder: 'dunningReminder',
  canceled: 'canceled',
  numbers_released: 'numbersReleased',
  port_out_requested: 'portOutRequested',
} as const satisfies Record<LifecycleEmail['kind'], string>

export function billingLifecycleEmail(
  email: LifecycleEmail,
  workspaceId: string,
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  const usd = (cents: number) => format.currency(cents / 100, 'USD')
  const day = (at: string) => format.dateTime(new Date(at), { dateStyle: 'long', timeZone: 'UTC' })
  const key = KEYS[email.kind]
  const brand = brandName()
  const values: Record<string, string> = { brand }
  const blocks: Block[] = []
  if (email.kind === 'number_unpaid') {
    Object.assign(values, { number: email.e164, price: usd(email.priceCents), date: day(email.releaseAt) })
    blocks.push({ kind: 'text', text: t('email.billing.numberUnpaid.text', values) })
    blocks.push({ kind: 'text', text: t('email.billing.numberUnpaid.effect', values) })
  } else if (email.kind === 'renewal_reminder') {
    const total = email.lines.reduce((sum, l) => sum + l.quantity * l.unitCents, 0)
    Object.assign(values, { date: day(email.renewsAt), total: usd(total) })
    blocks.push({ kind: 'text', text: t('email.billing.renewalReminder.text', values) })
    blocks.push({
      kind: 'facts',
      rows: email.lines.map((l): [string, string] => [
        // i18n-dynamic: email.billing.renewalReminder.item.*
        t(`email.billing.renewalReminder.item.${l.item}`, { count: l.quantity }),
        t('email.billing.renewalReminder.line', {
          quantity: l.quantity,
          price: usd(l.unitCents),
          amount: usd(l.quantity * l.unitCents),
        }),
      ]),
    })
    blocks.push({
      kind: 'text',
      text: email.autoRecharge
        ? t('email.billing.renewalReminder.autoRechargeOn', {
            threshold: usd(email.autoRecharge.thresholdCents),
            amount: usd(email.autoRecharge.amountCents),
          })
        : t('email.billing.renewalReminder.autoRechargeOff'),
    })
    blocks.push({ kind: 'text', tone: 'muted', text: t('email.billing.renewalReminder.cancel', values) })
  } else if (email.kind === 'suspended' || email.kind === 'dunning_reminder') {
    Object.assign(values, { date: day(email.cancelAt) })
    // i18n-dynamic: email.billing.suspended.*, email.billing.dunningReminder.*
    blocks.push({ kind: 'text', text: t(`email.billing.${key}.text`, values) })
    blocks.push({ kind: 'text', text: t('email.billing.suspended.effect', values) })
  } else if (email.kind === 'canceled') {
    Object.assign(values, { date: day(email.releaseAt), dataDate: day(email.dataUntil) })
    blocks.push({ kind: 'text', text: t('email.billing.canceled.text', values) })
    blocks.push({ kind: 'text', text: t('email.billing.canceled.numbers', values) })
    blocks.push({ kind: 'text', text: t('email.billing.canceled.data', values) })
  } else if (email.kind === 'numbers_released') {
    Object.assign(values, { dataDate: day(email.dataUntil), count: String(email.numbers.length) })
    blocks.push({ kind: 'text', text: t('email.billing.numbersReleased.text', { count: email.numbers.length }) })
    blocks.push({ kind: 'list', title: t('email.billing.numbersReleased.list'), items: email.numbers })
    blocks.push({ kind: 'text', text: t('email.billing.canceled.data', values) })
  } else {
    Object.assign(values, { number: email.e164 })
    blocks.push({ kind: 'text', text: t('email.billing.portOutRequested.text', values) })
    blocks.push({ kind: 'text', tone: 'muted', text: t('email.billing.portOutRequested.notYou', values) })
  }
  // The emails about something the owner must act on soon carry the urgent badge.
  const urgent =
    email.kind === 'number_unpaid'
      ? t('email.billing.numberUnpaid.urgent')
      : email.kind === 'suspended' || email.kind === 'dunning_reminder'
        ? t('email.billing.suspended.urgent')
        : email.kind === 'canceled'
          ? t('email.billing.canceled.urgent')
          : email.kind === 'port_out_requested'
            ? t('email.billing.portOutRequested.urgent')
            : null
  // i18n-dynamic: email.billing.*
  const subject = t(`email.billing.${key}.subject`, values)
  // i18n-dynamic: email.billing.*
  blocks.push({
    kind: 'button',
    label: t(`email.billing.${key}.button`),
    url: appLink(origin, workspaceId, BILLING_PATH),
  })
  return renderEmail({
    locale: lang,
    subject,
    preheader: blocks[0]?.kind === 'text' ? blocks[0].text : subject,
    eyebrow: t('email.billing.eyebrow'),
    ...(urgent ? { urgent } : {}),
    heading: subject,
    blocks,
    reason: t('email.billing.reason', { site: siteHost(origin) }),
    origin,
  })
}

/**
 * What someone who manages the bill but does not own it did (bill-manager.ts, decision of 2026-11-17): the plan
 * canceled or resumed, the extra calls at the same time changed, or a new card made the one the bill is charged to.
 */
export type ManagerChange =
  | { change: 'cancel'; endsAt: string | null }
  | { change: 'resume' }
  | { change: 'extraCalls'; from: number; to: number }
  /** Monthly or yearly switched in the free trial (`billing.setInterval`): what the plan is paid by from now on. */
  | { change: 'interval'; to: 'month' | 'year' }
  | { change: 'paymentMethod'; card: { brand: string | null; last4: string | null } | null }

/** The bill owner's note about a change by someone else who manages the bill, as the job queues it. */
export type ManagerChangedEmail = { kind: 'manager_changed'; actorId: string; at: string } & ManagerChange

/** The note as rendered: who (name and address), on which workspace, when in the workspace's time zone. */
export type ManagerChangedView = ManagerChange & {
  /** Who: their name ("Mike Brennan") and address; both null when the account is gone. */
  name: string | null
  email: string | null
  workspace: string | null
  at: string
  timeZone: string | null
}

export function managerChangedEmail(
  view: ManagerChangedView,
  workspaceId: string,
  origin = WEB_ORIGIN,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  const who = view.name || view.email || t('email.fallback.workspaceAdmin')
  const by = view.name && view.email ? `${view.name} (${view.email})` : who
  const workspace = view.workspace || t('email.fallback.workspace')
  const values = { who, by, workspace, when: deletedWhen(view.at, view.timeZone, locale) }
  // i18n-dynamic: email.billing.managerChanged.subject.*
  const subject = t(`email.billing.managerChanged.subject.${view.change}`, values)
  const blocks: Block[] = [{ kind: 'text', text: t('email.billing.managerChanged.text', values) }]
  if (view.change === 'cancel')
    blocks.push({
      kind: 'text',
      text: view.endsAt
        ? t('email.billing.managerChanged.cancel', {
            date: format.dateTime(new Date(view.endsAt), { dateStyle: 'long', timeZone: 'UTC' }),
          })
        : t('email.billing.managerChanged.cancelNoDate'),
    })
  else if (view.change === 'resume') blocks.push({ kind: 'text', text: t('email.billing.managerChanged.resume') })
  else if (view.change === 'extraCalls')
    blocks.push({
      kind: 'text',
      text: t('email.billing.managerChanged.extraCalls', { from: String(view.from), to: String(view.to) }),
    })
  else if (view.change === 'interval')
    blocks.push({
      kind: 'text',
      text:
        view.to === 'month'
          ? t('email.billing.managerChanged.intervalMonth')
          : t('email.billing.managerChanged.intervalYear'),
    })
  else
    blocks.push({
      kind: 'text',
      text:
        view.card?.last4 && view.card.brand
          ? t('email.billing.managerChanged.card', {
              brand: view.card.brand.charAt(0).toUpperCase() + view.card.brand.slice(1),
              last4: view.card.last4,
            })
          : t('email.billing.managerChanged.cardUnknown'),
    })
  blocks.push({ kind: 'text', tone: 'muted', text: t('email.billing.managerChanged.notExpected', values) })
  blocks.push({
    kind: 'button',
    label: t('email.billing.managerChanged.button'),
    url: appLink(origin, workspaceId, BILLING_PATH),
  })
  return renderEmail({
    locale: lang,
    subject,
    preheader: blocks[0]?.kind === 'text' ? blocks[0].text : subject,
    eyebrow: t('email.billing.eyebrow'),
    heading: subject,
    blocks,
    reason: t('email.billing.reason', { site: siteHost(origin) }),
    origin,
  })
}
