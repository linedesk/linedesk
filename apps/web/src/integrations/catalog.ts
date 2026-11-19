// Integrations (#integrations): the catalog of everything Linedesk connects to, by category, without React. Only what
// works today opens something: Zapier, Make and n8n (through the assistant's webhooks), the assistant's webhooks, the
// calendar providers (Booking & calendar; one this server does not offer says so), API keys, the REST API and the MCP
// server. Each opens its detail view here (`#integrations/<id>`) or the place where it is set up, also as a link
// (`#integrations/make` goes to the webhooks). HubSpot, Slack and Jobber are connected apps (OAuth, docs/crm-sync.md):
// their detail view connects them. One that is not built (ServiceTitan) shows as "Coming soon" and opens nothing.
// Phone carriers are not here: they are Server admin's (provider keys).
// To add one (a CLI, once it has an install command): one entry in CATALOG, its name and line in
// settings.json (settings.integrations.card.<id>.*), and its status in statusOf.
import { type MessageKey, msg } from '@linedesk/i18n'
import {
  APP_SETTINGS,
  type AppConnectError,
  type AppSettingId,
  appSettingOn,
  type ConnectableApp,
  claudeConnectorLink,
  cursorMcpInstallLink,
  isAppConnectError,
  vscodeMcpInstallLink,
} from '@linedesk/actions'
import type { AppConnection, AppErrorCode } from '@linedesk/db/types'
import type { ProviderId } from '../settings/calendarModel.ts'

export type CategoryId = 'automation' | 'calendars' | 'crm' | 'chat' | 'developers'
export const CATEGORIES: readonly CategoryId[] = ['automation', 'calendars', 'crm', 'chat', 'developers']

export const CATEGORY_LABEL: Record<CategoryId, MessageKey> = {
  automation: msg('settings.integrations.category.automation'),
  calendars: msg('settings.integrations.category.calendars'),
  crm: msg('settings.integrations.category.crm'),
  chat: msg('settings.integrations.category.chat'),
  developers: msg('settings.integrations.category.developers'),
}

/** Integrations with a detail view on this page; every other card opens the place where it is set up. */
export const DETAIL_IDS = ['zapier', 'hubspot', 'slack', 'jobber', 'api-keys', 'rest-api', 'mcp'] as const
export type DetailId = (typeof DETAIL_IDS)[number]

/** Not built yet: shown as "Coming soon", they open nothing. */
export const IN_PROGRESS_IDS = ['servicetitan'] as const
export type InProgressId = (typeof IN_PROGRESS_IDS)[number]

export type IntegrationId = DetailId | 'make' | 'n8n' | 'webhooks' | ProviderId | InProgressId

/**
 * A card's logo (no hotlinked images): a sign-in mark the app already ships (calendars), a Simple Icons path from
 * admin/logos.ts in the brand's colour, an icon of ours, or a monogram where no free mark exists.
 */
export type Mark =
  | { kind: 'brand'; brand: 'google' | 'microsoft' | 'calcom' | 'calendly' | 'icloud' }
  | { kind: 'logo'; logo: 'zapier' | 'make' | 'n8n' | 'hubspot' | 'slack' | 'modelcontextprotocol'; color: string }
  | { kind: 'icon'; icon: 'globe' | 'server' | 'shield' }
  | { kind: 'monogram'; text: string; color: string }

export type Integration = {
  id: IntegrationId
  category: CategoryId
  mark: Mark
  /** Where the card goes: its detail view here, or a place in the app (a hash route); null while it is being built. */
  opens: string | null
  /** Extra words search finds it by (not shown). */
  keywords: string
}

const detail = (id: DetailId) => `#integrations/${id}`
const WEBHOOKS = '#assistant/advanced/webhook'
const BOOKING = '#assistant/booking'

