// The bill owner's billing emails (docs/billing.md §3.2, §3.4, §4.3): a failed auto-recharge, the monthly recharge cap
// reached, a low balance with auto-recharge off, and the trial ending in three days. Each is sent once per occasion (a `billing_alerts` row, made in
// the transaction that queued it; call-billing.ts). Every word comes from packages/i18n/locales/en/email.json.
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
import { type Block, type RenderedEmail, renderEmail, siteHost } from './layout.ts'
import { BILLING_PATH } from './billing-lifecycle.ts'
import { appLink, type EmailLocale, WEB_ORIGIN } from './templates.ts'

export type BillingOwnerEmail =
  /** `invoiceUrl`: the invoice's own page, where the owner confirms the payment (3DS); null when it was voided. */
  (
    | { kind: 'recharge_failed'; amountCents: number; invoiceUrl: string | null }
    /** `rechargedCents`: this UTC month's recharges the cap counts; `minimumCents`: the smallest recharge. */
    | { kind: 'recharge_cap_reached'; capCents: number; rechargedCents: number; minimumCents: number }
    | { kind: 'low_balance'; balanceMicros: number }
    /**
     * The trial ends in three days (§3.2 step 8): the plan's charge then, its date, the first recharge with it (null
     * when auto-recharge is off) and how to cancel. `workspaceId`: the bill's oldest workspace, whose Settings ›
     * Billing the button opens (cancel is there); null: no button.
     */
    | {
        kind: 'trial_will_end'
        planCents: number
        trialEnd: string
        rechargeCents: number | null
        workspaceId: string | null
      }
  ) & {
    /** How far below zero calls go on (the install's rules). */
    bufferMicros: number
  }

export function billingOwnerEmail(email: BillingOwnerEmail, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  if (email.kind === 'trial_will_end') return trialWillEndEmail(email, origin, locale)
  return balanceEmail(email, origin, locale)
}

function balanceEmail(
  email: Exclude<BillingOwnerEmail, { kind: 'trial_will_end' }>,
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

/** Three days before the trial ends: what is charged when, and how to cancel before (§3.2 step 8). */
function trialWillEndEmail(
  email: Extract<BillingOwnerEmail, { kind: 'trial_will_end' }>,
  origin: string,
  locale?: EmailLocale,
): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  const usd = (cents: number) => format.currency(cents / 100, 'USD')
  const values = {
    brand: brandName(),
    plan: usd(email.planCents),
    date: format.dateTime(new Date(email.trialEnd), { dateStyle: 'long', timeZone: 'UTC' }),
    recharge: email.rechargeCents === null ? '' : usd(email.rechargeCents),
  }
  const subject = t('email.billing.trialWillEnd.subject', values)
  const blocks: Block[] = [
    { kind: 'text', text: t('email.billing.trialWillEnd.text', values) },
    {
      kind: 'text',
      text:
        email.rechargeCents === null
          ? t('email.billing.trialWillEnd.noRecharge', values)
          : t('email.billing.trialWillEnd.recharge', values),
    },
    { kind: 'text', text: t('email.billing.trialWillEnd.cancel', values) },
  ]
  // The cancel link: Settings › Billing, where the plan is canceled in two clicks (the portal has no cancel).
  if (email.workspaceId)
    blocks.push({
      kind: 'button',
      label: t('email.billing.trialWillEnd.button'),
      url: appLink(origin, email.workspaceId, BILLING_PATH),
    })
  return renderEmail({
    locale: lang,
    subject,
    preheader: t('email.billing.trialWillEnd.text', values),
    eyebrow: t('email.billing.eyebrow'),
    heading: subject,
    blocks,
    reason: t('email.billing.reason', { site: siteHost(origin) }),
    origin,
  })
}
