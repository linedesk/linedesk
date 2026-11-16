// The bill owner's billing emails (docs/billing.md §3.4, §4.3): a failed auto-recharge, the monthly recharge cap
// reached, and a low balance with auto-recharge off. Each is sent once per occasion (a `billing_alerts` row, made in
// the transaction that queued it; call-billing.ts). Every word comes from packages/i18n/locales/en/email.json.
import { getT } from '@linedesk/i18n/server'
import { brandName } from '../branding.ts'
import { type Block, type RenderedEmail, renderEmail, siteHost } from './layout.ts'
import { type EmailLocale, WEB_ORIGIN } from './templates.ts'

export type BillingOwnerEmail =
  /** `invoiceUrl`: the invoice's own page, where the owner confirms the payment (3DS); null when it was voided. */
  (
    | { kind: 'recharge_failed'; amountCents: number; invoiceUrl: string | null }
    | { kind: 'recharge_cap_reached'; capCents: number }
    | { kind: 'low_balance'; balanceMicros: number }
  ) & {
    /** How far below zero calls go on (the install's rules). */
    bufferMicros: number
  }

export function billingOwnerEmail(email: BillingOwnerEmail, origin = WEB_ORIGIN, locale?: EmailLocale): RenderedEmail {
  const { t, format, locale: lang } = getT(locale)
  const usd = (cents: number) => format.currency(cents / 100, 'USD')
  const key = (
    { recharge_failed: 'rechargeFailed', recharge_cap_reached: 'capReached', low_balance: 'lowBalance' } as const
  )[email.kind]
  const values = {
    brand: brandName(),
    amount: email.kind === 'recharge_failed' ? usd(email.amountCents) : '',
    cap: email.kind === 'recharge_cap_reached' ? usd(email.capCents) : '',
    balance: email.kind === 'low_balance' ? usd(Math.floor(email.balanceMicros / 10_000)) : '',
    buffer: usd(Math.floor(email.bufferMicros / 10_000)),
  }
  // i18n-dynamic: email.billing.*
  const subject = t(`email.billing.${key}.subject`, values)
  const blocks: Block[] = [
    { kind: 'text', text: t(`email.billing.${key}.text`, values) },
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