export const CATALOG: readonly Integration[] = [
  {
    id: 'zapier',
    category: 'automation',
    mark: { kind: 'logo', logo: 'zapier', color: '#FF4F00' },
    opens: detail('zapier'),
    keywords: 'zap automation triggers actions',
  },
  {
    id: 'make',
    category: 'automation',
    mark: { kind: 'logo', logo: 'make', color: '#6D00CC' },
    opens: WEBHOOKS,
    keywords: 'integromat scenario webhook automation',
  },
  {
    id: 'n8n',
    category: 'automation',
    mark: { kind: 'logo', logo: 'n8n', color: '#EA4B71' },
    opens: WEBHOOKS,
    keywords: 'workflow webhook automation self-hosted',
  },
  {
    id: 'webhooks',
    category: 'automation',
    mark: { kind: 'icon', icon: 'globe' },
    opens: WEBHOOKS,
    keywords: 'http post url signed call start during after lookup',
  },
  {
    id: 'google',
    category: 'calendars',
    mark: { kind: 'brand', brand: 'google' },
    opens: BOOKING,
    keywords: 'gmail workspace calendar booking appointments',
  },
  {
    id: 'microsoft',
    category: 'calendars',
    mark: { kind: 'brand', brand: 'microsoft' },
    opens: BOOKING,
    keywords: 'outlook office 365 exchange calendar booking appointments',
  },
  {
    id: 'caldav',
    category: 'calendars',
    mark: { kind: 'brand', brand: 'icloud' },
    opens: BOOKING,
    keywords: 'apple icloud caldav fastmail nextcloud calendar booking',
  },
  {
    id: 'calcom',
    category: 'calendars',
    mark: { kind: 'brand', brand: 'calcom' },
    opens: BOOKING,
    keywords: 'cal.com scheduling event types booking',
  },
  {
    id: 'calendly',
    category: 'calendars',
    mark: { kind: 'brand', brand: 'calendly' },
    opens: BOOKING,
    keywords: 'scheduling event types booking',
  },
  {
    id: 'hubspot',
    category: 'crm',
    mark: { kind: 'logo', logo: 'hubspot', color: '#FF7A59' },
    opens: detail('hubspot'),
    keywords: 'crm contacts call log sync',
  },
  {
    id: 'jobber',
    category: 'crm',
    mark: { kind: 'monogram', text: 'J', color: '#7DB00E' },
    opens: detail('jobber'),
    keywords: 'field service jobs clients requests home service',
  },
  {
    id: 'servicetitan',
    category: 'crm',
    mark: { kind: 'monogram', text: 'ST', color: '#0B57D0' },
    opens: null,
    keywords: 'field service jobs bookings customers hvac plumbing',
  },
  {
    id: 'slack',
    category: 'chat',
    mark: { kind: 'logo', logo: 'slack', color: '#4A154B' },
    opens: detail('slack'),
    keywords: 'team chat channel notify message',
  },
  {
    id: 'api-keys',
    category: 'developers',
    mark: { kind: 'icon', icon: 'shield' },
    opens: detail('api-keys'),
    keywords: 'token bearer key developer',
  },
  {
    id: 'rest-api',
    category: 'developers',
    mark: { kind: 'icon', icon: 'server' },
    opens: detail('rest-api'),
    keywords: 'http openapi actions developer curl',
  },
  {
    id: 'mcp',
    category: 'developers',
    mark: { kind: 'logo', logo: 'modelcontextprotocol', color: 'currentColor' },
    opens: detail('mcp'),
    keywords: 'model context protocol ai agent claude code cursor codex llm',
  },
]

const isInProgress = (id: IntegrationId): id is InProgressId => (IN_PROGRESS_IDS as readonly string[]).includes(id)

// i18n-dynamic: settings.integrations.card.*
export const nameKey = (id: IntegrationId) => `settings.integrations.card.${id}.name` as MessageKey
export const lineKey = (id: IntegrationId) => `settings.integrations.card.${id}.line` as MessageKey

/** The cards whose name, line, category or keywords contain every word of `query` (any case). */
export function searchIntegrations(
  list: readonly Integration[],
  query: string,
  text: (key: MessageKey) => string,
): Integration[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...list]
  return list.filter(i => {
    const haystack = [text(nameKey(i.id)), text(lineKey(i.id)), text(CATEGORY_LABEL[i.category]), i.id, i.keywords]
      .join(' ')
      .toLowerCase()
    return words.every(w => haystack.includes(w))
  })
}

