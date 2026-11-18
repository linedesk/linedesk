// Emails about a white-label partner's own address (S5, apps/api/src/partner-domain.ts): to the partner's owner in the
// install's brand (we write to the partner, not to its clients), and the alert to the instance admins.
import { getT } from '@linedesk/i18n/server'
import { emailBrandName, emailOrigin } from '../email-brand.ts'
import type { AdminAlertText } from './alerts.ts'
import { type RenderedEmail, renderEmail, siteHost } from './layout.ts'
import type { EmailLocale } from './templates.ts'

/** What partnerDomainEmail tells a partner's owner. */
export type PartnerDomainEmail =
  | { kind: 'live'; hostname: string }
  | { kind: 'failed'; hostname: string }
  | { kind: 'removed'; hostname: string; reason: string }
  | { kind: 'expired'; hostname: string }

/**
 * To a white-label partner's owner: its address is live, stopped working (no longer points to us, or its certificate
 * failed), was removed by a server admin, or was removed after 30 days of not working.
 */
export function partnerDomainEmail(
  content: PartnerDomainEmail,
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const { hostname } = content
  const subject =
    content.kind === 'live'
      ? t('email.partnerDomain.liveSubject', { hostname })
      : content.kind === 'failed'
        ? t('email.partnerDomain.failedSubject', { hostname })
        : t('email.partnerDomain.removedSubject', { hostname })
  const text =
    content.kind === 'live'
      ? t('email.partnerDomain.liveText', { hostname })
      : content.kind === 'failed'
        ? t('email.partnerDomain.failedText', { hostname })
        : content.kind === 'removed'
          ? t('email.partnerDomain.removedText', { hostname, reason: content.reason })
          : t('email.partnerDomain.expiredText', { hostname })
  return renderEmail({
    locale: lang,
    subject,
    preheader: text,
    eyebrow: t('email.partnerDomain.eyebrow'),
    heading: subject,
    blocks: [
      { kind: 'text', text },
      { kind: 'button', label: t('email.partnerDomain.button'), url: `${origin}/#partner/domain` },
    ],
    reason: t('email.partnerDomain.reason', { site: siteHost(origin) }),
    origin,
  })
}

/**
 * A white-label partner added its own address (S5): its clients will sign in there once its DNS records are in.
 * Look-alike names are refused by the protected names; this is the human check (decision D3: no approval per address,
 * Server admin › Partners removes it at once).
 */
export const partnerDomainAddedAlert =
  (added: { partner: string; hostname: string; brandName: string | null; reviewUrl: string }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.adminAlert.partnerDomain.subject', { brand: emailBrandName(), partner: added.partner }),
      blocks: [
        { kind: 'text', text: t('email.adminAlert.partnerDomain.text', { partner: added.partner }) },
        {
          kind: 'facts',
          rows: [
            [t('email.adminAlert.partnerDomain.hostname'), added.hostname],
            [t('email.adminAlert.partnerBrand.name'), added.brandName ?? t('email.adminAlert.partnerBrand.none')],
          ],
        },
        { kind: 'text', tone: 'muted', text: t('email.adminAlert.partnerDomain.check') },
        { kind: 'button', label: t('email.adminAlert.partnerDomain.review'), url: added.reviewUrl },
      ],
    }
  }
