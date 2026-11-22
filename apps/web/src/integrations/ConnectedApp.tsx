// Integrations › HubSpot, Zoho CRM, Slack, Jobber and Shopify (connected apps, docs/crm-sync.md): connect the app with its consent page, see
// which account (Slack: which channel in which workspace) it is and whether calls still go through, the last calls sent, and disconnect. The connection is a
// synced row (app_connections); connecting is an OAuth round trip, so the page names the table to read again on
// return (refreshOnReturn), and the callback's result comes back in the hash (`?app=connected` or `?app=error`).
// While connected, "What Linedesk does" holds the connection's switches (app.updateSettings, local-first). Shopify is
// connected per store: the member types the store's address first, and its switches come in two groups (after each
// call, what the assistant may change), with the caller verification apart (checkboxes, not switches). Every switch
// gives Linedesk more when on (LIN-733): a setting that holds it back (Slack's only_urgent) shows inverted.
import {
  APP_SETTINGS,
  type AppConnectStartData,
  type AppDisconnectData,
  type AppPush,
  type AppPushesData,
  type AppSettingId,
  appSettingOn,
  type ConnectableApp,
  isShopifyRecommended,
  type ShopVerify,
  SHOP_CHANGE_SETTINGS,
  SHOP_VERIFY_SETTINGS,
  shopifyRecommendedSettings,
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
import { Checkbox } from '../ui/controls.tsx'
import { Badge, Button, Icon } from '../ui/kit.tsx'
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

/** The texts that differ per app: HubSpot is a CRM (contacts), Slack posts to a channel, Jobber has clients, Shopify customers. */
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
  shopify: {
    help: msg('settings.integrations.app.shopify.help'),
    notConnected: msg('settings.integrations.app.shopify.notConnected'),
    disconnectConfirmTip: msg('settings.integrations.app.shopify.disconnectConfirmTip'),
    scope: msg('settings.integrations.app.shopify.scope'),
  },
  // A CRM with contacts, like HubSpot: the same words.
  zoho: {
    help: msg('settings.integrations.app.help'),
    notConnected: msg('settings.integrations.app.notConnected'),
    disconnectConfirmTip: msg('settings.integrations.app.disconnectConfirmTip'),
    scope: msg('settings.integrations.app.error.scope'),
  },
}

/** Why connecting did not work, in the app's words where they differ (Slack gave no channel). */
export const connectErrorKey = (app: ConnectableApp, code: unknown, fallback?: MessageKey) =>
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

/**
 * Opens the app's consent page; the callback brings the browser back here. Shopify: with `shop` (Connect again on a
 * connected store) its consent page, else Shopify's store picker asks which store.
 */
