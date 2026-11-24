// Slack adapter against recorded Slack answers (docs/crm-sync.md, "Slack"): the OAuth token answer with its incoming
// webhook, uninstall, and every answer of an incoming webhook a post can get.
import { describe, expect, it } from 'vitest'
import { createSlackConnector, createSlackOAuth, slackMessage } from './slack.ts'
import { type AppAccess, AppError, type FinishedCall } from './types.ts'

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }
type Seen = { url: string; method: string; headers: Headers; body: string }

function fakeFetch(route: (url: string, req: Seen) => Reply) {
  const seen: Seen[] = []
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const req = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ''),
    }
    seen.push(req)
    const reply = route(url, req)
    const body = reply.text ?? JSON.stringify(reply.body ?? {})
    return new Response(body, { status: reply.status ?? 200, headers: reply.headers })
  }) as typeof fetch
  return { doFetch, seen }
}

const client = { clientId: '123.456', clientSecret: 'secret' }
const HOOK = 'https://hooks.slack.com/services/T0001/B0001/abc'

// Slack's answer to oauth.v2.access for an install with `incoming-webhook` (docs.slack.dev, oauth.v2.access).
const installAnswer = {
  ok: true,
  access_token: 'xoxb-test-bot-token',
  token_type: 'bot',
  scope: 'incoming-webhook',
  bot_user_id: 'U0KRQLJ9H',
  app_id: 'A0123456789',
  team: { name: 'Brightwater Plumbing', id: 'T9TK3CUKW' },
  enterprise: null,
  incoming_webhook: {
    channel: '#calls',
    channel_id: 'C05002EAE',
    configuration_url: 'https://brightwater.slack.com/services/B0001',
    url: HOOK,
  },
}

const call = (over: Partial<FinishedCall> = {}): FinishedCall => ({
  callId: 'call-1',
  direction: 'in',
  callerNumber: '+15035550142',
  businessNumber: '+15035550100',
  startedAt: '2026-11-16T15:00:00.000Z',
  durationSec: 125,
  title: 'Leaking water heater',
  summary: 'Water heater leaks in the basement & the <valve> drips.',
  nextSteps: ['Call back with a time', ' '],
  callUrl: 'https://app.example/#call/call-1',
  caller: { name: 'Dana Whitfield', email: null, company: null, phone: '+15035550142' },
  linkedRecordId: null,
  urgent: false,
  labels: {
    nextSteps: 'Next steps',
    openCall: 'Open the call in Linedesk',
    caller: 'Caller',
    number: 'Number',
    urgent: 'Urgent',
    when: 'Nov 16, 2026, 3:00 PM',
  },
  ...over,
})

const access = (url: string | null = HOOK): AppAccess =>
  Object.assign(async () => 'xoxb-1', url === null ? {} : { webhookUrl: async () => url })

describe('Slack OAuth', () => {
  it('asks for incoming-webhook only, with the state and redirect', () => {
    const url = new URL(createSlackOAuth(client).authorizeUrl({ redirectUri: 'https://app.example/cb', state: 's1' }))
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '123.456',
      scope: 'incoming-webhook',
      redirect_uri: 'https://app.example/cb',
      state: 's1',
    })
  })

  it('takes the webhook, channel and workspace from the token answer', async () => {
    const { doFetch, seen } = fakeFetch(() => ({ body: installAnswer }))
    const tokens = await createSlackOAuth(client, { fetch: doFetch }).exchangeCode({
      code: 'c1',
      redirectUri: 'https://app.example/cb',
    })
    expect(tokens).toMatchObject({
      accessToken: installAnswer.access_token,
      refreshToken: null,
      expiresAt: null,
      scope: 'incoming-webhook',
      webhook: { url: HOOK, channel: '#calls' },
      account: { id: 'T9TK3CUKW', name: 'Brightwater Plumbing' },
    })
    expect(seen[0]!.url).toBe('https://slack.com/api/oauth.v2.access')
    expect(seen[0]!.headers.get('authorization')).toBe(`Basic ${btoa('123.456:secret')}`)
    expect(new URLSearchParams(seen[0]!.body).get('code')).toBe('c1')
  })

  it('refuses a webhook that is not on hooks.slack.com', async () => {
    const odd = {
      ...installAnswer,
      incoming_webhook: { ...installAnswer.incoming_webhook, url: 'https://evil.example/x' },
    }
    const { doFetch } = fakeFetch(() => ({ body: odd }))
    const tokens = await createSlackOAuth(client, { fetch: doFetch }).exchangeCode({ code: 'c', redirectUri: 'r' })
    expect(tokens.webhook).toBeNull()
  })

  it.each([
    ['invalid_client_id', 'client'],
    ['bad_client_secret', 'client'],
    ['invalid_code', 'auth'],
    ['internal_error', 'unavailable'],
  ])('a refused exchange (%s) is %s', async (code, kind) => {
    const { doFetch } = fakeFetch(() => ({ body: { ok: false, error: code } }))
    const err = await createSlackOAuth(client, { fetch: doFetch })
      .exchangeCode({ code: 'c', redirectUri: 'r' })
      .catch(e => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err.kind).toBe(kind)
  })

  it('uninstalls the app with the bot token on revoke', async () => {
    const { doFetch, seen } = fakeFetch(() => ({ body: { ok: true } }))
    expect(await createSlackOAuth(client, { fetch: doFetch }).revoke('xoxb-1')).toBe(true)
    expect(seen[0]!.url).toBe('https://slack.com/api/apps.uninstall')
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer xoxb-1')
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({
      client_id: '123.456',
      client_secret: 'secret',
    })
  })

  it('a failed uninstall is false, never a throw', async () => {
    const { doFetch } = fakeFetch(() => ({ body: { ok: false, error: 'invalid_auth' } }))
    expect(await createSlackOAuth(client, { fetch: doFetch }).revoke('xoxb-1')).toBe(false)
  })
})

