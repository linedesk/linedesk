// The emails about a number request in a country whose carrier checks documents first (docs/numbers-kyc.md): to the
// workspace's owners and admins once the number is live or the carrier did not approve it, and to the instance admins
// when an approved number could not be set up (`needs_operator`). Sent by number-request-notices.ts. Every word comes
// from packages/i18n/locales/en/email.json; the carrier's own reason stays as it came.
import { NUMBER_COUNTRIES, type KycCountry } from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'
import { emailOrigin } from '../email-brand.ts'
import { numberArea } from '../number-areas.ts'
import type { AdminAlertText } from './alerts.ts'
import { type Block, type RenderedEmail, renderEmail, siteHost } from './layout.ts'
import { appLink, type EmailLocale } from './templates.ts'

/** Settings › Phone numbers in the web app: where requests are made, followed and sent again. */
export const PHONE_NUMBERS_PATH = 'workspace/phone'

/** What the owners hear about: the number is live, or the carrier did not approve the request. */
export type NumberRequestEmail = {
  kind: 'active' | 'rejected'
  country: KycCountry
  /** The city's id (NumberCity.id): its name comes from `email.numberRequest.city.*`. */
  city: string
  /** National prefix without the trunk 0 (Berlin: `30`). */
  prefix: string
  e164: string | null
  /** Rejected: the carrier's words or one of our codes (`order_failure`, `requirements_declined`…); null: none given. */
  reason: string | null
}

/** Reasons the app sets itself (apps/api/src/number-requests.ts), with their key under `email.numberRequest.reason`. */
const REASON_KEYS: Record<string, string> = {
  order_failure: 'orderFailure',
  order_cancelled: 'orderCancelled',
  requirements_declined: 'declined',
  requirements_expired: 'expired',
  requirements_no_longer_eligible: 'noLongerEligible',
}

/** Cities with a name of their own in the catalog; any other shows the name of its area (number-areas.ts). */
const knownCity = (country: KycCountry, city: string) => NUMBER_COUNTRIES[country].cities.some(c => c.id === city)

/**
 * Where the number is: a catalog city by its translated name (Berlin), any other area by its official name and area
 * code (Heidelberg (06221)), an area code no list names by the code alone (0331).
 */
export function requestAreaText(country: KycCountry, city: string, prefix: string, locale?: EmailLocale): string {
  const { t } = getT(locale)
  // i18n-dynamic: email.numberRequest.city.*
  if (knownCity(country, city)) return t(`email.numberRequest.city.${city}` as MessageKey)
  const area = numberArea(country, prefix)?.name
  return area ? t('email.numberRequest.area', { area, prefix }) : `0${prefix}`
}

/**
 * +49 30 12345678: the calling code, the area code and the rest, as people write a number in these countries. Without
 * the number (not picked yet), the area code as dialled at home: 030.
 */
export function requestedNumberText(country: KycCountry, prefix: string, e164: string | null): string {
  const code = NUMBER_COUNTRIES[country].callingCode
  if (!e164) return `0${prefix}`
  const national = e164.startsWith(`+${code}`) ? e164.slice(code.length + 1) : null
  if (!national?.startsWith(prefix)) return e164
  return `+${code} ${prefix} ${national.slice(prefix.length)}`.trim()
}

/** The carrier's reason in the reader's words when it is one of ours; else as the carrier wrote it. */
export function rejectionReasonText(reason: string | null, locale?: EmailLocale): string {
  const { t } = getT(locale)
  if (!reason) return t('email.numberRequest.reason.none')
  const key = REASON_KEYS[reason]
  // i18n-dynamic: email.numberRequest.reason.*
  return key ? t(`email.numberRequest.reason.${key}` as MessageKey) : reason
}

export function numberRequestEmail(
  email: NumberRequestEmail,
  workspaceId: string,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const city = requestAreaText(email.country, email.city, email.prefix, locale)
  const values = {
    country: email.country,
    city,
    number: requestedNumberText(email.country, email.prefix, email.e164),
  }
  const blocks: Block[] = []
  let subject: string
  if (email.kind === 'active') {
    subject = t('email.numberRequest.active.subject', values)
    blocks.push({ kind: 'text', text: t('email.numberRequest.active.text', values) })
    blocks.push({ kind: 'text', text: t('email.numberRequest.active.next') })
    blocks.push({
      kind: 'button',
      label: t('email.numberRequest.active.button'),
      url: appLink(origin, workspaceId, PHONE_NUMBERS_PATH),
    })
  } else {
    subject = t('email.numberRequest.rejected.subject', values)
    blocks.push({ kind: 'text', text: t('email.numberRequest.rejected.text', values) })
    blocks.push({
      kind: 'facts',
      rows: [[t('email.numberRequest.rejected.reason'), rejectionReasonText(email.reason, locale)]],
    })
    blocks.push({ kind: 'text', text: t('email.numberRequest.rejected.next') })
    blocks.push({ kind: 'text', tone: 'muted', text: t('email.numberRequest.rejected.notCharged') })
    blocks.push({
      kind: 'button',
      label: t('email.numberRequest.rejected.button'),
      url: appLink(origin, workspaceId, PHONE_NUMBERS_PATH),
    })
  }
  return renderEmail({
    locale: lang,
    subject,
    preheader: blocks[0]?.kind === 'text' ? blocks[0].text : subject,
    eyebrow: t('email.numberRequest.eyebrow'),
    heading: subject,
    blocks,
    reason: t('email.numberRequest.why', { site: siteHost(origin) }),
    origin,
  })
}

/**
 * The instance admins' alert: the carrier approved a number, it is on the carrier account (paid), but it could not be
 * set up (`needs_operator`). `reason` is the code the API parked it with (number_in_use, routing_failed…), never
 * translated: the operator reads it next to the ALERT line in the log.
 */
export const numberRequestNeedsOperatorAlert =
  ({
    requestId,
    workspace,
    e164,
    reason,
    carrierAccount,
  }: {
    requestId: string
    /** The workspace's name (emailSafeName) or its id. */
    workspace: string
    e164: string | null
    reason: string | null
    carrierAccount: 'install' | 'workspace'
  }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.numberRequestNeedsOperator.subject', { number: e164 ?? '' }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.numberRequestNeedsOperator.text') },
        {
          kind: 'facts',
          rows: [
            [t('email.adminAlert.numberRequestNeedsOperator.workspace'), workspace],
            [t('email.adminAlert.numberRequestNeedsOperator.number'), e164 ?? '—'],
            [t('email.adminAlert.numberRequestNeedsOperator.request'), requestId],
            [t('email.adminAlert.numberRequestNeedsOperator.reason'), reason ?? '—'],
            [
              t('email.adminAlert.numberRequestNeedsOperator.account'),
              t('email.adminAlert.numberRequestNeedsOperator.accountKind', { account: carrierAccount }),
            ],
          ],
        },
        { kind: 'text', text: t('email.adminAlert.numberRequestNeedsOperator.next') },
      ],
    }
  }
