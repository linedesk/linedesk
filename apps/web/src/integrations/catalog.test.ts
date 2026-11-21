import { appConnectErrors } from '@linedesk/actions'
import { appErrorCodes } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import en from '@linedesk/i18n/locales/en/settings.json'
import { describe, expect, it, test } from 'vitest'
import {
  appConnectErrorKey,
  recommendedFor,
  appConnectResult,
  appPushErrorKey,
  appSettingsWith,
  byCategory,
  CATALOG,
  CATEGORIES,
  claudeCodeCommand,
  claudeCodeKeyCommand,
  codexCommand,
  claudeInstallLink,
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
  mailConnectResult,
} from './catalog.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SwitchRow } from '../settings/fields.tsx'

const text = (key: MessageKey) => (en as Record<string, string>)[key.replace(/^settings\./, '')] ?? key
const ids = (list: readonly { id: string }[]) => list.map(i => i.id)

const PROVIDERS = ['google', 'microsoft', 'caldav', 'calcom', 'calendly'] as const
const NOTHING: Facts = {
  zaps: 0,
  apiKeys: 0,
  webhookUrls: [],
  calendars: {},
  calendarProviders: PROVIDERS,
  apps: {},
  mailboxes: { google: { count: 0, needsReconnect: 0 }, microsoft: { count: 0, needsReconnect: 0 } },
}
const LOADING: Facts = {
  zaps: undefined,
  apiKeys: undefined,
  webhookUrls: undefined,
  calendars: undefined,
  calendarProviders: null,
  apps: undefined,
  mailboxes: undefined,
}
const MEMBER: Facts = {
  zaps: null,
  apiKeys: null,
  webhookUrls: null,
  calendars: {},
  calendarProviders: PROVIDERS,
  apps: {},
  mailboxes: { google: { count: 0, needsReconnect: 0 }, microsoft: { count: 0, needsReconnect: 0 } },
}

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
    expect(groups.map(g => g.category)).toEqual([
      'automation',
      'calendars',
      'crm',
      'commerce',
      'chat',
      'email',
      'developers',
    ])
    expect(ids(groups[0]!.items)).toEqual(['zapier', 'make', 'n8n', 'webhooks'])
    expect(ids(groups[2]!.items)).toEqual(['hubspot', 'zoho', 'jobber', 'servicetitan'])
    expect(ids(groups[3]!.items)).toEqual(['shopify'])
    expect(ids(groups[5]!.items)).toEqual(['gmail', 'outlook-mail'])
    expect(ids(groups[6]!.items)).toEqual(['api-keys', 'rest-api', 'mcp'])
    expect(byCategory(CATALOG, 'chat').map(g => g.category)).toEqual(['chat'])
    expect(byCategory(searchIntegrations(CATALOG, 'outlook', text)).map(g => g.category)).toEqual([
      'calendars',
      'email',
    ])
  })

  it("counts each provider's support mailboxes on its own card and flags one that needs connecting again", () => {
    const none = { count: 0, needsReconnect: 0 }
    expect(statusOf('gmail', LOADING)).toEqual({ kind: 'loading' })
    expect(statusOf('gmail', NOTHING)).toEqual({ kind: 'notConnected' })
    const two = { ...NOTHING, mailboxes: { google: { count: 2, needsReconnect: 0 }, microsoft: none } }
    expect(statusOf('gmail', two)).toEqual({ kind: 'connected', count: 2 })
    expect(statusOf('outlook-mail', two)).toEqual({ kind: 'notConnected' })
    const broken = { ...NOTHING, mailboxes: { google: none, microsoft: { count: 1, needsReconnect: 1 } } }
    expect(statusOf('outlook-mail', broken)).toEqual({ kind: 'needsAttention' })
    expect(statusOf('gmail', broken)).toEqual({ kind: 'notConnected' })
  })

  it('sends the old Support email address to Gmail, with the callback result', () => {
    expect(placeOf('#integrations/support-email')).toEqual({ view: 'elsewhere', to: '#integrations/gmail' })
    expect(placeOf('#integrations/support-email?mail=connected')).toEqual({
      view: 'elsewhere',
      to: '#integrations/gmail?mail=connected',
    })
    expect(placeOf('#integrations/outlook-mail')).toEqual({ view: 'detail', id: 'outlook-mail' })
  })

  it('reads the mailbox callback result from the hash, known codes only', () => {
    expect(mailConnectResult('#integrations/gmail?mail=connected')).toEqual({ ok: true })
    expect(mailConnectResult('#integrations/gmail?mail=error&reason=scope')).toEqual({
      ok: false,
      reason: 'scope',
    })
    expect(mailConnectResult('#integrations/gmail?mail=error&reason=<b>hi</b>')).toEqual({
      ok: false,
      reason: 'failed',
    })
    expect(mailConnectResult('#integrations/gmail')).toBeNull()
  })

  it('has a calendar card for every provider, each opening Booking & calendar', () => {
    const calendars = byCategory(CATALOG, 'calendars')[0]!.items
    expect(ids(calendars)).toEqual(['google', 'microsoft', 'caldav', 'calcom', 'calendly'])
    for (const c of calendars) expect(c.opens).toBe('#assistant/booking')
  })
})

