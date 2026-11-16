// Integrations (#integrations): the catalog of everything Linedesk connects to, by category, without React. Only what
// works today opens something: Zapier, Make and n8n (through the assistant's webhooks), the assistant's webhooks, the
// calendar providers this install offers, API keys, the REST API and the MCP server. Each opens its detail view here
// (`#integrations/<id>`) or the place where it is set up. The ones being built (HubSpot, Slack, Jobber, ServiceTitan)
// show as "In progress" and open nothing. Phone carriers are not here: they are Server admin's (provider keys).
// To add one (a CLI, once it has an install command): one entry in CATALOG, its name and line in
// settings.json (settings.integrations.card.<id>.*), and its status in statusOf.
import { type MessageKey, msg } from '@linedesk/i18n'
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
export const DETAIL_IDS = ['zapier', 'api-keys', 'rest-api', 'mcp'] as const
export type DetailId = (typeof DETAIL_IDS)[number]

/** Being built: shown as "In progress", they open nothing yet. */
export const IN_PROGRESS_IDS = ['hubspot', 'jobber', 'servicetitan', 'slack'] as const
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
const WEBHOOKS = '#assistant/webhooks'
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
    opens: null,
    keywords: 'crm contacts call log sync',
  },
  {
    id: 'jobber',
    category: 'crm',
    mark: { kind: 'monogram', text: 'J', color: '#7DB00E' },
    opens: null,
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
    opens: null,
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

const CALENDAR_IDS: readonly IntegrationId[] = ['google', 'microsoft', 'caldav', 'calcom', 'calendly']
const isCalendar = (id: IntegrationId): id is ProviderId => CALENDAR_IDS.includes(id)
const isInProgress = (id: IntegrationId): id is InProgressId => (IN_PROGRESS_IDS as readonly string[]).includes(id)

// i18n-dynamic: settings.integrations.card.*
export const nameKey = (id: IntegrationId) => `settings.integrations.card.${id}.name` as MessageKey
export const lineKey = (id: IntegrationId) => `settings.integrations.card.${id}.line` as MessageKey

/**
 * The cards this install offers: a calendar provider only when the install can connect it (Server admin switches
 * CalDAV, Cal.com and Calendly on; Google and Microsoft need their app); all of them while that is not known yet.
 */
export function availableIntegrations(calendarProviders: readonly ProviderId[] | null): Integration[] {
  return CATALOG.filter(i => !isCalendar(i.id) || calendarProviders === null || calendarProviders.includes(i.id))
}

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
}

export type Status =
  /** Set up: `count` things (Zaps, keys, accounts, webhooks) when it says how many. */
  | { kind: 'connected'; count?: number }
  | { kind: 'notConnected' }
  /** Nothing to connect: works with an API key (REST API, MCP). */
  | { kind: 'ready' }
  | { kind: 'loading' }
  /** Only owners and admins can see it (this person is a member). */
  | { kind: 'adminsOnly' }
  /** Being built: nothing to connect yet. */
  | { kind: 'inProgress' }

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
      return facts.calendars === undefined ? { kind: 'loading' } : counted(facts.calendars[id] ?? 0)
  }
}

/** The page's place in the hash: the catalog, or one integration's detail view (`#integrations/zapier`). */
export type IntegrationsPlace = { view: 'catalog' } | { view: 'detail'; id: DetailId }

export function placeOf(hash: string): IntegrationsPlace {
  const [page, id, ...rest] = hash.replace(/^#/, '').split('?')[0]!.split('/')
  if (page !== 'integrations' || !id || rest.length) return { view: 'catalog' }
  return (DETAIL_IDS as readonly string[]).includes(id) ? { view: 'detail', id: id as DetailId } : { view: 'catalog' }
}

/** The MCP server and REST API addresses of this install. */
export const mcpAddress = (origin: string) => `${origin}/mcp`
export const openApiAddress = (origin: string) => `${origin}/v1/openapi.json`

/** The environment variable the setup snippets read the key from, so no key is ever written into them. */
export const KEY_VARIABLE = 'LINEDESK_KEY'

/** Adding the MCP server to Claude Code: one command. */
export const claudeCodeCommand = (origin: string) =>
  `claude mcp add --transport http linedesk ${mcpAddress(origin)} --header "Authorization: Bearer $${KEY_VARIABLE}"`

/** Cursor and other clients that read an `mcpServers` JSON file. */
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
