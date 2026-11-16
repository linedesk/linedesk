import { describe, expect, it } from 'vitest'
import { fillOnly, splitName } from './crm.ts'
import { createHubSpotConnector, createHubSpotOAuth, phoneFilterGroups } from './hubspot.ts'
import { AppError, type FinishedCall, PushSkipped, type TokenSource } from './types.ts'

type Seen = { method: string; url: string; headers: Record<string, string>; body: any }
type Reply = { status?: number; body?: unknown }

/** A fake HubSpot: each route answers from a function; every request is recorded. */
function fakeHubSpot(routes: Record<string, (req: Seen) => Reply>) {
  const seen: Seen[] = []
  const doFetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const raw = typeof init.body === 'string' ? init.body : undefined
    const contentType = (init.headers as Record<string, string> | undefined)?.['content-type']
    const body =
      raw === undefined
        ? undefined
        : contentType === 'application/json'
          ? JSON.parse(raw)
          : Object.fromEntries(new URLSearchParams(raw))
    const req = { method, url, headers: (init.headers ?? {}) as Record<string, string>, body }
    seen.push(req)
    const path = new URL(url).pathname
    const route = routes[`${method} ${path}`]
    if (!route) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 })
    const reply = route(req)
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 })
  }) as typeof fetch
  return { doFetch, seen }
}

const call = (over: Partial<FinishedCall> = {}): FinishedCall => ({
  callId: 'call-1',
  direction: 'in',
  callerNumber: '+15035550142',
  businessNumber: '+15035550100',
  startedAt: '2026-11-16T15:00:00.000Z',
  durationSec: 125,
  title: 'Leaking water heater',
  summary: 'Water heater leaks in the basement.\nWants a visit this week.',
  nextSteps: ['Call back with a time', 'Bring a <new> valve'],
  callUrl: 'https://app.example/#call/call-1',
  caller: { name: 'Dana Whitfield', email: 'dana@brightwater.example', company: null, phone: '+15035550142' },
  linkedRecordId: null,
  urgent: false,
  labels: {
    nextSteps: 'Next steps',
    openCall: 'Open the call in Linedesk',
    caller: 'Caller',
    number: 'Number',
    urgent: 'Urgent',
    when: 'Nov 16, 2026, 9:30 AM',
  },
  ...over,
})

const staticToken: TokenSource = async () => 'tok'
const contact = (id: string, props: Record<string, string | null>) => ({ id, properties: props })

describe('HubSpot OAuth', () => {
  const client = { clientId: 'cid', clientSecret: 'secret' }

  it('asks only for the contact scopes', () => {
    const url = new URL(
      createHubSpotOAuth(client).authorizeUrl({
        redirectUri: 'https://x.example/v1/apps/callback/hubspot',
        state: 'st',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://app.hubspot.com/oauth/authorize')
    expect(url.searchParams.get('scope')).toBe('oauth crm.objects.contacts.read crm.objects.contacts.write')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('state')).toBe('st')
  })

  it('exchanges the code and reads the portal', async () => {
    const { doFetch, seen } = fakeHubSpot({
      'POST /oauth/v3/token': () => ({
        body: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 1800,
          scopes: ['oauth', 'crm.objects.contacts.read'],
          hub_id: 42,
        },
      }),
      'POST /oauth/v3/token/introspect': () => ({ body: { hub_id: 42, hub_domain: 'brightwater.example' } }),
    })
    const oauth = createHubSpotOAuth(client, { fetch: doFetch })
    const tokens = await oauth.exchangeCode({ code: 'c', redirectUri: 'https://x.example/cb' })
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', scope: 'oauth crm.objects.contacts.read' })
    expect(Date.parse(tokens.expiresAt!) - Date.now()).toBeGreaterThan(1700_000)
    expect(seen[0]!.body).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://x.example/cb',
      client_id: 'cid',
      client_secret: 'secret',
    })
    expect(await oauth.account('at')).toEqual({ id: '42', name: 'brightwater.example' })
  })

  it('a refused refresh is an auth error', async () => {
    const { doFetch } = fakeHubSpot({
      'POST /oauth/v3/token': () => ({
        status: 400,
        body: { error: 'invalid_grant', status: 'BAD_REFRESH_TOKEN', message: 'missing or unknown refresh token' },
      }),
    })
    const err = await createHubSpotOAuth(client, { fetch: doFetch })
      .refresh('rt')
      .catch(e => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err.kind).toBe('auth')
  })

  it('revokes the refresh token', async () => {
    const { doFetch, seen } = fakeHubSpot({ 'DELETE /oauth/v1/refresh-tokens/rt': () => ({ status: 204 }) })
    expect(await createHubSpotOAuth(client, { fetch: doFetch }).revoke('rt')).toBe(true)
    expect(seen).toHaveLength(1)
  })
})

