// Integrations (#integrations, G O): everything Linedesk connects to, as cards by category, with a search and one
// key per category. A card opens its detail view here (#integrations/zapier, /hubspot, /slack, /jobber, /api-keys, /rest-api, /mcp) or
// the place where it is set up (the assistant's webhooks and booking; #integrations/make and the like go there too); one not
// built yet shows "Coming soon", and an address with nothing behind it says so. The catalog itself is catalog.ts; API keys and
// Zapier were Workspace settings › Developers (old links are rewritten, useRoute.ts).
import { CHATGPT_PLUGINS_URL, CLAUDE_CONNECTORS_URL } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { T, useT } from '@linedesk/i18n/react'
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { brandName } from '../brand.ts'
import { pollWhileVisible, useQuery } from '../cachedQuery.ts'
import { useCalendarProviders } from '../settings/calendar-providers.ts'
import type { ProviderId } from '../settings/calendarModel.ts'
import { Section } from '../settings/fields.tsx'
import { setPageKeys } from '../shell/keys.ts'
import { useRows } from '../store.tsx'
import { AppLink, appLink } from '../ui/AppLink.tsx'
import { ClientLink, ClientLinks } from '../ui/ClientLink.tsx'
import { Input } from '../ui/form.tsx'
import { copyText } from '../ui/HelpTip.tsx'
import { Badge, Button, Kbd, Note } from '../ui/kit.tsx'
import { SkeletonText, useLoadState } from '../ui/LoadStates.tsx'
import {
  byCategory,
  CATALOG,
  CATEGORIES,
  CATEGORY_LABEL,
  type CategoryId,
  claudeCodeCommand,
  claudeCodeKeyCommand,
  codexCommand,
  cursorInstallLink,
  curlExample,
  type DetailId,
  type Facts,
  geminiCommand,
  type Integration,
  type IntegrationsPlace,
  KEY_VARIABLE,
  lineKey,
  mcpAddress,
  mcpJson,
  nameKey,
  openApiAddress,
  placeOf,
  type Status,
  searchIntegrations,
  statusOf,
  vscodeInstallLink,
} from './catalog.ts'
import { ConnectedApp } from './ConnectedApp.tsx'
import {
  API_KEYS,
  ApiKeys,
  INTEGRATIONS,
  KEYS_POLL_MS,
  loadIntegrations,
  loadKeys,
  ZapierSubscriptions,
} from './Developers.tsx'
import { IntegrationMark } from './IntegrationMark.tsx'
import './integrations.css'

const SEARCH_ID = 'integrations-search'
const HOME = '#integrations'

type Props = {
  /** Owners and admins, also during support access: API keys and Zapier (settings:write). */
  canManageKeys: boolean
  toast: (text: string) => void
}

export function Integrations({ canManageKeys, toast }: Props) {
  const place = usePlace()
  const inside = place.view === 'detail' || place.view === 'missing'
  // Esc in a detail view (or the note that there is none) goes back to the catalog (the catalog's own keys are in Catalog).
  useEffect(() => {
    if (!inside) return
    setPageKeys(key => {
      if (key !== 'Escape') return false
      window.location.hash = HOME
      return true
    })
    return () => setPageKeys(null)
  }, [inside])
  return (
    <div className="page">
      <div className="page-in st-page ig-page">
        {place.view === 'detail' ? (
          <Detail id={place.id} canManageKeys={canManageKeys} toast={toast} />
        ) : place.view === 'missing' ? (
          <Missing section={place.section} />
        ) : place.view === 'catalog' ? (
          <Catalog canManageKeys={canManageKeys} />
        ) : null}
      </div>
    </div>
  )
}

/**
 * The catalog or the detail view the hash names; follows Back and links. A card set up elsewhere (#integrations/make)
 * goes to its place in the app, in place of this address in the history.
 */