/** The cards by category, in catalog order; `only` keeps one category; empty categories are left out. */
export function byCategory(
  list: readonly Integration[],
  only: CategoryId | null = null,
): { category: CategoryId; items: Integration[] }[] {
  return CATEGORIES.filter(c => only === null || c === only)
    .map(category => ({ category, items: list.filter(i => i.category === category) }))
    .filter(g => g.items.length > 0)
}

/**
 * What the workspace has set up, as far as this person can read it: `undefined` while it loads, `null` where they
 * can't read it (a member: Zaps and keys are for owners and admins).
 */
export type Facts = {
  /** Zapier subscriptions (owners and admins). */
  zaps: number | null | undefined
  /** Working API keys (owners and admins). */
  apiKeys: number | null | undefined
  /** The assistants' webhook addresses (synced; only admins get the rows). */
  webhookUrls: readonly string[] | null | undefined
  /** Calendar accounts by provider (synced). */
  calendars: Partial<Record<ProviderId, number>> | undefined
  /**
   * The calendar providers this server can connect (Server admin switches CalDAV, Cal.com and Calendly on; Google and
   * Microsoft need their app); null while not known.
   */
  calendarProviders: readonly ProviderId[] | null
  /** The state of each connected app (synced); an app missing here is not connected. */
  apps: Partial<Record<ConnectableApp, AppConnection['status']>> | undefined
}

export type Status =
  /** Set up: `count` things (Zaps, keys, accounts, webhooks) when it says how many. */
  | { kind: 'connected'; count?: number }
  | { kind: 'notConnected' }
  /** Connected, but the app refused the grant or calls failed several times in a row (a connected app). */
  | { kind: 'needsAttention' }
  /** Nothing to connect: works with an API key (REST API, MCP). */
  | { kind: 'ready' }
  | { kind: 'loading' }
  /** Only owners and admins can see it (this person is a member). */
  | { kind: 'adminsOnly' }
  /** Not built yet: nothing to connect. */
  | { kind: 'inProgress' }
  /** A calendar provider this server does not offer (Server admin can switch it on). */
  | { kind: 'unavailable' }

const counted = (n: number | null | undefined): Status =>
  n === undefined
    ? { kind: 'loading' }
    : n === null
      ? { kind: 'adminsOnly' }
      : n > 0
        ? { kind: 'connected', count: n }
        : { kind: 'notConnected' }

/** Whether a webhook address belongs to the service (Make: hook.<zone>.make.com; n8n Cloud: <name>.app.n8n.cloud). */
const HOOK_HOSTS: Record<'make' | 'n8n', RegExp> = { make: /(^|\.)make\.com$/i, n8n: /(^|\.)n8n\.cloud$/i }
function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export function statusOf(id: IntegrationId, facts: Facts): Status {
  if (isInProgress(id)) return { kind: 'inProgress' }
  switch (id) {
    case 'zapier':
      return counted(facts.zaps)
    case 'api-keys':
      return counted(facts.apiKeys)
    case 'rest-api':
    case 'mcp':
      return { kind: 'ready' }
    case 'hubspot':
    case 'slack':
    case 'jobber': {
      if (facts.apps === undefined) return { kind: 'loading' }
      const state = facts.apps[id]
      return state === 'connected'
        ? { kind: 'connected' }
        : state === 'needs_attention'
          ? { kind: 'needsAttention' }
          : { kind: 'notConnected' }
    }
    case 'webhooks':
      return counted(facts.webhookUrls === null ? null : facts.webhookUrls?.length)
    case 'make':
    case 'n8n':
      // Connected when a webhook goes to the service's own host; a self-hosted n8n can't be told apart.
      if (facts.webhookUrls === undefined) return { kind: 'loading' }
      if (facts.webhookUrls === null) return { kind: 'adminsOnly' }
      return facts.webhookUrls.some(u => HOOK_HOSTS[id].test(hostOf(u)))
        ? { kind: 'connected' }
        : { kind: 'notConnected' }
    default:
      if (facts.calendarProviders && !facts.calendarProviders.includes(id)) return { kind: 'unavailable' }
      return facts.calendars === undefined || facts.calendarProviders === null
        ? { kind: 'loading' }
        : counted(facts.calendars[id] ?? 0)
  }
}