describe('Slack message', () => {
  it('has the title, caller, number, summary, next steps, time and a button to the call', () => {
    const { text, blocks } = slackMessage(call())
    expect(text).toBe('Leaking water heater')
    expect(blocks.map(b => b.type)).toEqual(['header', 'section', 'section', 'section', 'context', 'actions'])
    expect(blocks[1]!.fields.map((f: { text: string }) => f.text)).toEqual([
      '*Caller*\nDana Whitfield',
      '*Number*\n+15035550142',
    ])
    expect(blocks[2]!.text.text).toBe('Water heater leaks in the basement &amp; the &lt;valve&gt; drips.')
    expect(blocks[3]!.text.text).toBe('*Next steps*\n• Call back with a time')
    expect(blocks[4]!.elements[0].text).toBe(
      `<!date^${Date.parse('2026-11-16T15:00:00.000Z') / 1000}^{date_short_pretty} {time}|Nov 16, 2026, 3:00 PM>`,
    )
    expect(blocks[5]!.elements[0]).toMatchObject({
      url: 'https://app.example/#call/call-1',
      text: { text: 'Open the call in Linedesk' },
    })
  })

  it('flags an urgent call in the notification and the message', () => {
    const { text, blocks } = slackMessage(call({ urgent: true }))
    expect(text).toBe('Urgent: Leaking water heater')
    expect(blocks[1]!.text.text).toBe(':rotating_light: *Urgent*')
  })

  it('escapes the notification text like the blocks', () => {
    expect(slackMessage(call({ title: 'Leak <!channel> & more' })).text).toBe('Leak &lt;!channel&gt; &amp; more')
  })

  it('leaves out what the call does not have', () => {
    const { blocks } = slackMessage(
      call({ caller: { name: null, email: null, company: null, phone: '' }, summary: '', nextSteps: [] }),
    )
    expect(blocks.map(b => b.type)).toEqual(['header', 'section', 'context', 'actions'])
  })
})

describe('Slack post', () => {
  it('posts the message to the incoming webhook and marks the call as posted', async () => {
    const { doFetch, seen } = fakeFetch(() => ({ text: 'ok' }))
    const logged: string[] = []
    const result = await createSlackConnector({ fetch: doFetch }).pushCall(access(), call(), {
      onLogged: async id => void logged.push(id),
    })
    expect(result).toEqual({ recordId: null, activityId: 'call-1' })
    expect(logged).toEqual(['call-1'])
    expect(seen[0]!.url).toBe(HOOK)
    expect(JSON.parse(seen[0]!.body).blocks[0].text.text).toBe('Leaking water heater')
  })

  it('without a stored webhook it asks to connect again', async () => {
    const { doFetch, seen } = fakeFetch(() => ({ text: 'ok' }))
    const err = await createSlackConnector({ fetch: doFetch })
      .pushCall(access(null), call())
      .catch(e => e)
    expect(err.kind).toBe('auth')
    expect(seen).toHaveLength(0)
  })

  // Slack's answers to a refused webhook post (docs.slack.dev, "Handling errors" of incoming webhooks).
  it.each([
    [404, 'channel_not_found', 'channel_not_found'],
    [410, 'channel_is_archived', 'channel_archived'],
    [403, 'invalid_token', 'auth'],
    [404, 'no_service', 'auth'],
    [404, 'no_team', 'auth'],
    [403, 'team_disabled', 'auth'],
    [403, 'action_prohibited', 'auth'],
    [410, '', 'auth'],
    [404, '', 'auth'],
    [400, 'invalid_payload', 'invalid'],
    [500, 'rollup_error', 'unavailable'],
    [503, '', 'unavailable'],
  ])('HTTP %i %s is %s', async (status, code, kind) => {
    const { doFetch } = fakeFetch(() => ({ status, text: code }))
    const err = await createSlackConnector({ fetch: doFetch })
      .pushCall(access(), call())
      .catch(e => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err.kind).toBe(kind)
  })

  it('429 is rate limited, with the wait Slack asked for', async () => {
    const { doFetch } = fakeFetch(() => ({ status: 429, text: 'rate_limited', headers: { 'retry-after': '30' } }))
    const err = await createSlackConnector({ fetch: doFetch })
      .pushCall(access(), call())
      .catch(e => e)
    expect(err.kind).toBe('rate_limited')
    expect(err.retryAfterSec).toBe(30)
  })

  it('a network failure is unavailable', async () => {
    const doFetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const err = await createSlackConnector({ fetch: doFetch })
      .pushCall(access(), call())
      .catch(e => e)
    expect(err.kind).toBe('unavailable')
  })
})
