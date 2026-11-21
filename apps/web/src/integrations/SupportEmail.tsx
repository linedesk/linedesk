// Integrations › Gmail and › Outlook (LIN-637), one page each: the business connects the mailboxes its support answers
// from, read only, so Linedesk can learn what customers ask and how support answers. Connecting is an OAuth
// round trip (mail.connectStart, then the provider's consent page, then GET /v1/mail/callback/<provider>), so the page
// names the table to read again on return (refreshOnReturn); the callback's result comes back in the hash
// (`?mail=connected` or `?mail=error&reason=<code>`). The mailboxes are synced rows (mail_connections). Nothing is
// read when connecting: connecting stores no mail. Below them, the analysis of their support mail (MailReview.tsx).
import type { MailConnectStartData, MailDisconnectData, MailProviderId } from '@linedesk/actions'
import type { MailConnection } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { refreshOnReturn } from '../refreshOnReturn.ts'
import { Section } from '../settings/fields.tsx'
import { callAction, useWriteAction } from '../settings/settings-api.ts'
import { useRows } from '../store.tsx'
import { SignInMark } from '../ui/brand-logos.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { Loading, SkeletonList, useLoadState } from '../ui/LoadStates.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { mailConnectErrorKey, mailConnectResult } from './catalog.ts'
import { MailReview } from './MailReview.tsx'

type Props = {
  /** The provider this page connects: Gmail (google) or Outlook / Microsoft 365 (microsoft). */
  provider: MailProviderId
  /** Owners and admins (settings:write): connect and disconnect. */
  canEdit: boolean
  toast: (text: string) => void
}

const PROVIDER_NAME: Record<MailProviderId, MessageKey> = {
  google: msg('settings.integrations.mail.provider.google'),
  microsoft: msg('settings.integrations.mail.provider.microsoft'),
}

/** The `code` an action's rejection carries (settings-api.ts), which the page words itself. */
const codeOf = (e: unknown) => (e as { code?: unknown }).code

export function SupportEmail({ provider: own, canEdit, toast }: Props) {
  const t = useT()
  const mailboxes = useRows('mail_connections').filter(m => m.provider === own)
  const ready = useLoadState('mail_connections') === 'ready'
  const connect = useConnect(toast)
  useConnectResult(toast)
  return (
    <Section id="ig-mail" title={t('settings.integrations.mail.title')} help={t('settings.integrations.mail.help')}>
      <Loading
        what={t('settings.integrations.mail.title')}
        loading={!ready}
        skeleton={<SkeletonList rows={1} aside action />}
      >
        {mailboxes.length > 0 ? (
          <List label={t('settings.integrations.mail.title')}>
            {mailboxes.map(m => (
              <Mailbox key={m.id} mailbox={m} canEdit={canEdit} connect={connect} toast={toast} />
            ))}
          </List>
        ) : (
          <ListEmpty>{t('settings.integrations.mail.none')}</ListEmpty>
        )}
        {canEdit ? (
          <div className="ig-app-connect">
            <Button
              variant="primary"
              disabled={connect.opening !== null}
              onClick={() => void connect.start(own)}
              title={t('settings.integrations.mail.connectTip', { provider: t(PROVIDER_NAME[own]) })}
            >
              {connect.opening === own
                ? t('settings.integrations.mail.opening', { provider: t(PROVIDER_NAME[own]) })
                : t('settings.integrations.mail.connect', { provider: t(PROVIDER_NAME[own]) })}
            </Button>
          </div>
        ) : (
          <p className="help">{t('settings.integrations.mail.onlyAdmins')}</p>
        )}
        <p className="help">{t('settings.integrations.mail.readOnly')}</p>
      </Loading>
    </Section>
  )
}

/**
 * This provider's mailboxes, then what the support mail shows: one analysis over every connected mailbox, Gmail and
 * Outlook together, shown on the page of each provider that has a connected mailbox (Tim, 2026-11-21).
 */
export function SupportEmailPage({ provider, canEdit, toast }: Props) {
  const connected = useRows('mail_connections').some(m => m.provider === provider)
  return (
    <>
      <SupportEmail provider={provider} canEdit={canEdit} toast={toast} />
      {connected && <MailReview canEdit={canEdit} toast={toast} />}
    </>
  )
}

