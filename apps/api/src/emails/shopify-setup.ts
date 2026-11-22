// The emails of a store's own Shopify app set up on request (LIN-719, shopify-setup.ts): the alert to the install's
// admins that a store asked, and the note to the member who asked that it is ready to install.
import { getT } from '@linedesk/i18n/server'
import { emailBrandName, emailOrigin } from '../email-brand.ts'
import type { AdminAlertText } from './alerts.ts'
import { type RenderedEmail, renderEmail, siteHost } from './layout.ts'
import { appLink, type EmailLocale } from './templates.ts'

/**
 * To every instance admin: a workspace asked for its store's own Shopify app. `workspace` is email-safe already; `shop`
 * is a checked myshopify.com domain; `reviewUrl`: Server admin's Overview, which lists the open requests.
 */
export const shopifySetupRequestedAlert =
  (request: {
    workspace: string
    workspaceId: string
    shop: string
    by: string | null
    reviewUrl: string
  }): AdminAlertText =>
  locale => {
    const { t } = getT(locale)
    return {
      subject: t('email.shopifySetup.requested.subject', { shop: request.shop }),
      blocks: [
        { kind: 'text', text: t('email.shopifySetup.requested.text', { workspace: request.workspace }) },
        {
          kind: 'facts',
          rows: [
            [t('email.shopifySetup.requested.store'), request.shop],
            [t('email.shopifySetup.requested.workspace'), `${request.workspace} (${request.workspaceId})`],
            [t('email.shopifySetup.requested.by'), request.by ?? t('email.shopifySetup.requested.unknown')],
          ],
        },
        { kind: 'text', tone: 'muted', text: t('email.shopifySetup.requested.next') },
        { kind: 'button', label: t('email.shopifySetup.requested.button'), url: request.reviewUrl },
      ],
    }
  }

/** To the member who asked (else the workspace's owner): the store's app is ready, with Shopify's install link. */
export function shopifySetupReadyEmail(
  { workspaceId, shop, installUrl }: { workspaceId: string; shop: string; installUrl: string },
  origin = emailOrigin(),
  locale?: EmailLocale,
): RenderedEmail {
  const { t, locale: lang } = getT(locale)
  const brand = emailBrandName()
  return renderEmail({
    locale: lang,
    subject: t('email.shopifySetup.ready.subject', { brand }),
    preheader: t('email.shopifySetup.ready.preheader', { shop }),
    heading: t('email.shopifySetup.ready.heading'),
    blocks: [
      { kind: 'text', text: t('email.shopifySetup.ready.text', { shop, brand }) },
      {
        kind: 'button',
        label: t('email.shopifySetup.ready.button'),
        url: installUrl,
        second: {
          label: t('email.shopifySetup.ready.open'),
          url: appLink(origin, workspaceId, 'integrations/shopify'),
        },
      },
      { kind: 'text', tone: 'muted', text: t('email.shopifySetup.ready.after', { brand }) },
    ],
    reason: t('email.shopifySetup.ready.reason', { site: siteHost(origin) }),
    origin,
  })
}