describe('searchIntegrations', () => {
  it('finds by name, line, category and keywords, any case, every word', () => {
    // API keys says what it is for (Zapier), so it is found too.
    expect(ids(searchIntegrations(CATALOG, 'ZAPIER', text))).toEqual(['zapier', 'api-keys'])
    expect(ids(searchIntegrations(CATALOG, 'outlook', text))).toEqual(['microsoft', 'outlook-mail'])
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
    expect(statusOf('zoho', NOTHING)).toEqual({ kind: 'notConnected' })
    expect(statusOf('zoho', { ...NOTHING, apps: { hubspot: 'connected' } })).toEqual({ kind: 'notConnected' })
    expect(statusOf('zoho', { ...NOTHING, apps: { zoho: 'connected' } })).toEqual({ kind: 'connected' })
    expect(statusOf('shopify', NOTHING)).toEqual({ kind: 'notConnected' })
    expect(statusOf('shopify', { ...NOTHING, apps: { shopify: 'connected' } })).toEqual({ kind: 'connected' })
    expect(statusOf('shopify', { ...NOTHING, apps: { shopify: 'needs_attention' } })).toEqual({
      kind: 'needsAttention',
    })
  })

  it('says when this server does not offer a calendar provider, and loading while that is not known', () => {
    const some: Facts = { ...NOTHING, calendarProviders: ['google'], calendars: { google: 1 } }
    expect(statusOf('google', some)).toEqual({ kind: 'connected', count: 1 })
    expect(statusOf('calendly', some)).toEqual({ kind: 'unavailable' })
    expect(statusOf('calendly', { ...NOTHING, calendarProviders: [] })).toEqual({ kind: 'unavailable' })
    expect(statusOf('calendly', { ...NOTHING, calendarProviders: null })).toEqual({ kind: 'loading' })
  })

  it('says coming soon for what is not built, whatever the facts', () => {
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
  it('sends a card without a detail view to the place where it is set up', () => {
    expect(placeOf('#integrations/make')).toEqual({ view: 'elsewhere', to: '#assistant/advanced/webhook' })
    expect(placeOf('#integrations/n8n')).toEqual({ view: 'elsewhere', to: '#assistant/advanced/webhook' })
    expect(placeOf('#integrations/webhooks')).toEqual({ view: 'elsewhere', to: '#assistant/advanced/webhook' })
    expect(placeOf('#integrations/google')).toEqual({ view: 'elsewhere', to: '#assistant/booking' })
    expect(placeOf('#integrations/calendly?x=1')).toEqual({ view: 'elsewhere', to: '#assistant/booking' })
    for (const i of CATALOG)
      if (i.opens) expect(['detail', 'elsewhere'], i.id).toContain(placeOf(`#integrations/${i.id}`).view)
  })
  it('says there is nothing at an unknown address, one not built yet or a path below a detail view', () => {
    expect(placeOf('#integrations/salesforce')).toEqual({ view: 'missing', section: 'salesforce' })
    expect(placeOf('#integrations/servicetitan')).toEqual({ view: 'missing', section: 'servicetitan' })
    expect(placeOf('#integrations/zapier/x')).toEqual({ view: 'missing', section: 'zapier/x' })
  })
  it('shows the catalog for the page itself and anything that is not this page', () => {
    expect(placeOf('#integrations/')).toEqual({ view: 'catalog' })
    expect(placeOf('#integrations?q=1')).toEqual({ view: 'catalog' })
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
    // VS Code Insiders: the same server, its own scheme. No link carries a key: the sign-in is OAuth.
    expect(vscodeInstallLink(origin, true)).toBe(vscode.replace(/^vscode:/, 'vscode-insiders:'))
    // Claude: Add custom connector with the install's name and its /mcp filled in; the owner's for Team and Enterprise.
    const claude = new URL(claudeInstallLink(origin, 'Acme Desk'))
    expect(claude.origin + claude.pathname).toBe('https://claude.ai/customize/connectors')
    expect(claude.searchParams.get('modal')).toBe('add-custom-connector')
    expect(claude.searchParams.get('connectorName')).toBe('Acme Desk')
    expect(claude.searchParams.get('connectorUrl')).toBe('https://desk.example/mcp')
    expect(new URL(claudeInstallLink(origin, 'Acme Desk', true)).pathname).toBe('/admin-settings/connectors')
    for (const link of [
      cursorInstallLink(origin),
      vscode,
      vscodeInstallLink(origin, true),
      claudeInstallLink(origin, 'Linedesk'),
      claudeInstallLink(origin, 'Linedesk', true),
    ])
      expect(decodeURIComponent(link)).not.toMatch(/lds_|lk_|Bearer|LINEDESK_KEY/)
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

  it('Shopify starts with the recommended setup: returns and address changes on, cancelling and adding customers off', () => {
    expect(appSettingsWith('shopify', {}, 'shop_cancel', true)).toEqual({
      log_calls: true,
      create_contacts: false,
      fill_fields: true,
      shop_returns: true,
      shop_address: true,
      shop_cancel: true,
      verify_name: true,
      verify_postcode: true,
      verify_email: false,
      verify_order_number: false,
      verify_caller_number: false,
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

  it('Shopify says customer where the others say contact', () => {
    expect(appPushErrorKey('no_contact', 'shopify')).toBe('settings.integrations.app.shopify.pushError.noContact')
    expect(appPushErrorKey('not_found', 'shopify')).toBe('settings.integrations.app.shopify.pushError.notFound')
    expect(appPushErrorKey('no_caller_id', 'shopify')).toBe('settings.integrations.app.shopify.pushError.noCallerId')
  })
})

describe('recommended for the kind of business (LIN-687)', () => {
  const ids = (kind: Parameters<typeof recommendedFor>[0]) => recommendedFor(kind).map(i => i.id)
  test('an online store: Shopify and the support mailboxes', () => {
    expect(ids('online_store')).toEqual(['shopify', 'gmail', 'outlook-mail'])
  })
  test('a plumber: calendars and Jobber, never one that is coming soon', () => {
    expect(ids('plumbing_hvac')).toEqual(expect.arrayContaining(['google', 'microsoft', 'jobber']))
    expect(ids('plumbing_hvac')).not.toContain('servicetitan')
  })
  test('no kind: nothing recommended', () => {
    expect(ids(null)).toEqual([])
  })
})