function usePlace(): IntegrationsPlace {
  const [place, setPlace] = useState(() => placeOf(window.location.hash))
  useEffect(() => {
    const onHash = () => setPlace(placeOf(window.location.hash))
    window.addEventListener('hashchange', onHash)
    onHash()
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    if (place.view === 'elsewhere') window.location.replace(place.to)
  }, [place])
  return place
}

/** An address with no integration behind it: say so, with the way back, never the catalog as if nothing were wrong. */
function Missing({ section }: { section: string }) {
  const t = useT()
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('settings.integrations.title')}</h1>
        </div>
      </div>
      <Note title={t('settings.integrations.missing.title', { section })}>
        <T k="settings.integrations.missing.text" values={{ link: appLink(HOME) }} />
      </Note>
    </>
  )
}

/** What the workspace has set up, from the same cached reads and synced rows as the places that set it up. */
function useFacts(canManageKeys: boolean): Facts {
  const keys = useQuery(canManageKeys ? API_KEYS : null, loadKeys, { persist: true })
  const zaps = useQuery(canManageKeys ? INTEGRATIONS : null, loadIntegrations, { persist: true })
  useEffect(() => (canManageKeys ? pollWhileVisible(API_KEYS, KEYS_POLL_MS) : undefined), [canManageKeys])
  const hooks = useRows('webhook_endpoints')
  const hooksLoad = useLoadState('webhook_endpoints')
  const calendars = useRows('calendar_connections')
  const calendarsLoad = useLoadState('calendar_connections')
  const apps = useRows('app_connections')
  const appsLoad = useLoadState('app_connections')
  const calendarProviders = useCalendarProviders()
  return useMemo(() => {
    const perProvider: Partial<Record<ProviderId, number>> = {}
    for (const c of calendars) perProvider[c.provider] = (perProvider[c.provider] ?? 0) + 1
    return {
      zaps: canManageKeys ? zaps.data?.subscriptions.length : null,
      apiKeys: canManageKeys ? keys.data?.keys.filter(k => !k.revoked_at).length : null,
      // Webhooks that send something: on, for an assistant, with at least one hook. Only admins get these rows.
      webhookUrls: !canManageKeys
        ? null
        : hooksLoad === 'ready'
          ? hooks.filter(h => h.status === 'active' && h.assistant_id && h.hooks.length > 0).map(h => h.url)
          : undefined,
      calendars: calendarsLoad === 'ready' ? perProvider : undefined,
      calendarProviders,
      apps: appsLoad === 'ready' ? Object.fromEntries(apps.map(a => [a.provider, a.status])) : undefined,
    }
  }, [
    canManageKeys,
    zaps.data,
    keys.data,
    hooks,
    hooksLoad,
    calendars,
    calendarsLoad,
    calendarProviders,
    apps,
    appsLoad,
  ])
}

/** The keys that pick a category: 0 shows all, 1 to 4 one category each (as in the chips' tooltips). */
const categoryKey = (i: number) => String(i + 1)