describe('HubSpot push', () => {
  it('searches the phone in E.164 and without country code', () => {
    const values = phoneFilterGroups('+15035550142').map(g => g.filters[0]!.value)
    expect(values).toEqual(['+15035550142', '+15035550142', '5035550142', '5035550142'])
  })

  it('creates the contact when none matches and logs the call on it', async () => {
    const { doFetch, seen } = fakeHubSpot({
      'POST /crm/v3/objects/contacts/search': () => ({ body: { total: 0, results: [] } }),
      'POST /crm/v3/objects/contacts': () => ({ status: 201, body: contact('501', {}) }),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '9001' } }),
    })
    const steps: string[] = []
    const progress = {
      onRecord: async (id: string) => void steps.push(`record ${id}`),
      onLogged: async (id: string) => void steps.push(`logged ${id}`),
    }
    const result = await createHubSpotConnector({ fetch: doFetch }).pushCall(staticToken, call(), progress)
    expect(result).toEqual({ recordId: '501', activityId: '9001' })
    expect(steps).toEqual(['record 501', 'logged 9001'])
    const created = seen.find(r => r.method === 'POST' && r.url.endsWith('/crm/v3/objects/contacts'))!
    expect(created.body.properties).toEqual({
      firstname: 'Dana',
      lastname: 'Whitfield',
      email: 'dana@brightwater.example',
      phone: '+15035550142',
    })
    const logged = seen.find(r => r.url.endsWith('/crm/v3/objects/calls'))!
    expect(logged.headers.authorization).toBe('Bearer tok')
    expect(logged.body.properties).toMatchObject({
      hs_timestamp: '2026-11-16T15:00:00.000Z',
      hs_call_title: 'Leaking water heater',
      hs_call_duration: '125000',
      hs_call_direction: 'INBOUND',
      hs_call_status: 'COMPLETED',
      hs_call_from_number: '+15035550142',
      hs_call_to_number: '+15035550100',
    })
    expect(logged.body.properties.hs_call_body).toContain(
      'Water heater leaks in the basement.<br>Wants a visit this week.',
    )
    expect(logged.body.properties.hs_call_body).toContain('<li>Bring a &lt;new&gt; valve</li>')
    expect(logged.body.properties.hs_call_body).toContain('<a href="https://app.example/#call/call-1">')
    expect(logged.body.associations).toEqual([
      { to: { id: '501' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }] },
    ])
    // Never a recording or transcript.
    expect(JSON.stringify(logged.body)).not.toMatch(/recording|transcript/i)
  })

  it('tells of the record as soon as it exists, before logging the call, and of the logged call', async () => {
    const steps: string[] = []
    const { doFetch } = fakeHubSpot({
      'POST /crm/v3/objects/contacts/search': () => ({ body: { total: 0, results: [] } }),
      'POST /crm/v3/objects/contacts': () => ({ status: 201, body: contact('501', {}) }),
      'POST /crm/v3/objects/calls': () => {
        steps.push('log')
        return { status: 500, body: { message: 'down' } }
      },
    })
    const progress = {
      onRecord: async (id: string) => void steps.push(`record ${id}`),
      onLogged: async (id: string) => void steps.push(`logged ${id}`),
    }
    await expect(
      createHubSpotConnector({ fetch: doFetch }).pushCall(staticToken, call(), progress),
    ).rejects.toMatchObject({ kind: 'unavailable' })
    // The record was saved before the call failed: the retry reuses it instead of creating another.
    expect(steps).toEqual(['record 501', 'log'])
  })

  it('fills only empty fields of a contact found by phone', async () => {
    const { doFetch, seen } = fakeHubSpot({
      'POST /crm/v3/objects/contacts/search': () => ({
        body: { results: [contact('77', { firstname: 'Dee', lastname: null, email: null, phone: '(503) 555-0142' })] },
      }),
      'PATCH /crm/v3/objects/contacts/77': () => ({ body: contact('77', {}) }),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '9002' } }),
    })
    const result = await createHubSpotConnector({ fetch: doFetch }).pushCall(staticToken, call())
    expect(result.recordId).toBe('77')
    const patch = seen.find(r => r.method === 'PATCH')!
    // The name stays "Dee"; the phone stays as typed; only the email was empty.
    expect(patch.body.properties).toEqual({ email: 'dana@brightwater.example' })
  })

  it('writes nothing when every field is set', async () => {
    const { doFetch, seen } = fakeHubSpot({
      'POST /crm/v3/objects/contacts/search': () => ({
        body: { results: [contact('77', { firstname: 'Dee', email: 'd@x.example', phone: '1', company: 'Acme' })] },
      }),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '9' } }),
    })
    await createHubSpotConnector({ fetch: doFetch }).pushCall(staticToken, call())
    expect(seen.some(r => r.method === 'PATCH')).toBe(false)
  })

  it('with adding contacts off, a caller with no contact is skipped and nothing is made in HubSpot', async () => {
    const { doFetch, seen } = fakeHubSpot({
      'POST /crm/v3/objects/contacts/search': () => ({ body: { total: 0, results: [] } }),
      'POST /crm/v3/objects/contacts': () => ({ status: 201, body: contact('501', {}) }),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '9001' } }),
    })
    const err = await createHubSpotConnector({ fetch: doFetch })
      .pushCall(staticToken, call(), {}, { createContacts: false, fillFields: true })
      .catch(e => e)
    expect(err).toBeInstanceOf(PushSkipped)
    expect(err.reason).toBe('no_contact')
    expect(seen.every(r => r.url.endsWith('/search'))).toBe(true)
  })

  it('with adding contacts off, a caller who has a contact still gets the call', async () => {
    const { doFetch, seen } = fakeHubSpot({
      'POST /crm/v3/objects/contacts/search': () => ({
        body: { results: [contact('77', { firstname: 'Dee', email: null, phone: '+15035550142' })] },
      }),
      'PATCH /crm/v3/objects/contacts/77': () => ({ body: contact('77', {}) }),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '9003' } }),
    })
    const result = await createHubSpotConnector({ fetch: doFetch }).pushCall(
      staticToken,
      call(),
      {},
      { createContacts: false, fillFields: true },
    )
    expect(result).toEqual({ recordId: '77', activityId: '9003' })
    expect(seen.some(r => r.method === 'POST' && r.url.endsWith('/crm/v3/objects/contacts'))).toBe(false)
  })

  it('with filling fields off, an existing contact is never changed; a new one still gets the caller details', async () => {
    const found = fakeHubSpot({
      'POST /crm/v3/objects/contacts/search': () => ({
        body: { results: [contact('77', { firstname: null, lastname: null, email: null, phone: '+15035550142' })] },
      }),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '9004' } }),
    })
    const off = { createContacts: true, fillFields: false }
    await createHubSpotConnector({ fetch: found.doFetch }).pushCall(staticToken, call(), {}, off)
    expect(found.seen.some(r => r.method === 'PATCH')).toBe(false)
    expect(found.seen.some(r => r.url.endsWith('/crm/v3/objects/calls'))).toBe(true)

    const fresh = fakeHubSpot({
      'POST /crm/v3/objects/contacts/search': () => ({ body: { total: 0, results: [] } }),
      'POST /crm/v3/objects/contacts': () => ({ status: 201, body: contact('502', {}) }),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '9005' } }),
    })
    await createHubSpotConnector({ fetch: fresh.doFetch }).pushCall(staticToken, call(), {}, off)
    const created = fresh.seen.find(r => r.method === 'POST' && r.url.endsWith('/crm/v3/objects/contacts'))!
    expect(created.body.properties).toMatchObject({ firstname: 'Dana', email: 'dana@brightwater.example' })
  })

  it('uses the stored link before searching, and searches when the record is gone', async () => {
    const linked = fakeHubSpot({
      'GET /crm/v3/objects/contacts/55': () => ({
        body: contact('55', { firstname: 'Dana', email: 'dana@brightwater.example', phone: '+15035550142' }),
      }),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '1' } }),
    })
    expect(
      (await createHubSpotConnector({ fetch: linked.doFetch }).pushCall(staticToken, call({ linkedRecordId: '55' })))
        .recordId,
    ).toBe('55')
    expect(linked.seen.some(r => r.url.includes('/search'))).toBe(false)

    const gone = fakeHubSpot({
      'GET /crm/v3/objects/contacts/55': () => ({ status: 404, body: { message: 'not found' } }),
      'POST /crm/v3/objects/contacts/search': () => ({
        body: { results: [contact('66', { firstname: 'Dana', lastname: 'W', email: 'x@x.example', phone: '1' })] },
      }),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '2' } }),
    })
    expect(
      (await createHubSpotConnector({ fetch: gone.doFetch }).pushCall(staticToken, call({ linkedRecordId: '55' })))
        .recordId,
    ).toBe('66')
  })

  it('falls back to email, and to the existing contact when create conflicts', async () => {
    let searches = 0
    const { doFetch, seen } = fakeHubSpot({
      'POST /crm/v3/objects/contacts/search': () => ({ body: { results: [] }, ...(searches++, {}) }),
      'POST /crm/v3/objects/contacts': () => ({
        status: 409,
        body: { message: 'Contact already exists. Existing ID: 808' },
      }),
      'GET /crm/v3/objects/contacts/808': () => ({
        body: contact('808', { firstname: 'Dana', email: 'dana@brightwater.example', phone: null }),
      }),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '3' } }),
    })
    const result = await createHubSpotConnector({ fetch: doFetch }).pushCall(staticToken, call())
    expect(searches).toBe(2) // phone, then email
    const emailSearch = seen.filter(r => r.url.includes('/search'))[1]!
    expect(emailSearch.body.filterGroups).toEqual([
      { filters: [{ propertyName: 'email', operator: 'EQ', value: 'dana@brightwater.example' }] },
    ])
    expect(result.recordId).toBe('808')
  })

  it('refreshes the token once on 401', async () => {
    let calls = 0
    const tokens: boolean[] = []
    const token: TokenSource = async force => (tokens.push(!!force), force ? 'new' : 'old')
    const { doFetch } = fakeHubSpot({
      'POST /crm/v3/objects/contacts/search': req => (
        calls++,
        req.headers.authorization === 'Bearer old'
          ? { status: 401, body: {} }
          : { body: { results: [contact('1', { firstname: 'A', email: 'a@x.example', phone: '1', company: 'c' })] } }
      ),
      'POST /crm/v3/objects/calls': () => ({ status: 201, body: { id: '4' } }),
    })
    await createHubSpotConnector({ fetch: doFetch }).pushCall(token, call())
    expect(calls).toBe(2)
    expect(tokens.slice(0, 2)).toEqual([false, true])
  })

  it('classifies errors: 401 twice is auth, 429 rate limited, 5xx unavailable', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [403, 'auth'],
      [429, 'rate_limited'],
      [502, 'unavailable'],
      [400, 'invalid'],
    ] as const) {
      const { doFetch } = fakeHubSpot({
        'POST /crm/v3/objects/contacts/search': () => ({ status, body: { message: 'nope' } }),
      })
      const err = await createHubSpotConnector({ fetch: doFetch })
        .pushCall(staticToken, call())
        .catch(e => e)
      expect(err).toBeInstanceOf(AppError)
      expect(err.kind).toBe(kind)
    }
  })
})

describe('fill rules', () => {
  it('splits names', () => {
    expect(splitName('Mike Brennan')).toEqual({ firstName: 'Mike', lastName: 'Brennan' })
    expect(splitName('Mary Ann de Vries')).toEqual({ firstName: 'Mary Ann de', lastName: 'Vries' })
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: null })
    expect(splitName(null)).toEqual({ firstName: null, lastName: null })
  })

  it('never overwrites', () => {
    const existing = { firstName: null, lastName: 'Smith', email: 'a@x.example', phone: null, company: '' }
    expect(
      fillOnly(existing, { firstName: 'Dana', lastName: 'W', email: 'b@x.example', phone: '+1', company: 'Acme' }),
    ).toEqual({ phone: '+1', company: 'Acme' })
  })
})
