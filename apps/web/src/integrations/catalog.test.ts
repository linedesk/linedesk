import type { MessageKey } from '@linedesk/i18n'
import en from '@linedesk/i18n/locales/en/settings.json'
import { describe, expect, it } from 'vitest'
import {
  availableIntegrations,
  byCategory,
  CATALOG,
  CATEGORIES,
  claudeCodeCommand,
  DETAIL_IDS,
  IN_PROGRESS_IDS,
  type Facts,
  lineKey,
  mcpJson,
  nameKey,
  placeOf,
  searchIntegrations,
  statusOf,
} from './catalog.ts'

const text = (key: MessageKey) => (en as Record<string, string>)[key.replace(/^settings\./, '')] ?? key
const ids = (list: readonly { id: string }[]) => list.map(i => i.id)

const NOTHING: Facts = { zaps: 0, apiKeys: 0, webhookUrls: [], calendars: {} }
const LOADING: Facts = {
  zaps: undefined,
  apiKeys: undefined,
  webhookUrls: undefined,
  calendars: undefined,
}
const MEMBER: Facts = { zaps: null, apiKeys: null, webhookUrls: null, calendars: {} }

describe('the catalog', () => {
  it('has a name and a line for every card, and a category that exists', () => {
    for (const i of CATALOG) {
      expect(text(nameKey(i.id)), i.id).not.toBe(nameKey(i.id))
      expect(text(lineKey(i.id)), i.id).not.toBe(lineKey(i.id))
      expect(CATEGORIES).toContain(i.category)
    }
  })

  it('opens a detail view here for every detail id, nothing while in progress, and a place in the app for the rest', () => {
    for (const i of CATALOG) {
      if ((DETAIL_IDS as readonly string[]).includes(i.id)) expect(i.opens).toBe(`#integrations/${i.id}`)
      else if ((IN_PROGRESS_IDS as readonly string[]).includes(i.id)) expect(i.opens).toBeNull()
      else expect(i.opens).toMatch(/^#assistant\//)
    }
  })

  it('groups the cards in catalog order and leaves empty categories out', () => {
    const groups = byCategory(CATALOG)
    expect(groups.map(g => g.category)).toEqual(['automation', 'calendars', 'crm', 'chat', 'developers'])
    expect(ids(groups[0]!.items)).toEqual(['zapier', 'make', 'n8n', 'webhooks'])
    expect(ids(groups[2]!.items)).toEqual(['hubspot', 'jobber', 'servicetitan'])
    expect(ids(groups[4]!.items)).toEqual(['api-keys', 'rest-api', 'mcp'])
    expect(byCategory(CATALOG, 'chat').map(g => g.category)).toEqual(['chat'])
    expect(byCategory(searchIntegrations(CATALOG, 'outlook', text)).map(g => g.category)).toEqual(['calendars'])
  })

  it('shows only the calendar providers the install offers, all of them while unknown', () => {
    expect(availableIntegrations(null)).toHaveLength(CATALOG.length)
    const shown = ids(availableIntegrations(['google', 'calcom']))
    expect(shown).toContain('google')
    expect(shown).toContain('calcom')
    expect(shown).not.toContain('microsoft')
    expect(shown).not.toContain('calendly')
    expect(shown).toContain('zapier')
  })
})

describe('searchIntegrations', () => {
  it('finds by name, line, category and keywords, any case, every word', () => {
    // API keys says what it is for (Zapier), so it is found too.
    expect(ids(searchIntegrations(CATALOG, 'ZAPIER', text))).toEqual(['zapier', 'api-keys'])
    expect(ids(searchIntegrations(CATALOG, 'outlook', text))).toEqual(['microsoft'])
    expect(ids(searchIntegrations(CATALOG, 'claude', text))).toEqual(['mcp'])
    expect(ids(searchIntegrations(CATALOG, 'hvac', text))).toEqual(['servicetitan'])
    expect(ids(searchIntegrations(CATALOG, 'webhook n8n', text))).toEqual(['n8n'])
  })
  it('keeps everything for an empty query and nothing for an unknown word', () => {
    expect(searchIntegrations(CATALOG, '  ', text)).toHaveLength(CATALOG.length)
    expect(searchIntegrations(CATALOG, 'salesforce', text)).toEqual([])
  })
})

describe('statusOf', () => {
  it('counts Zaps, keys, webhooks and calendar accounts', () => {
    const facts: Facts = {
      ...NOTHING,
      zaps: 3,
      apiKeys: 1,
      webhookUrls: ['https://example.com/hook'],
      calendars: { google: 2 },
    }
    expect(statusOf('zapier', facts)).toEqual({ kind: 'connected', count: 3 })
    expect(statusOf('api-keys', facts)).toEqual({ kind: 'connected', count: 1 })
    expect(statusOf('webhooks', facts)).toEqual({ kind: 'connected', count: 1 })
    expect(statusOf('google', facts)).toEqual({ kind: 'connected', count: 2 })
    expect(statusOf('microsoft', facts)).toEqual({ kind: 'notConnected' })
  })

  it('says not connected when nothing is set up, and ready for the REST API and MCP', () => {
    for (const id of ['zapier', 'api-keys', 'webhooks', 'make', 'n8n', 'calendly'] as const)
      expect(statusOf(id, NOTHING), id).toEqual({ kind: 'notConnected' })
    expect(statusOf('rest-api', NOTHING)).toEqual({ kind: 'ready' })
    expect(statusOf('mcp', MEMBER)).toEqual({ kind: 'ready' })
  })

  it('knows Make and n8n Cloud by their webhook host', () => {
    const make: Facts = { ...NOTHING, webhookUrls: ['https://hook.eu2.make.com/abc'] }
    const n8n: Facts = { ...NOTHING, webhookUrls: ['https://brightwater.app.n8n.cloud/webhook/1'] }
    const lookalike: Facts = { ...NOTHING, webhookUrls: ['https://notmake.com/x', 'not a url'] }
    expect(statusOf('make', make)).toEqual({ kind: 'connected' })
    expect(statusOf('n8n', make)).toEqual({ kind: 'notConnected' })
    expect(statusOf('n8n', n8n)).toEqual({ kind: 'connected' })
    expect(statusOf('make', lookalike)).toEqual({ kind: 'notConnected' })
  })

  it('says in progress for what is being built, whatever the facts', () => {
    for (const id of IN_PROGRESS_IDS)
      for (const facts of [NOTHING, LOADING, MEMBER]) expect(statusOf(id, facts), id).toEqual({ kind: 'inProgress' })
  })

  it('is loading while the facts load, and admins only for what a member cannot read', () => {
    for (const i of CATALOG) {
      const expected =
        i.id === 'rest-api' || i.id === 'mcp'
          ? 'ready'
          : (IN_PROGRESS_IDS as readonly string[]).includes(i.id)
            ? 'inProgress'
            : 'loading'
      expect(statusOf(i.id, LOADING).kind, i.id).toBe(expected)
    }
    for (const id of ['zapier', 'api-keys', 'webhooks', 'make', 'n8n'] as const)
      expect(statusOf(id, MEMBER), id).toEqual({ kind: 'adminsOnly' })
    expect(statusOf('google', MEMBER)).toEqual({ kind: 'notConnected' })
  })
})

describe('placeOf', () => {
  it('reads the detail view from the hash', () => {
    expect(placeOf('#integrations')).toEqual({ view: 'catalog' })
    expect(placeOf('#integrations/zapier')).toEqual({ view: 'detail', id: 'zapier' })
    expect(placeOf('#integrations/api-keys?ws=w1')).toEqual({ view: 'detail', id: 'api-keys' })
    expect(placeOf('#integrations/mcp')).toEqual({ view: 'detail', id: 'mcp' })
  })
  it('shows the catalog for anything else', () => {
    expect(placeOf('#integrations/google')).toEqual({ view: 'catalog' })
    expect(placeOf('#integrations/zapier/x')).toEqual({ view: 'catalog' })
    expect(placeOf('#workspace/developers')).toEqual({ view: 'catalog' })
  })
})

describe('setup snippets', () => {
  it('read the key from a variable and never contain one', () => {
    expect(claudeCodeCommand('https://desk.example')).toBe(
      'claude mcp add --transport http linedesk https://desk.example/mcp --header "Authorization: Bearer $LINEDESK_KEY"',
    )
    expect(JSON.parse(mcpJson('https://desk.example'))).toEqual({
      mcpServers: {
        linedesk: {
          url: 'https://desk.example/mcp',
          headers: { Authorization: 'Bearer ${env:LINEDESK_KEY}' },
        },
      },
    })
  })
})