function Catalog({ canManageKeys }: { canManageKeys: boolean }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState<CategoryId | null>(null)
  const facts = useFacts(canManageKeys)
  const groups = byCategory(
    searchIntegrations(CATALOG, query, k => t(k)),
    only,
  )

  const keys = useRef<(key: string) => boolean>(() => false)
  keys.current = key => {
    if (key === '/') {
      document.getElementById(SEARCH_ID)?.focus()
      return true
    }
    if (key === '0') {
      setOnly(null)
      return true
    }
    const i = CATEGORIES.findIndex((_, n) => categoryKey(n) === key)
    if (i >= 0) {
      setOnly(c => (c === CATEGORIES[i] ? null : CATEGORIES[i]!))
      return true
    }
    if (key === 'Escape' && (query || only)) {
      setQuery('')
      setOnly(null)
      return true
    }
    return false
  }
  useEffect(() => {
    setPageKeys(key => keys.current(key))
    return () => setPageKeys(null)
  }, [])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('settings.integrations.title')}</h1>
          <p>{t('settings.integrations.lede')}</p>
        </div>
      </div>
      <div className="ig-tools">
        <Input
          id={SEARCH_ID}
          type="search"
          size="sm"
          className="ig-search"
          value={query}
          placeholder={t('settings.integrations.search.placeholder')}
          aria-label={t('settings.integrations.search.label')}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          end={<Kbd keys={['/']} />}
        />
        <div className="ig-chips" role="group" aria-label={t('settings.integrations.category.label')}>
          <Chip
            label={t('settings.integrations.category.all')}
            shortcut="0"
            on={only === null}
            onClick={() => setOnly(null)}
          />
          {CATEGORIES.map((c, i) => (
            <Chip
              key={c}
              label={t(CATEGORY_LABEL[c])}
              shortcut={categoryKey(i)}
              on={only === c}
              onClick={() => setOnly(only === c ? null : c)}
            />
          ))}
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="ig-empty">{t('settings.integrations.search.none', { query })}</p>
      ) : (
        groups.map(g => (
          <section key={g.category} className="ig-group" aria-labelledby={`ig-cat-${g.category}`}>
            <h2 id={`ig-cat-${g.category}`}>{t(CATEGORY_LABEL[g.category])}</h2>
            <div className="ig-grid">
              {g.items.map(i => (
                <Card key={i.id} integration={i} status={statusOf(i.id, facts)} />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  )
}

function Chip({ label, shortcut, on, onClick }: { label: string; shortcut: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className="ig-chip" aria-pressed={on} title={`${label} (${shortcut})`} onClick={onClick}>
      {label}
    </button>
  )
}

/** One integration: its mark, name (the link over the whole card), one line and its state. */
function Card({ integration, status }: { integration: Integration; status: Status }) {
  const t = useT()
  const name = t(nameKey(integration.id))
  return (
    <article className="k-card ig-card">
      <IntegrationMark mark={integration.mark} />
      <div className="ig-card-text">
        <h3>{integration.opens ? <AppLink to={integration.opens}>{name}</AppLink> : name}</h3>
        <p>{t(lineKey(integration.id))}</p>
      </div>
      <div className="ig-card-status">
        <StatusBadge id={integration.id} status={status} />
      </div>
    </article>
  )
}

/** "No keys yet": what none means where there is nothing to connect, only something to create. */
const NONE: Partial<Record<Integration['id'], MessageKey>> = {
  'api-keys': msg('settings.integrations.status.noKeys'),
}

/** "3 Zaps", "2 keys", "1 account": what a count means on each card. */
const COUNTED: Partial<Record<Integration['id'], MessageKey>> = {
  zapier: msg('settings.integrations.status.zaps'),
  'api-keys': msg('settings.integrations.status.keys'),
  webhooks: msg('settings.integrations.status.webhooks'),
  google: msg('settings.integrations.status.accounts'),
  microsoft: msg('settings.integrations.status.accounts'),
  caldav: msg('settings.integrations.status.accounts'),
  calcom: msg('settings.integrations.status.accounts'),
  calendly: msg('settings.integrations.status.accounts'),
}

function StatusBadge({ id, status }: { id: Integration['id']; status: Status }) {
  const t = useT()
  switch (status.kind) {
    case 'loading':
      return <SkeletonText width={72} />
    case 'connected': {
      const counted = COUNTED[id]
      return (
        <Badge tone="ok" dot>
          {counted && status.count !== undefined
            ? t(counted, { count: status.count })
            : t('settings.integrations.status.connected')}
        </Badge>
      )
    }
    case 'notConnected':
      return <Badge tone="outline">{t(NONE[id] ?? 'settings.integrations.status.notConnected')}</Badge>
    case 'unavailable':
      return (
        <Badge tone="outline" title={t('settings.integrations.status.unavailableTip')}>
          {t('settings.integrations.status.unavailable')}
        </Badge>
      )
    case 'needsAttention':
      return (
        <Badge tone="danger" dot title={t('settings.integrations.status.needsAttentionTip')}>
          {t('settings.integrations.status.needsAttention')}
        </Badge>
      )
    case 'ready':
      return <Badge tone="outline">{t('settings.integrations.status.ready')}</Badge>
    case 'inProgress':
      return (
        <Badge tone="neutral" title={t('settings.integrations.status.inProgressTip')}>
          {t('settings.integrations.status.inProgress')}
        </Badge>
      )
    case 'adminsOnly':
      return (
        <Badge tone="outline" title={t('settings.integrations.status.adminsOnlyTip')}>
          {t('settings.integrations.status.adminsOnly')}
        </Badge>
      )
  }
}

/** A detail view: back to the catalog, the integration's header, and what is set up here. */
function Detail({ id, canManageKeys, toast }: { id: DetailId; canManageKeys: boolean; toast: Props['toast'] }) {
  const t = useT()
  const integration = CATALOG.find(i => i.id === id)!
  return (
    <>
      <p className="ig-back">
        <AppLink to={HOME} title={t('settings.integrations.backTip')}>
          {t('settings.integrations.back')}
        </AppLink>
      </p>
      <div className="ig-detail-head">
        <IntegrationMark mark={integration.mark} />
        <div>
          <h1>{t(nameKey(id))}</h1>
          <p>{t(lineKey(id))}</p>
        </div>
      </div>
      {id === 'zapier' && <ZapierSubscriptions canEdit={canManageKeys} toast={toast} />}
      {id === 'hubspot' && <ConnectedApp app="hubspot" canEdit={canManageKeys} toast={toast} />}
      {id === 'slack' && <ConnectedApp key="slack" app="slack" canEdit={canManageKeys} toast={toast} />}
      {id === 'jobber' && <ConnectedApp key="jobber" app="jobber" canEdit={canManageKeys} toast={toast} />}
      {id === 'api-keys' && <ApiKeys canEdit={canManageKeys} toast={toast} />}
      {id === 'rest-api' && <RestApi toast={toast} />}
      {id === 'mcp' && <Mcp toast={toast} />}
    </>
  )
}

/** The server's own address: what other programs reach (the API serves the app, so it's this page's origin). */
const origin = () => window.location.origin

function RestApi({ toast }: { toast: Props['toast'] }) {
  const t = useT()
  return (
    <Section id="ig-rest" title={t('settings.integrations.rest.title')} help={t('settings.integrations.rest.help')}>
      <CopyField label={t('settings.integrations.rest.base')} value={origin()} toast={toast} />
      <CopyField label={t('settings.integrations.rest.openapi')} value={openApiAddress(origin())} toast={toast} />
      <CopyField label={t('settings.integrations.rest.first')} value={curlExample(origin())} toast={toast} block />
      <p className="help">
        <T
          k="settings.integrations.keyNeeded"
          values={{ variable: KEY_VARIABLE, link: appLink('#integrations/api-keys') }}
        />
      </p>
    </Section>
  )
}

function Mcp({ toast }: { toast: Props['toast'] }) {
  const t = useT()
  const brand = brandName()
  return (
    <Section id="ig-mcp" title={t('settings.integrations.mcp.title')} help={t('settings.integrations.mcp.help')}>
      <CopyField label={t('settings.integrations.mcp.address')} value={mcpAddress(origin())} toast={toast} />
      <div className="ig-copy">
        <span className="ig-copy-label">{t('settings.integrations.mcp.oneClick')}</span>
        <ClientLinks
          links={[
            {
              href: cursorInstallLink(origin()),
              label: t('settings.integrations.mcp.cursor'),
              title: t('settings.integrations.mcp.cursorTip', { brand }),
            },
            {
              href: vscodeInstallLink(origin()),
              label: t('settings.integrations.mcp.vscode'),
              title: t('settings.integrations.mcp.vscodeTip', { brand }),
            },
            {
              href: vscodeInstallLink(origin(), true),
              label: t('settings.integrations.mcp.vscodeInsiders'),
              title: t('settings.integrations.mcp.vscodeTip', { brand }),
            },
          ]}
        />
      </div>
      <McpSteps
        label={t('settings.integrations.mcp.claude')}
        text={t('settings.integrations.mcp.claudeSteps')}
        open={{
          href: CLAUDE_CONNECTORS_URL,
          label: t('settings.integrations.mcp.openClaude'),
          tip: t('settings.integrations.mcp.openClaudeTip'),
        }}
        toast={toast}
      />
      <McpSteps
        label={t('settings.integrations.mcp.chatgpt')}
        text={t('settings.integrations.mcp.chatgptSteps')}
        open={{
          href: CHATGPT_PLUGINS_URL,
          label: t('settings.integrations.mcp.openChatgpt'),
          tip: t('settings.integrations.mcp.openChatgptTip'),
        }}
        toast={toast}
      />
      <CopyField
        label={t('settings.integrations.mcp.claudeCode')}
        value={claudeCodeCommand(origin())}
        toast={toast}
        block
      />
      <CopyField label={t('settings.integrations.mcp.codex')} value={codexCommand(origin())} toast={toast} block />
      <CopyField label={t('settings.integrations.mcp.gemini')} value={geminiCommand(origin())} toast={toast} block />
      <p className="help">{t('settings.integrations.mcp.firstUse')}</p>
      <details className="ig-mcp-key">
        <summary>{t('settings.integrations.mcp.withKey')}</summary>
        <div className="ig-mcp-key-body">
          <p className="help">{t('settings.integrations.mcp.withKeyHelp')}</p>
          <CopyField
            label={t('settings.integrations.mcp.claudeCodeKey')}
            value={claudeCodeKeyCommand(origin())}
            toast={toast}
            block
          />
          <CopyField label={t('settings.integrations.mcp.json')} value={mcpJson(origin())} toast={toast} block />
          <p className="help">
            <T
              k="settings.integrations.keyNeeded"
              values={{ variable: KEY_VARIABLE, link: appLink('#integrations/api-keys') }}
            />
          </p>
        </div>
      </details>
    </Section>
  )
}

/**
 * A client that is set up in its own settings: where to go there, in one line, a button that opens that page in a new
 * tab, and Copy for the server address to paste there.
 */
function McpSteps({
  label,
  text,
  open,
  toast,
}: {
  label: string
  text: string
  open: { href: string; label: string; tip: string }
  toast: Props['toast']
}) {
  const t = useT()
  const what = t('settings.integrations.mcp.address')
  async function copy() {
    const done = await copyText(mcpAddress(origin()))
    toast(t(done === 'copied' ? 'settings.integrations.copied' : 'settings.integrations.copyFailed', { what }))
  }
  return (
    <div className="ig-copy">
      <span className="ig-copy-label">{label}</span>
      <p className="help ig-mcp-steps">{text}</p>
      <div className="ig-mcp-installs">
        <ClientLink href={open.href} label={open.label} title={open.tip} />
        <Button size="sm" icon="copy" onClick={() => void copy()} title={t('settings.integrations.copyTip', { what })}>
          {t('settings.integrations.mcp.copyAddress')}
        </Button>
      </div>
    </div>
  )
}

/** A label, the text in code type, and Copy. `block`: several lines (a command, a JSON file). */
function CopyField({
  label,
  value,
  toast,
  block,
}: {
  label: string
  value: string
  toast: Props['toast']
  block?: boolean
}) {
  const t = useT()
  async function copy() {
    const done = await copyText(value)
    toast(t(done === 'copied' ? 'settings.integrations.copied' : 'settings.integrations.copyFailed', { what: label }))
  }
  return (
    <div className="ig-copy">
      <span className="ig-copy-label">{label}</span>
      <div className={block ? 'ig-copy-row ig-copy-block' : 'ig-copy-row'}>
        <pre className="ig-code">
          <code>{value}</code>
        </pre>
        <Button
          size="sm"
          icon="copy"
          onClick={() => void copy()}
          title={t('settings.integrations.copyTip', { what: label })}
        >
          {t('common.copy.copy')}
        </Button>
      </div>
    </div>
  )
}
