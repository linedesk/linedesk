// Integrations › Zapier: how to connect this workspace to Zapier, in four steps, each with its action. One Linedesk app on
// Zapier serves every install; its link is the install's (Server admin › Features, zapierApp.set), and an install
// without one says so instead of linking. A Zapier user names this install's address when they connect, so the
// guide shows the address with Copy, and says so when Zapier can't reach it (http, localhost, a private address).
import { zapierCanReach } from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { type ReactNode, useState } from 'react'
import { ZAPIER_SETTING } from '../admin/route.ts'
import { providerAudience } from '../providerAudience.ts'
import { ExternalLink } from '../ui/AppLink.tsx'
import { Input } from '../ui/form.tsx'
import { copyText } from '../ui/HelpTip.tsx'
import { Button } from '../ui/kit.tsx'

/** A link to a page outside the app, opened in a new tab. */
export const externalLink = (href: string) => (chunks: ReactNode[]) => <ExternalLink href={href}>{chunks}</ExternalLink>

type Props = {
  /** The link to the Linedesk app on Zapier (integration.list); null when the install has none. */
  appUrl: string | null
  /** Zaps are subscribed: the page's Done is the primary then, so step 1's button is not. */
  connected: boolean
  /** Creates a key for Zapier (member access is enough for every trigger and action); resolves to the key. */
  createKey: () => Promise<string>
  toast: (text: string) => void
}

/**
 * The steps hold their actions: step 1 creates the key and shows it once with Copy, step 2 links the Zapier app (an
 * instance admin opens the setting in a new tab; everyone else reads whom to ask), step 3 the address with Copy.
 */
export function ZapierGuide({ appUrl, connected, createKey, toast }: Props) {
  const t = useT()
  const address = window.location.origin
  const [key, setKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const copy = async (text: string, copied: string, failed: string) =>
    toast((await copyText(text)) === 'copied' ? copied : failed)
  async function create() {
    setCreating(true)
    try {
      setKey(await createKey())
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setCreating(false)
    }
  }
  return (
    <div className="dev-guide">
      <h3>{t('settings.developers.zapier.title')}</h3>
      <ol>
        <li>
          <span className="dev-step">
            {t('settings.developers.zapier.key')}
            {!key && (
              <Button
                size="sm"
                variant={connected ? 'secondary' : 'primary'}
                busy={creating}
                onClick={() => void create()}
                title={t('settings.developers.zapier.createKeyTip')}
              >
                {t('settings.developers.create')}
              </Button>
            )}
          </span>
          {key && (
            <>
              <div className="dev-secret">
                <Input
                  readOnly
                  value={key}
                  aria-label={t('settings.developers.created.key')}
                  onFocus={e => e.currentTarget.select()}
                />
                <Button
                  onClick={() =>
                    void copy(key, t('settings.developers.created.copied'), t('settings.developers.created.copyFailed'))
                  }
                >
                  {t('common.copy.copy')}
                </Button>
              </div>
              <p className="k-field-desc">{t('settings.developers.created.description')}</p>
            </>
          )}
        </li>
        <li>
          {appUrl ? (
            <T k="settings.developers.zapier.open" values={{ link: externalLink(appUrl) }} />
          ) : providerAudience() === 'admin' ? (
            <span className="dev-step" role="note">
              {t('settings.developers.zapier.notLinked')}
              <a
                className="k-btn k-btn-secondary k-btn-sm"
                href={`#admin/features/${ZAPIER_SETTING}`}
                target="_blank"
                rel="noopener"
                title={t('settings.developers.zapier.linkAppTip')}
              >
                <span>{t('settings.developers.zapier.linkApp')}</span>
              </a>
            </span>
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
            <Button
              onClick={() =>
                void copy(address, t('settings.developers.zapier.copied'), t('settings.developers.zapier.copyFailed'))
              }
            >
              {t('common.copy.copy')}
            </Button>
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