/**
 * The page's place in the hash: the catalog, one integration's detail view (`#integrations/zapier`), the place in the
 * app where a card without a detail view is set up (`#integrations/make` goes to the assistant's webhooks), or a note
 * that there is nothing at that address (an unknown id, one not built yet, a path below a detail view).
 */
export type IntegrationsPlace =
  | { view: 'catalog' }
  | { view: 'detail'; id: DetailId }
  | { view: 'elsewhere'; to: string }
  | { view: 'missing'; section: string }

export function placeOf(hash: string): IntegrationsPlace {
  const path = hash.replace(/^#/, '').split('?')[0]!.replace(/\/+$/, '')
  const [page, id, ...rest] = path.split('/')
  if (page !== 'integrations' || !id) return { view: 'catalog' }
  const section = [id, ...rest].join('/')
  if (rest.length) return { view: 'missing', section }
  if ((DETAIL_IDS as readonly string[]).includes(id)) return { view: 'detail', id: id as DetailId }
  const opens = CATALOG.find(i => i.id === id)?.opens
  return opens ? { view: 'elsewhere', to: opens } : { view: 'missing', section }
}

/**
 * What the OAuth callback of a connected app put into the hash (`#integrations/hubspot?app=connected` or
 * `…?app=error&reason=<code>`): whether it worked and why not, or null when the hash carries no result. Only the
 * known codes count: any other reason (a link someone made up) is the generic `failed`, never shown as text.
 */
export function appConnectResult(hash: string): { ok: true } | { ok: false; reason: AppConnectError } | null {
  const query = hash.split('?')[1]
  if (!query) return null
  const params = new URLSearchParams(query)
  const result = params.get('app')
  if (result === 'connected') return { ok: true }
  if (result === 'error') {
    const reason = params.get('reason')
    return { ok: false, reason: isAppConnectError(reason) ? reason : 'failed' }
  }
  return null
}

const CONNECT_ERROR: Record<AppConnectError, MessageKey> = {
  denied: msg('settings.integrations.app.error.denied'),
  signed_out: msg('settings.integrations.app.error.signedOut'),
  expired: msg('settings.integrations.app.error.expired'),
  not_yours: msg('settings.integrations.app.error.notYours'),
  scope: msg('settings.integrations.app.error.scope'),
  no_grant: msg('settings.integrations.app.error.noGrant'),
  not_set_up: msg('settings.integrations.app.error.notSetUp'),
  no_secrets_key: msg('settings.integrations.app.error.noSecretsKey'),
  not_connected: msg('settings.integrations.app.error.notConnected'),
  failed: msg('settings.integrations.app.connectFailed'),
}

/**
 * The text (with `{name}`) for why connecting or disconnecting an app did not work: the callback's reason or the
 * `code` of an action's rejection. Anything else gets `fallback`.
 */
export const appConnectErrorKey = (code: unknown, fallback: MessageKey = CONNECT_ERROR.failed): MessageKey =>
  isAppConnectError(code) ? CONNECT_ERROR[code] : fallback

const PUSH_ERROR: Record<AppErrorCode, MessageKey> = {
  auth: msg('settings.integrations.app.pushError.auth'),
  rate_limited: msg('settings.integrations.app.pushError.rateLimited'),
  unavailable: msg('settings.integrations.app.pushError.unavailable'),
  invalid: msg('settings.integrations.app.pushError.invalid'),
  not_found: msg('settings.integrations.app.pushError.notFound'),
  call_deleted: msg('settings.integrations.app.pushError.callDeleted'),
  no_caller_id: msg('settings.integrations.app.pushError.noCallerId'),
  internal: msg('settings.integrations.app.pushError.internal'),
  calls_off: msg('settings.integrations.app.pushError.callsOff'),
  no_contact: msg('settings.integrations.app.pushError.noContact'),
  channel_not_found: msg('settings.integrations.app.pushError.channelNotFound'),
  channel_archived: msg('settings.integrations.app.pushError.channelArchived'),
  not_urgent: msg('settings.integrations.app.pushError.notUrgent'),
}

/**
 * The switches app.updateSettings gets when one of them changes: every switch of the app, as shown, with the one
 * changed. Whole, so the optimistic row is whole too (the server merges them into what is stored).
 */
export const appSettingsWith = (
  app: ConnectableApp,
  stored: Readonly<Record<string, boolean>> | null | undefined,
  id: AppSettingId,
  on: boolean,
): Record<AppSettingId, boolean> =>
  Object.fromEntries(APP_SETTINGS[app].map(s => [s, s === id ? on : appSettingOn(stored, s)])) as Record<
    AppSettingId,
    boolean
  >

/** The text (with `{name}`) for why a call did not go to a connected app; an unknown code is `internal`'s. */
/** Codes whose words differ per app: Jobber calls a contact a client. */
const APP_PUSH_ERROR: Partial<Record<ConnectableApp, Partial<Record<AppErrorCode, MessageKey>>>> = {
  jobber: {
    not_found: msg('settings.integrations.app.jobber.pushError.notFound'),
    no_caller_id: msg('settings.integrations.app.jobber.pushError.noCallerId'),
    no_contact: msg('settings.integrations.app.jobber.pushError.noContact'),
  },
}

export const appPushErrorKey = (code: string, app?: ConnectableApp): MessageKey =>
  (app && APP_PUSH_ERROR[app]?.[code as AppErrorCode]) ?? PUSH_ERROR[code as AppErrorCode] ?? PUSH_ERROR.internal

/** The MCP server and REST API addresses of this install. */
export const mcpAddress = (origin: string) => `${origin}/mcp`
export const openApiAddress = (origin: string) => `${origin}/v1/openapi.json`

/** The environment variable the setup snippets read the key from, so no key is ever written into them. */
export const KEY_VARIABLE = 'LINEDESK_KEY'

/** Adding the MCP server to Claude Code: one command; the first use signs in with OAuth in the browser (LIN-126). */
export const claudeCodeCommand = (origin: string) => `claude mcp add --transport http linedesk ${mcpAddress(origin)}`

/** Adding it to Codex: Codex signs in with OAuth on its own (`codex mcp login linedesk` signs in again). */
export const codexCommand = (origin: string) => `codex mcp add linedesk --url ${mcpAddress(origin)}`

/** Adding it to Gemini CLI: it finds the OAuth sign-in from the server's 401. */
export const geminiCommand = (origin: string) => `gemini mcp add --transport http linedesk ${mcpAddress(origin)}`

/** Cursor's one-click install link (agent-client-links.ts): the address alone, the sign-in is OAuth. */
export const cursorInstallLink = (origin: string) => cursorMcpInstallLink('linedesk', mcpAddress(origin))

/**
 * Claude's install link (agent-client-links.ts): opens Add custom connector with the install's name and the address
 * filled in, the sign-in is OAuth. `admin`: the organization's connector settings, for an owner of Claude Team or
 * Enterprise.
 */
export const claudeInstallLink = (origin: string, name: string, admin = false) =>
  claudeConnectorLink(name, mcpAddress(origin), admin)

/** VS Code's (or VS Code Insiders') one-click install link: the address alone, the sign-in is OAuth. */
export const vscodeInstallLink = (origin: string, insiders = false) =>
  vscodeMcpInstallLink('linedesk', mcpAddress(origin), insiders)

/** With an API key instead of the sign-in (a client that cannot do OAuth): Claude Code. */
export const claudeCodeKeyCommand = (origin: string) =>
  `${claudeCodeCommand(origin)} --header "Authorization: Bearer $${KEY_VARIABLE}"`

/** With an API key instead of the sign-in: clients that read an `mcpServers` JSON file. */
export function mcpJson(origin: string): string {
  // i18n-ignore: the client's header value, not UI text
  const authorization = `Bearer \${env:${KEY_VARIABLE}}`
  return JSON.stringify(
    { mcpServers: { linedesk: { url: mcpAddress(origin), headers: { Authorization: authorization } } } },
    null,
    2,
  )
}

/** A first REST call: the key's workspace (GET /v1/api-key). */
export const curlExample = (origin: string) =>
  `curl ${origin}/v1/api-key \\\n  -H "Authorization: Bearer $${KEY_VARIABLE}"`
