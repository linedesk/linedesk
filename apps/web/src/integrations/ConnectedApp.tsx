// Integrations › HubSpot, Slack and Jobber (connected apps, docs/crm-sync.md): connect the app with its consent page, see
// which account (Slack: which channel in which workspace) it is and whether calls still go through, the last calls sent, and disconnect. The connection is a
// synced row (app_connections); connecting is an OAuth round trip, so the page names the table to read again on
// return (refreshOnReturn), and the callback's result comes back in the hash (`?app=connected` or `?app=error`).
// While connected, "What Linedesk does" holds the connection's switches (app.updateSettings, local-first).
import {
  APP_SETTINGS,
  type AppConnectStartData,
  type AppDisconnectData,
  type AppPush,
  type AppPushesData,
  type AppSettingId,
  appSettingOn,
  type ConnectableApp,
} from '@linedesk/actions'
import type { AppConnection } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { refreshQuery, useQuery } from '../cachedQuery.ts'
import { refreshOnReturn } from '../refreshOnReturn.ts'
import { Section, SwitchRow } from '../settings/fields.tsx'
import { callAction, readAction, useWriteAction } from '../settings/settings-api.ts'
import { useRows, useRun } from '../store.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Loading, SkeletonList, useLoadState } from '../ui/LoadStates.tsx'
import { appConnectErrorKey, appConnectResult, appPushErrorKey, appSettingsWith, nameKey } from './catalog.ts'

type Props = {
  app: ConnectableApp
  /** Owners and admins (settings:write): connect, disconnect and the calls sent. */
  canEdit: boolean
  toast: (text: string) => void
}

const pushesKey = (app: ConnectableApp) => `app.pushes.${app}`

/** The texts that differ per app: HubSpot is a CRM (contacts), Slack posts to a channel, Jobber has clients. */
type AppText = { help: MessageKey; notConnected: MessageKey; disconnectConfirmTip: MessageKey; scope: MessageKey }
const APP_TEXT: Record<ConnectableApp, AppText> = {
  hubspot: {
    help: msg('settings.integrations.app.help'),
    notConnected: msg('settings.integrations.app.notConnected'),
    disconnectConfirmTip: msg('settings.integrations.app.disconnectConfirmTip'),
    scope: msg('settings.integrations.app.error.scope'),
  },
  slack: {
    help: msg('settings.integrations.app.slack.help'),
    notConnected: msg('settings.integrations.app.slack.notConnected'),
    disconnectConfirmTip: msg('settings.integrations.app.slack.disconnectConfirmTip'),
    scope: msg('settings.integrations.app.slack.scope'),
  },
  jobber: {
    help: msg('settings.integrations.app.jobber.help'),
    notConnected: msg('settings.integrations.app.jobber.notConnected'),
    disconnectConfirmTip: msg('settings.integrations.app.jobber.disconnectConfirmTip'),
    scope: msg('settings.integrations.app.jobber.scope'),
  },
}

/** Why connecting did not work, in the app's words where they differ (Slack gave no channel). */
const connectErrorKey = (app: ConnectableApp, code: unknown, fallback?: MessageKey) =>
  code === 'scope' ? APP_TEXT[app].scope : appConnectErrorKey(code, fallback)

export function ConnectedApp({ app, canEdit, toast }: Props) {
  const t = useT()
  const name = t(nameKey(app))
  const connection = useRows('app_connections').find(c => c.provider === app)
  const ready = useLoadState('app_connections') === 'ready'
  useConnectResult(app, toast)
  return (
    <>
      <Section id="ig-app" title={t('settings.integrations.app.title')} help={t(APP_TEXT[app].help, { name })}>
        <Loading
          what={t('settings.integrations.app.title')}
          loading={!ready}
          skeleton={<SkeletonList rows={1} aside action />}
        >
          {connection ? (
            <Connection app={app} connection={connection} canEdit={canEdit} toast={toast} />
          ) : (
            <NotConnected app={app} canEdit={canEdit} toast={toast} />
          )}
        </Loading>
      </Section>
      {ready && connection && <AppSettings app={app} connection={connection} canEdit={canEdit} />}
      {ready && connection && canEdit && <Pushes app={app} />}
    </>
  )
}

