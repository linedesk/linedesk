import { appConnectErrors } from '@linedesk/actions'
import { appErrorCodes } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import en from '@linedesk/i18n/locales/en/settings.json'
import { describe, expect, it } from 'vitest'
import {
  appConnectErrorKey,
  appConnectResult,
  appPushErrorKey,
  appSettingsWith,
  availableIntegrations,
  byCategory,
  CATALOG,
  CATEGORIES,
  claudeCodeCommand,
  claudeCodeKeyCommand,
  codexCommand,
  cursorInstallLink,
  geminiCommand,
  vscodeInstallLink,
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
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SwitchRow } from '../settings/fields.tsx'

const text = (key: MessageKey) => (en as Record<string, string>)[key.replace(/^settings\./, '')] ?? key
const ids = (list: readonly { id: string }[]) => list.map(i => i.id)

const NOTHING: Facts = { zaps: 0, apiKeys: 0, webhookUrls: [], calendars: {}, apps: {} }
const LOADING: Facts = {
  zaps: undefined,
  apiKeys: undefined,
  webhookUrls: undefined,
  calendars: undefined,
  apps: undefined,
}
const MEMBER: Facts = { zaps: null, apiKeys: null, webhookUrls: null, calendars: {}, apps: {} }

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

  it('knows a connected app from its synced row, and when it needs attention', () => {
    expect(statusOf('hubspot', NOTHING)).toEqual({ kind: 'notConnected' })
    expect(statusOf('hubspot', MEMBER)).toEqual({ kind: 'notConnected' })
    expect(statusOf('hubspot', { ...NOTHING, apps: { hubspot: 'connected' } })).toEqual({ kind: 'connected' })
    expect(statusOf('hubspot', { ...NOTHING, apps: { hubspot: 'needs_attention' } })).toEqual({
      kind: 'needsAttention',
    })
    expect(statusOf('slack', { ...NOTHING, apps: { hubspot: 'connected' } })).toEqual({ kind: 'notConnected' })
    expect(statusOf('slack', { ...NOTHING, apps: { slack: 'connected' } })).toEqual({ kind: 'connected' })
    expect(statusOf('slack', { ...NOTHING, apps: { slack: 'needs_attention' } })).toEqual({ kind: 'needsAttention' })
    expect(statusOf('jobber', NOTHING)).toEqual({ kind: 'notConnected' })
    expect(statusOf('jobber', { ...NOTHING, apps: { hubspot: 'connected' } })).toEqual({ kind: 'notConnected' })
    expect(statusOf('jobber', { ...NOTHING, apps: { jobber: 'connected' } })).toEqual({ kind: 'connected' })
    expect(statusOf('jobber', { ...NOTHING, apps: { jobber: 'needs_attention' } })).toEqual({ kind: 'needsAttention' })
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
    expect(placeOf('#integrations/hubspot?app=connected')).toEqual({ view: 'detail', id: 'hubspot' })
  })
  it('shows the catalog for anything else', () => {
    expect(placeOf('#integrations/google')).toEqual({ view: 'catalog' })
    expect(placeOf('#integrations/zapier/x')).toEqual({ view: 'catalog' })
    expect(placeOf('#workspace/developers')).toEqual({ view: 'catalog' })
  })
})

