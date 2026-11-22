// Integrations › Zapier: how to connect this workspace to Zapier, in four steps. One Linedesk app on
// Zapier serves every install; its link is the install's (Server admin › Features, zapierApp.set), and an install
// without one says so instead of linking. A Zapier user names this install's address when they connect, so the
// guide shows the address with Copy, and says so when Zapier can't reach it (http, localhost, a private address).
import { zapierCanReach } from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import type { ReactNode } from 'react'
import { ExternalLink } from '../ui/AppLink.tsx'
import { Input } from '../ui/form.tsx'
import { copyText } from '../ui/HelpTip.tsx'
import { Button } from '../ui/kit.tsx'

/** A link to a page outside the app, opened in a new tab. */
export const externalLink = (href: string) => (chunks: ReactNode[]) => <ExternalLink href={href}>{chunks}</ExternalLink>

/** `appUrl`: the link to the Linedesk app on Zapier (integration.list); null when the install has none. */
export function ZapierGuide({ appUrl, toast }: { appUrl: string | null; toast: (text: string) => void }) {
  const t = useT()
  const address = window.location.origin
  const copy = async () =>
    toast(
      (await copyText(address)) === 'copied'
        ? t('settings.developers.zapier.copied')
        : t('settings.developers.zapier.copyFailed'),
    )
  return (
    <div className="dev-guide">
      <h3>{t('settings.developers.zapier.title')}</h3>
      <ol>
        <li>{t('settings.developers.zapier.key')}</li>
        <li>
          {appUrl ? (
            <T k="settings.developers.zapier.open" values={{ link: externalLink(appUrl) }} />
          ) : (
            <span role="note">{t('settings.developers.zapier.notAvailable')}</span>
          )}
        </li>
        <li>
          {t('settings.developers.zapier.connect')}
          <div className="dev-secret">
            <Input
              readOnly
              value={address}
              aria-label={t('settings.developers.zapier.address')}
              onFocus={e => e.currentTarget.select()}
            />
            <Button onClick={() => void copy()}>{t('common.copy.copy')}</Button>
          </div>
          {!zapierCanReach(address) && (
            <p className="k-field-msg" role="note">
              {t('settings.developers.zapier.unreachable', { address })}
            </p>
          )}
        </li>
        <li>{t('settings.developers.zapier.pick')}</li>
      </ol>
    </div>
  )
}