/** The callback's result in the hash: a toast, once, then the hash without it (a reload does not show it again). */
function useConnectResult(app: ConnectableApp, toast: Props['toast']) {
  const t = useT()
  const [result] = useState(() => appConnectResult(window.location.hash))
  useEffect(() => {
    if (!result) return
    const name = t(nameKey(app))
    toast(
      result.ok ? t('settings.integrations.app.connected', { name }) : t(connectErrorKey(app, result.reason), { name }),
    )
    history.replaceState(null, '', window.location.hash.split('?')[0])
  }, [result, toast, app, t])
}

/** The `code` an action's rejection carries (settings-api.ts), which the page words itself. */
const codeOf = (e: unknown) => (e as { code?: unknown }).code

/** Opens the app's consent page; the callback brings the browser back here. */
function useConnect(app: ConnectableApp, toast: Props['toast']) {
  const t = useT()
  const [opening, setOpening] = useState(false)
  async function connect() {
    setOpening(true)
    try {
      const { url } = await callAction<AppConnectStartData>('app.connectStart', { app })
      refreshOnReturn(['app_connections'])
      window.location.assign(url)
    } catch (e) {
      // Not set up on this server (no client id in Server admin), no SECRETS_KEY: the code says what is missing.
      toast(t(connectErrorKey(app, codeOf(e)), { name: t(nameKey(app)) }))
      setOpening(false)
    }
  }
  return { opening, connect }
}

function NotConnected({ app, canEdit, toast }: Props) {
  const t = useT()
  const name = t(nameKey(app))
  const { opening, connect } = useConnect(app, toast)
  if (!canEdit) return <p className="help">{t('settings.integrations.app.onlyAdmins', { name })}</p>
  return (
    <div className="ig-app-connect">
      <p className="help">{t(APP_TEXT[app].notConnected, { name })}</p>
      <Button
        variant="primary"
        disabled={opening}
        onClick={() => void connect()}
        title={t('settings.integrations.app.connectTip', { name })}
      >
        {opening ? t('settings.integrations.app.opening', { name }) : t('settings.integrations.app.connect', { name })}
      </Button>
    </div>
  )
}