describe('appConnectResult', () => {
  it("reads the OAuth callback's result from the hash", () => {
    expect(appConnectResult('#integrations/hubspot')).toBeNull()
    expect(appConnectResult('#integrations/hubspot?ws=w1')).toBeNull()
    expect(appConnectResult('#integrations/hubspot?app=connected')).toEqual({ ok: true })
    expect(appConnectResult('#integrations/hubspot?app=error&reason=denied')).toEqual({ ok: false, reason: 'denied' })
    // Text someone put into a link is never shown: only the known codes count.
    expect(appConnectResult('#integrations/hubspot?app=error&reason=Call%20555-0100%20to%20fix%20this')).toEqual({
      ok: false,
      reason: 'failed',
    })
    expect(appConnectResult('#integrations/hubspot?app=error')).toEqual({ ok: false, reason: 'failed' })
  })

  it('words every reason and error code, and an unknown one with the generic text', () => {
    for (const code of appConnectErrors) expect(text(appConnectErrorKey(code)), code).not.toBe(appConnectErrorKey(code))
    expect(appConnectErrorKey('forbidden')).toBe('settings.integrations.app.connectFailed')
    expect(appConnectErrorKey(undefined, msg('settings.integrations.app.disconnectFailed'))).toBe(
      'settings.integrations.app.disconnectFailed',
    )
    for (const code of appErrorCodes) expect(text(appPushErrorKey(code)), code).not.toBe(appPushErrorKey(code))
    expect(appPushErrorKey('something_new')).toBe('settings.integrations.app.pushError.internal')
  })
})

describe('setup snippets', () => {
  it('connect with the server address alone (OAuth sign-in)', () => {
    const origin = 'https://desk.example'
    expect(claudeCodeCommand(origin)).toBe('claude mcp add --transport http linedesk https://desk.example/mcp')
    expect(codexCommand(origin)).toBe('codex mcp add linedesk --url https://desk.example/mcp')
    expect(geminiCommand(origin)).toBe('gemini mcp add --transport http linedesk https://desk.example/mcp')
    const cursor = new URL(cursorInstallLink(origin))
    expect(cursor.protocol).toBe('cursor:')
    expect(cursor.searchParams.get('name')).toBe('linedesk')
    expect(JSON.parse(atob(cursor.searchParams.get('config') ?? ''))).toEqual({ url: 'https://desk.example/mcp' })
    const vscode = vscodeInstallLink(origin)
    expect(vscode.startsWith('vscode:mcp/install?')).toBe(true)
    expect(JSON.parse(decodeURIComponent(vscode.slice('vscode:mcp/install?'.length)))).toEqual({
      name: 'linedesk',
      type: 'http',
      url: 'https://desk.example/mcp',
    })
  })

  it('read the key from a variable and never contain one', () => {
    expect(claudeCodeKeyCommand('https://desk.example')).toBe(
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

describe('What Linedesk does (app switches, LIN-367)', () => {
  it('sends every switch, as shown, with the one changed', () => {
    expect(appSettingsWith('hubspot', {}, 'create_contacts', false)).toEqual({
      log_calls: true,
      create_contacts: false,
      fill_fields: true,
    })
    expect(appSettingsWith('hubspot', { fill_fields: false }, 'log_calls', false)).toEqual({
      log_calls: false,
      create_contacts: true,
      fill_fields: false,
    })
  })

  it('each switch is a keyboard-reachable button with its tooltip; the options under logging are nested', () => {
    const html = renderToStaticMarkup(
      createElement(SwitchRow, {
        title: 'Add new callers as contacts',
        tip: 'Turn adding new callers to HubSpot on or off',
        on: false,
        onChange: () => {},
        nested: true,
      }),
    )
    expect(html).toContain('<button type="button" role="switch" class="sw" aria-checked="false"')
    expect(html).toContain('title="Turn adding new callers to HubSpot on or off"')
    expect(html).toContain('swrow is-nested')
  })

  it('a skipped call says why', () => {
    expect(appPushErrorKey('calls_off')).toBe('settings.integrations.app.pushError.callsOff')
    expect(appPushErrorKey('no_contact')).toBe('settings.integrations.app.pushError.noContact')
  })

  it('Jobber says client where the others say contact', () => {
    expect(appPushErrorKey('no_contact', 'jobber')).toBe('settings.integrations.app.jobber.pushError.noContact')
    expect(appPushErrorKey('not_found', 'jobber')).toBe('settings.integrations.app.jobber.pushError.notFound')
    expect(appPushErrorKey('no_contact', 'hubspot')).toBe('settings.integrations.app.pushError.noContact')
    expect(appPushErrorKey('auth', 'jobber')).toBe('settings.integrations.app.pushError.auth')
  })
})