/** The callback's result in the hash: a toast, once, then the hash without it (a reload does not show it again). */
function useConnectResult(toast: Props['toast']) {
  const t = useT()
  const [result] = useState(() => mailConnectResult(window.location.hash))
  useEffect(() => {
    if (!result) return
    toast(result.ok ? t('settings.integrations.mail.connected') : t(mailConnectErrorKey(result.reason)))
    history.replaceState(null, '', window.location.hash.split('?')[0])
  }, [result, toast, t])
}

type Connect = { opening: MailProviderId | null; start: (provider: MailProviderId) => Promise<void> }

/** Opens the provider's consent page; the callback brings the browser back here. */
function useConnect(toast: Props['toast']): Connect {
  const t = useT()
  const [opening, setOpening] = useState<MailProviderId | null>(null)
  async function start(provider: MailProviderId) {
    setOpening(provider)
    try {
      const { url } = await callAction<MailConnectStartData>('mail.connectStart', { provider })
      refreshOnReturn(['mail_connections'])
      window.location.assign(url)
    } catch (e) {
      // Not set up on this server, no SECRETS_KEY: the code says what is missing.
      toast(t(mailConnectErrorKey(codeOf(e)), { provider: t(PROVIDER_NAME[provider]) }))
      setOpening(null)
    }
  }
  return { opening, start }
}

function Mailbox({
  mailbox,
  canEdit,
  connect,
  toast,
}: {
  mailbox: MailConnection
  canEdit: boolean
  connect: Connect
  toast: Props['toast']
}) {
  const t = useT()
  const write = useWriteAction()
  const provider = t(PROVIDER_NAME[mailbox.provider])
  const [busy, setBusy] = useState(false)
  /** Disconnect asks once in place (click again), like revoking a key: no browser dialog. */
  const [confirming, setConfirming] = useState(false)
  const attention = mailbox.status === 'needs_reconnect'

  async function disconnect() {
    if (!confirming) return setConfirming(true)
    setBusy(true)
    try {
      const { revoked } = await write<MailDisconnectData>('mail.disconnect', { connectionId: mailbox.id })
      toast(
        revoked
          ? t('settings.integrations.mail.disconnected', { account: mailbox.account_email })
          : t('settings.integrations.mail.disconnectedNotRevoked', { account: mailbox.account_email, provider }),
      )
    } catch (e) {
      toast(t(mailConnectErrorKey(codeOf(e), msg('settings.integrations.mail.disconnectFailed')), { provider }))
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <ListRow
      lead={<SignInMark method={mailbox.provider} />}
      title={mailbox.account_email}
      sub={attention ? t('settings.integrations.mail.needsReconnect', { provider }) : provider}
      aside={
        attention ? (
          <Badge tone="danger" dot title={t('settings.integrations.mail.needsReconnectTip', { provider })}>
            {t('settings.integrations.status.needsAttention')}
          </Badge>
        ) : (
          <Badge tone="ok" dot>
            {t('settings.integrations.status.connected')}
          </Badge>
        )
      }
      actions={
        canEdit && (
          <>
            {attention && (
              <Button
                size="sm"
                disabled={connect.opening !== null || busy}
                onClick={() => void connect.start(mailbox.provider)}
                title={t('settings.integrations.mail.reconnectTip', { provider })}
              >
                {t('settings.integrations.app.reconnect')}
              </Button>
            )}
            <Button
              size="sm"
              variant={confirming ? 'danger' : 'ghost'}
              disabled={busy || connect.opening !== null}
              onClick={() => void disconnect()}
              onBlur={() => setConfirming(false)}
              title={
                confirming
                  ? t('settings.integrations.mail.disconnectConfirmTip', { account: mailbox.account_email })
                  : t('settings.integrations.mail.disconnectTip', { account: mailbox.account_email })
              }
            >
              {confirming
                ? t('settings.integrations.app.disconnectConfirm')
                : t('settings.integrations.app.disconnect')}
            </Button>
          </>
        )
      }
    />
  )
}