function Connection({ app, connection, canEdit, toast }: Props & { connection: AppConnection }) {
  const t = useT()
  const format = useFormat()
  const name = t(nameKey(app))
  const write = useWriteAction()
  const { opening, connect } = useConnect(app, toast)
  const [busy, setBusy] = useState(false)
  /** Disconnect asks once in place (click again), like revoking a key: no browser dialog. */
  const [confirming, setConfirming] = useState(false)
  const attention = connection.status === 'needs_attention'

  async function disconnect() {
    if (!confirming) return setConfirming(true)
    setBusy(true)
    try {
      const { revoked } = await write<AppDisconnectData>('app.disconnect', { app })
      toast(
        revoked
          ? t('settings.integrations.app.disconnected', { name })
          : t('settings.integrations.app.disconnectedNotRevoked', { name }),
      )
    } catch (e) {
      toast(t(connectErrorKey(app, codeOf(e), msg('settings.integrations.app.disconnectFailed')), { name }))
      setBusy(false)
      setConfirming(false)
    }
  }

  const sub = attention
    ? connection.error_code
      ? t(appPushErrorKey(connection.error_code, app), { name })
      : t('settings.integrations.app.attentionFallback', { name })
    : connection.last_push_at
      ? t('settings.integrations.app.lastSent', {
          when: format.dateTime(new Date(connection.last_push_at), { dateStyle: 'medium', timeStyle: 'short' }),
        })
      : t('settings.integrations.app.noneSent')

  return (
    <List label={t('settings.integrations.app.title')}>
      <ListRow
        title={
          connection.channel
            ? t('settings.integrations.app.channelIn', {
                channel: connection.channel,
                account: connection.account_name,
              })
            : connection.account_name
        }
        sub={sub}
        aside={
          attention ? (
            <Badge tone="danger" dot title={t('settings.integrations.status.needsAttentionTip')}>
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
                  disabled={opening || busy}
                  onClick={() => void connect()}
                  title={t('settings.integrations.app.reconnectTip', { name })}
                >
                  {t('settings.integrations.app.reconnect')}
                </Button>
              )}
              <Button
                size="sm"
                variant={confirming ? 'danger' : 'ghost'}
                disabled={busy || opening}
                onClick={() => void disconnect()}
                onBlur={() => setConfirming(false)}
                title={
                  confirming
                    ? t(APP_TEXT[app].disconnectConfirmTip, { name })
                    : t('settings.integrations.app.disconnectTip', { name })
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
    </List>
  )
}

const SETTING_TEXT: Record<AppSettingId, { title: MessageKey; help: MessageKey; tip: MessageKey }> = {
  log_calls: {
    title: msg('settings.integrations.app.settings.logCalls'),
    help: msg('settings.integrations.app.settings.logCallsHelp'),
    tip: msg('settings.integrations.app.settings.logCallsTip'),
  },
  create_contacts: {
    title: msg('settings.integrations.app.settings.createContacts'),
    help: msg('settings.integrations.app.settings.createContactsHelp'),
    tip: msg('settings.integrations.app.settings.createContactsTip'),
  },
  fill_fields: {
    title: msg('settings.integrations.app.settings.fillFields'),
    help: msg('settings.integrations.app.settings.fillFieldsHelp'),
    tip: msg('settings.integrations.app.settings.fillFieldsTip'),
  },
  only_urgent: {
    title: msg('settings.integrations.app.settings.onlyUrgent'),
    help: msg('settings.integrations.app.settings.onlyUrgentHelp'),
    tip: msg('settings.integrations.app.settings.onlyUrgentTip'),
  },
}

/**
 * A switch whose words differ per app: Slack posts the call to a channel instead of logging it on a contact; Jobber
 * adds it as a note on the client.
 */
const APP_SETTING_TEXT: Partial<Record<ConnectableApp, Partial<typeof SETTING_TEXT>>> = {
  slack: {
    log_calls: {
      title: msg('settings.integrations.app.settings.postCalls'),
      help: msg('settings.integrations.app.settings.postCallsHelp'),
      tip: msg('settings.integrations.app.settings.postCallsTip'),
    },
  },
  jobber: {
    log_calls: {
      title: msg('settings.integrations.app.jobber.settings.logCalls'),
      help: msg('settings.integrations.app.jobber.settings.logCallsHelp'),
      tip: msg('settings.integrations.app.settings.logCallsTip'),
    },
    create_contacts: {
      title: msg('settings.integrations.app.jobber.settings.createContacts'),
      help: msg('settings.integrations.app.jobber.settings.createContactsHelp'),
      tip: msg('settings.integrations.app.settings.createContactsTip'),
    },
    fill_fields: {
      title: msg('settings.integrations.app.jobber.settings.fillFields'),
      help: msg('settings.integrations.app.jobber.settings.fillFieldsHelp'),
      tip: msg('settings.integrations.app.jobber.settings.fillFieldsTip'),
    },
  },
}
const settingText = (app: ConnectableApp, id: AppSettingId) => APP_SETTING_TEXT[app]?.[id] ?? SETTING_TEXT[id]

/**
 * What Linedesk does in the app: one switch per setting, applied locally at once and sent through the outbox. Every
 * switch is sent, so the optimistic row is whole. The others only matter while calls are logged: nested, greyed out
 * when that is off. Members see them; owners and admins change them.
 */
function AppSettings({
  app,
  connection,
  canEdit,
}: {
  app: ConnectableApp
  connection: AppConnection
  canEdit: boolean
}) {
  const t = useT()
  const run = useRun()
  const name = t(nameKey(app))
  const ids = APP_SETTINGS[app]
  const logging = appSettingOn(connection.settings, 'log_calls')
  const set = (id: AppSettingId, on: boolean) =>
    void run('app.updateSettings', { id: connection.id, settings: appSettingsWith(app, connection.settings, id, on) })
  return (
    <Section
      id="ig-app-settings"
      title={t('settings.integrations.app.settings.title')}
      help={t('settings.integrations.app.settings.help', { name })}
    >
      <div className="st-swlist">
        {ids.map(id => (
          <SwitchRow
            key={id}
            title={t(settingText(app, id).title)}
            description={t(settingText(app, id).help, { name })}
            tip={t(settingText(app, id).tip, { name })}
            on={appSettingOn(connection.settings, id)}
            onChange={on => set(id, on)}
            disabled={!canEdit}
            nested={id !== 'log_calls'}
            dimmed={id !== 'log_calls' && !logging}
          />
        ))}
      </div>
    </Section>
  )
}

const PUSH_STATE: Record<AppPush['status'], { label: MessageKey; tone: 'ok' | 'danger' | 'outline' }> = {
  done: { label: msg('settings.integrations.app.push.done'), tone: 'ok' },
  pending: { label: msg('settings.integrations.app.push.pending'), tone: 'outline' },
  sending: { label: msg('settings.integrations.app.push.pending'), tone: 'outline' },
  failed: { label: msg('settings.integrations.app.push.failed'), tone: 'danger' },
  skipped: { label: msg('settings.integrations.app.push.skipped'), tone: 'outline' },
}

/** The last calls sent to the app, newest first: what went through and why one did not. */
function Pushes({ app }: { app: ConnectableApp }) {
  const t = useT()
  const format = useFormat()
  const key = pushesKey(app)
  const pushes = useQuery(key, () => readAction<AppPushesData>('app.pushes', { app, limit: 20 }))
  const list = pushes.data?.pushes ?? []
  return (
    <Section
      id="ig-app-pushes"
      title={t('settings.integrations.app.pushes.title')}
      help={t('settings.integrations.app.pushes.help', { name: t(nameKey(app)) })}
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon="restart"
          onClick={() => void refreshQuery(key)}
          title={t('settings.integrations.app.pushes.reloadTip')}
        >
          {t('settings.integrations.app.pushes.reload')}
        </Button>
      }
    >
      <Loading
        what={t('settings.integrations.app.pushes.title')}
        loading={pushes.data === undefined}
        error={pushes.error}
        onRetry={() => void pushes.reload()}
        skeleton={<SkeletonList rows={2} aside />}
      >
        {list.length === 0 ? (
          <ListEmpty>{t('settings.integrations.app.pushes.empty')}</ListEmpty>
        ) : (
          <List label={t('settings.integrations.app.pushes.title')}>
            {list.map(p => {
              const when = format.dateTime(new Date(p.createdAt), { dateStyle: 'medium', timeStyle: 'short' })
              return (
                <ListRow
                  key={p.id}
                  title={p.caller || t('settings.integrations.app.pushes.unknownCaller')}
                  sub={
                    p.status !== 'done' && p.error
                      ? t('settings.integrations.app.pushes.withError', {
                          when,
                          error: t(appPushErrorKey(p.error, app), { name: t(nameKey(app)) }),
                        })
                      : when
                  }
                  aside={<Badge tone={PUSH_STATE[p.status].tone}>{t(PUSH_STATE[p.status].label)}</Badge>}
                />
              )
            })}
          </List>
        )}
      </Loading>
    </Section>
  )
}