function useConnect(app: ConnectableApp, toast: Props['toast']) {
  const t = useT()
  const [opening, setOpening] = useState(false)
  async function connect(shop?: string) {
    setOpening(true)
    try {
      const { url } = await callAction<AppConnectStartData>('app.connectStart', shop ? { app, shop } : { app })
      refreshOnReturn(['app_connections'])
      window.location.assign(url)
    } catch (e) {
      // Not set up on this server (no client id in Server admin), no SECRETS_KEY: the code says what is missing.
      const code = codeOf(e)
      toast(t(connectErrorKey(app, code), { name: t(nameKey(app)) }))
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
                  onClick={() => void connect(app === 'shopify' ? connection.account_id : undefined)}
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

type SettingText = { title: MessageKey; help: MessageKey; tip: MessageKey }

const SETTING_TEXT: Record<AppSettingId, SettingText> = {
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
    title: msg('settings.integrations.app.settings.notUrgent'),
    help: msg('settings.integrations.app.settings.notUrgentHelp'),
    tip: msg('settings.integrations.app.settings.notUrgentTip'),
  },
  shop_returns: {
    title: msg('settings.integrations.app.shopify.settings.returns'),
    help: msg('settings.integrations.app.shopify.settings.returnsHelp'),
    tip: msg('settings.integrations.app.shopify.settings.returnsTip'),
  },
  shop_address: {
    title: msg('settings.integrations.app.shopify.settings.address'),
    help: msg('settings.integrations.app.shopify.settings.addressHelp'),
    tip: msg('settings.integrations.app.shopify.settings.addressTip'),
  },
  shop_cancel: {
    title: msg('settings.integrations.app.shopify.settings.cancel'),
    help: msg('settings.integrations.app.shopify.settings.cancelHelp'),
    tip: msg('settings.integrations.app.shopify.settings.cancelTip'),
  },
  verify_name: {
    title: msg('settings.integrations.app.shopify.settings.verifyName'),
    help: msg('settings.integrations.app.shopify.settings.verifyNameHelp'),
    tip: msg('settings.integrations.app.shopify.settings.verifyNameTip'),
  },
  verify_postcode: {
    title: msg('settings.integrations.app.shopify.settings.verifyPostcode'),
    help: msg('settings.integrations.app.shopify.settings.verifyPostcodeHelp'),
    tip: msg('settings.integrations.app.shopify.settings.verifyPostcodeTip'),
  },
  verify_email: {
    title: msg('settings.integrations.app.shopify.settings.verifyEmail'),
    help: msg('settings.integrations.app.shopify.settings.verifyEmailHelp'),
    tip: msg('settings.integrations.app.shopify.settings.verifyEmailTip'),
  },
  verify_order_number: {
    title: msg('settings.integrations.app.shopify.settings.verifyOrderNumber'),
    help: msg('settings.integrations.app.shopify.settings.verifyOrderNumberHelp'),
    tip: msg('settings.integrations.app.shopify.settings.verifyOrderNumberTip'),
  },
  verify_caller_number: {
    title: msg('settings.integrations.app.shopify.settings.verifyCallerNumber'),
    help: msg('settings.integrations.app.shopify.settings.verifyCallerNumberHelp'),
    tip: msg('settings.integrations.app.shopify.settings.verifyCallerNumberTip'),
  },
}

/**
 * A switch whose words differ per app: Slack posts the call to a channel instead of logging it on a contact; Jobber
 * adds it as a note on the client, Shopify on the customer.
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
  shopify: {
    log_calls: {
      title: msg('settings.integrations.app.shopify.settings.logCalls'),
      help: msg('settings.integrations.app.shopify.settings.logCallsHelp'),
      tip: msg('settings.integrations.app.settings.logCallsTip'),
    },
    create_contacts: {
      title: msg('settings.integrations.app.shopify.settings.createContacts'),
      help: msg('settings.integrations.app.shopify.settings.createContactsHelp'),
      tip: msg('settings.integrations.app.settings.createContactsTip'),
    },
    fill_fields: {
      title: msg('settings.integrations.app.shopify.settings.fillFields'),
      help: msg('settings.integrations.app.shopify.settings.fillFieldsHelp'),
      tip: msg('settings.integrations.app.shopify.settings.fillFieldsTip'),
    },
  },
}
const settingText = (app: ConnectableApp, id: AppSettingId) => APP_SETTING_TEXT[app]?.[id] ?? SETTING_TEXT[id]

/**
 * Settings that hold Linedesk back when on: their switch shows the opposite, so turning a switch on always lets
 * Linedesk do more (LIN-733). Slack's only_urgent shows as "Also post calls that are not urgent".
 */
const INVERTED: readonly AppSettingId[] = ['only_urgent']

/** The switches that only matter while calls are logged: shown nested under log_calls, greyed out while it is off. */
const AFTER_LOG_CALLS: readonly AppSettingId[] = ['create_contacts', 'fill_fields', 'only_urgent']

/** A group of switches under a short heading; an app without groups shows its switches as one list. */
type SettingGroup = { title: MessageKey; help?: MessageKey; ids: readonly AppSettingId[] }
const SETTING_GROUPS: Partial<Record<ConnectableApp, readonly SettingGroup[]>> = {
  shopify: [
    {
      title: msg('settings.integrations.app.shopify.group.afterCall'),
      help: msg('settings.integrations.app.shopify.group.afterCallHelp'),
      ids: ['log_calls', 'create_contacts', 'fill_fields'],
    },
    {
      title: msg('settings.integrations.app.shopify.group.changes'),
      help: msg('settings.integrations.app.shopify.group.changesHelp'),
      ids: SHOP_CHANGE_SETTINGS,
    },
  ],
}

/**
 * What Linedesk does in the app: one switch per setting, applied locally at once and sent through the outbox. Every
 * switch is sent, so the optimistic row is whole. The others only matter while calls are logged: nested, greyed out
 * when that is off. Members see them; owners and admins change them. Shopify: the checks a caller must pass only
 * matter while the assistant may change an order (greyed out and locked until one change is on), and one check always
 * stays on (the server refuses none): the last one that is on is locked.
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
  const on = (id: AppSettingId) => appSettingOn(connection.settings, id, app)
  const logging = on('log_calls')
  const changing = SHOP_CHANGE_SETTINGS.some(on)
  // The order number only names the order: it never counts as the one check that must stay on.
  const checksOn = SHOP_VERIFY_SETTINGS.filter(id => id !== 'verify_order_number' && on(id)).length
  const set = (id: AppSettingId, value: boolean) =>
    void run('app.updateSettings', {
      id: connection.id,
      settings: appSettingsWith(app, connection.settings, id, value),
    })

  function row(id: AppSettingId) {
    const text = settingText(app, id)
    const inverted = INVERTED.includes(id)
    return (
      <SwitchRow
        key={id}
        title={t(text.title)}
        description={t(text.help, { name })}
        tip={t(text.tip, { name })}
        on={inverted ? !on(id) : on(id)}
        onChange={value => set(id, inverted ? !value : value)}
        disabled={!canEdit}
        nested={AFTER_LOG_CALLS.includes(id)}
        dimmed={AFTER_LOG_CALLS.includes(id) && !logging}
      />
    )
  }

  /** One caller check as a checkbox: it adds a step for the caller, it gives the assistant nothing. */
  function check(id: ShopVerify) {
    const text = settingText(app, id)
    const last = id !== 'verify_order_number' && on(id) && checksOn <= 1
    return (
      <div key={id} className={`ig-check${changing ? '' : ' is-dimmed'}`}>
        <Checkbox checked={on(id)} onChange={value => set(id, value)} disabled={!canEdit || last || !changing}>
          <span
            title={
              last
                ? t('settings.integrations.app.shopify.lastCheckTip')
                : changing
                  ? t(text.tip, { name })
                  : t('settings.integrations.app.shopify.checksIdleTip')
            }
          >
            <b>{t(text.title)}</b>
            <span className="help">{t(text.help, { name })}</span>
          </span>
        </Checkbox>
      </div>
    )
  }

  const groups = SETTING_GROUPS[app]
  const [editing, setEditing] = useState(false)
  if (app === 'shopify' && !editing)
    return (
      <Section
        id="ig-app-settings"
        title={t('settings.integrations.app.settings.title')}
        help={t('settings.integrations.app.settings.help', { name })}
      >
        <ShopifySetupSummary
          on={on}
          canEdit={canEdit}
          onEdit={() => setEditing(true)}
          onRecommended={() =>
            void run('app.updateSettings', { id: connection.id, settings: shopifyRecommendedSettings() })
          }
          recommended={isShopifyRecommended(connection.settings)}
        />
      </Section>
    )
  return (
    <Section
      id="ig-app-settings"
      title={t('settings.integrations.app.settings.title')}
      help={t('settings.integrations.app.settings.help', { name })}
    >
      {app === 'shopify' && (
        <div className="ig-setup-done">
          <Button variant="ghost" onClick={() => setEditing(false)}>
            {t('settings.integrations.app.shopify.setup.done')}
          </Button>
        </div>
      )}
      {groups ? (
        <div className="ig-swgroups">
          {groups.map(g => (
            <section key={g.title} className="ig-swgroup" aria-label={t(g.title)}>
              <h3>{t(g.title)}</h3>
              {g.help && <p className="help">{t(g.help, { name })}</p>}
              <div className="st-swlist">{g.ids.map(row)}</div>
            </section>
          ))}
          {app === 'shopify' && (
            <section className="ig-verify" aria-label={t('settings.integrations.app.shopify.group.verify')}>
              <h3>
                <Icon name="shield" size={14} />
                {t('settings.integrations.app.shopify.group.verify')}
                <Badge tone="outline">{t('settings.integrations.app.shopify.verify.badge')}</Badge>
              </h3>
              <p className="help">{t('settings.integrations.app.shopify.group.verifyHelp')}</p>
              {!changing && <p className="help">{t('settings.integrations.app.shopify.verify.idle')}</p>}
              {changing && checksOn <= 1 && <p className="help">{t('settings.integrations.app.shopify.lastCheck')}</p>}
              <div className="ig-checks">{SHOP_VERIFY_SETTINGS.map(check)}</div>
            </section>
          )}
        </div>
      ) : (
        <div className="st-swlist">{APP_SETTINGS[app].map(row)}</div>
      )}
    </Section>
  )
}

const CHECK_WORDS: Record<(typeof SHOP_VERIFY_SETTINGS)[number], MessageKey> = {
  verify_name: msg('settings.integrations.app.shopify.setup.check.name'),
  verify_postcode: msg('settings.integrations.app.shopify.setup.check.postcode'),
  verify_email: msg('settings.integrations.app.shopify.setup.check.email'),
  verify_order_number: msg('settings.integrations.app.shopify.setup.check.orderNumber'),
  verify_caller_number: msg('settings.integrations.app.shopify.setup.check.callerNumber'),
}

/**
 * Shopify's switches in two short columns, what is on and what is off: "Recommended setup" when they are the setup Linedesk
 * recommends for most online stores (SHOPIFY_RECOMMENDED), else "Custom setup" with a way back to it. Edit setup shows
 * every switch.
 */
function ShopifySetupSummary({
  on,
  canEdit,
  recommended,
  onEdit,
  onRecommended,
}: {
  on: (id: AppSettingId) => boolean
  canEdit: boolean
  recommended: boolean
  onEdit: () => void
  onRecommended: () => void
}) {
  const t = useT()
  const format = useFormat()
  const changes = SHOP_CHANGE_SETTINGS.filter(on)
  const checks = SHOP_VERIFY_SETTINGS.filter(on)
  const badge = (
    <Badge tone={recommended ? 'ok' : 'outline'}>
      {t(
        recommended
          ? 'settings.integrations.app.shopify.setup.recommended'
          : 'settings.integrations.app.shopify.setup.custom',
      )}
    </Badge>
  )
  const actions = canEdit && (
    <div className="ig-setup-actions">
      <Button onClick={onEdit} title={t('settings.integrations.app.shopify.setup.editTip')}>
        {t('settings.integrations.app.shopify.setup.edit')}
      </Button>
      {!recommended && (
        <Button
          variant="ghost"
          onClick={onRecommended}
          title={t('settings.integrations.app.shopify.setup.useRecommendedTip')}
        >
          {t('settings.integrations.app.shopify.setup.useRecommended')}
        </Button>
      )}
    </div>
  )
  // The columns hold only what the assistant may do; the caller checks give nothing and get their own line.
  const ids: AppSettingId[] = ['log_calls', 'fill_fields', 'create_contacts', ...SHOP_CHANGE_SETTINGS]
  const label = (id: AppSettingId) => t(settingText('shopify', id).title)
  return (
    <div className="ig-setup">
      <div className="ig-setup-head">
        {badge}
        <span className="help">
          {t(
            recommended
              ? 'settings.integrations.app.shopify.setup.recommendedHelp'
              : 'settings.integrations.app.shopify.setup.customHelp',
          )}
        </span>
      </div>
      <div className="ig-setup-cols">
        {[true, false].map(state => {
          const items = ids.filter(id => on(id) === state)
          return (
            <section key={String(state)} className={`ig-setup-col ${state ? 'is-on' : 'is-off'}`}>
              <h3>
                {t(
                  state
                    ? 'settings.integrations.app.shopify.setup.onCol'
                    : 'settings.integrations.app.shopify.setup.offCol',
                )}
                <span className="ig-setup-count">{items.length}</span>
              </h3>
              <ul>
                {items.map(id => (
                  <li key={id}>
                    <Icon name={state ? 'check' : 'close'} size={14} />
                    <span>{label(id)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
      <p className="ig-setup-verify">
        <Icon name="shield" size={14} />
        <span>
          {changes.length
            ? t('settings.integrations.app.shopify.setup.verifyLine', {
                checks: format.list(checks.map(id => t(CHECK_WORDS[id]))),
              })
            : t('settings.integrations.app.shopify.setup.verifyNone')}
        </span>
      </p>
      {actions}
    </div>
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
