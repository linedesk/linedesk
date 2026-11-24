import { describe, expect, it } from 'vitest'
import { AppError, type FinishedCall, GrantRevoked, PushSkipped, type TokenSource } from './types.ts'
import {
  createZohoConnector,
  createZohoOAuth,
  splitDc,
  zohoDataCenter,
  zohoDateTime,
  zohoDuration,
  zohoPhoneSearchTerms,
} from './zoho.ts'

type Seen = { method: string; url: URL; headers: Record<string, string>; body: any }
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }

/** A fake Zoho: routes by "METHOD /path" (the path without the query). Every request is recorded. */
function fakeZoho(routes: Record<string, (req: Seen) => Reply>) {
  const seen: Seen[] = []
  const doFetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const raw = typeof init.body === 'string' ? init.body : ''
    const headers = (init.headers ?? {}) as Record<string, string>
    const body = headers['content-type']?.includes('json')
      ? JSON.parse(raw)
      : Object.fromEntries(new URLSearchParams(raw))
    const req = { method, url, headers, body }
    seen.push(req)
    const route = routes[`${method} ${url.pathname}`]
    if (!route) return new Response(JSON.stringify({ code: 'INVALID_URL_PATTERN' }), { status: 404 })
    const reply = route(req)
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: reply.headers,
    })
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
  summary: 'Water heater leaks in the basement.',
  nextSteps: ['Call back with a time'],
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
    when: 'Nov 16, 2026, 7:00 AM',
  },
  ...over,
})

/** A token source for an EU account; counts forced refreshes. */
function euToken() {
  let refreshed = 0
  const token = (async (force?: boolean) => {
    if (force) refreshed++
    return `eu|access-${refreshed}`
  }) as TokenSource
  return { token, refreshes: () => refreshed }
}

const created = (id: string) => ({
  status: 201,
  body: { data: [{ code: 'SUCCESS', details: { id }, message: 'record added', status: 'success' }] },
})
const updated = (id: string) => ({
  body: { data: [{ code: 'SUCCESS', details: { id }, message: 'record updated', status: 'success' }] },
})

describe('data centres', () => {
  it('takes only Zoho accounts servers it knows, and US when the callback names none', () => {
    expect(zohoDataCenter('https://accounts.zoho.eu')).toBe('eu')
    expect(zohoDataCenter('https://accounts.zohocloud.ca')).toBe('ca')
    expect(zohoDataCenter(undefined)).toBe('us')
    expect(zohoDataCenter('https://accounts.zoho.eu.evil.example')).toBeNull()
    expect(zohoDataCenter('http://accounts.zoho.eu')).toBeNull()
    expect(zohoDataCenter('https://accounts.zoho.eu/steal')).toBeNull()
    // Credentials in the address (`https://name@host`), built so it is not read as an email address.
    expect(zohoDataCenter(['https://name', 'accounts.zoho.eu'].join('@'))).toBeNull()
    expect(zohoDataCenter('not a url')).toBeNull()
  })

  it('a stored token without a data centre cannot be used', () => {
    expect(splitDc('eu|abc')).toEqual({ dc: 'eu', token: 'abc' })
    expect(() => splitDc('abc')).toThrow(AppError)
    expect(() => splitDc('xx|abc')).toThrow(AppError)
  })
})

describe('Zoho OAuth', () => {
  const client = { clientId: '1000.CLIENT', clientSecret: 'secret' }

  it('sends the member to the US accounts server with every scope, offline and with consent', () => {
    const url = new URL(
      createZohoOAuth(client).authorizeUrl({ redirectUri: 'https://app.example/v1/apps/callback/zoho', state: 's1' }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.zoho.com/oauth/v2/auth')
    expect(url.searchParams.get('scope')).toBe(
      'ZohoCRM.modules.contacts.ALL,ZohoCRM.modules.calls.CREATE,ZohoSearch.securesearch.READ,ZohoCRM.org.READ',
    )
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  it("exchanges the code at the account's own data centre and marks the tokens with it", async () => {
    const fake = fakeZoho({
      'POST /oauth/v2/token': () => ({
        body: { access_token: 'a1', refresh_token: 'r1', api_domain: 'https://www.zohoapis.eu', expires_in: 3600 },
      }),
    })
    const tokens = await createZohoOAuth(client, { fetch: fake.doFetch }).exchangeCode({
      code: 'c1',
      redirectUri: 'https://app.example/v1/apps/callback/zoho',
      params: { 'accounts-server': 'https://accounts.zoho.eu' },
    })
    expect(fake.seen[0]!.url.origin).toBe('https://accounts.zoho.eu')
    expect(fake.seen[0]!.body).toMatchObject({ grant_type: 'authorization_code', code: 'c1', client_id: '1000.CLIENT' })
    expect(tokens).toMatchObject({ accessToken: 'eu|a1', refreshToken: 'eu|r1' })
    expect(Date.parse(tokens.expiresAt!)).toBeGreaterThan(Date.now() + 3500_000)
  })

  it('never sends the code or the secret to an accounts server not on the list', async () => {
    const fake = fakeZoho({})
    await expect(
      createZohoOAuth(client, { fetch: fake.doFetch }).exchangeCode({
        code: 'c1',
        redirectUri: 'https://app.example/v1/apps/callback/zoho',
        params: { 'accounts-server': 'https://evil.example' },
      }),
    ).rejects.toMatchObject({ kind: 'invalid' })
    expect(fake.seen).toHaveLength(0)
  })

  it('refreshes at the stored data centre and keeps the refresh token', async () => {
    const fake = fakeZoho({ 'POST /oauth/v2/token': () => ({ body: { access_token: 'a2', expires_in: 3600 } }) })
    const tokens = await createZohoOAuth(client, { fetch: fake.doFetch }).refresh('in|r1')
    expect(fake.seen[0]!.url.origin).toBe('https://accounts.zoho.in')
    expect(fake.seen[0]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1' })
    expect(tokens).toMatchObject({ accessToken: 'in|a2', refreshToken: null })
  })

  it('reads the errors Zoho sends with HTTP 200', async () => {
    const answer = (body: unknown) =>
      createZohoOAuth(client, { fetch: fakeZoho({ 'POST /oauth/v2/token': () => ({ body }) }).doFetch }).refresh(
        'us|r1',
      )
    const gone = await answer({ error: 'invalid_code' }).catch(e => e)
    expect(gone).toBeInstanceOf(GrantRevoked)
    await expect(answer({ error: 'invalid_client' })).rejects.toMatchObject({ kind: 'client' })
    await expect(answer({ error: 'invalid_client_secret' })).rejects.toMatchObject({ kind: 'client' })
    await expect(
      answer({
        error: 'Access Denied',
        error_description: 'You have made too many requests continuously. Please try again after some time.',
      }),
    ).rejects.toMatchObject({ kind: 'rate_limited' })
  })

  it('a failed code exchange is never a revoked grant', async () => {
    const fake = fakeZoho({ 'POST /oauth/v2/token': () => ({ body: { error: 'invalid_code' } }) })
    const err = await createZohoOAuth(client, { fetch: fake.doFetch })
      .exchangeCode({ code: 'c1', redirectUri: 'https://app.example/cb', params: {} })
      .catch(e => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).not.toBeInstanceOf(GrantRevoked)
    expect(err.kind).toBe('auth')
  })

  it('revokes the refresh token at its data centre with the client keys', async () => {
    const fake = fakeZoho({ 'POST /oauth/v2/revoke/token': () => ({ body: {} }) })
    expect(await createZohoOAuth(client, { fetch: fake.doFetch }).revoke('au|r1')).toBe(true)
    expect(fake.seen[0]!.url.origin).toBe('https://accounts.zoho.com.au')
    expect(fake.seen[0]!.headers.authorization).toBe(`Basic ${btoa('1000.CLIENT:secret')}`)
    expect(fake.seen[0]!.body).toEqual({ token: 'r1', token_type: 'refresh_token' })
    const refused = fakeZoho({
      'POST /oauth/v2/revoke/token': () => ({ status: 400, body: { error: 'invalid_request' } }),
    })
    expect(await createZohoOAuth(client, { fetch: refused.doFetch }).revoke('au|r1')).toBe(false)
  })

  it("names the account after the Zoho CRM org, asked at the account's API domain", async () => {
    const fake = fakeZoho({
      'GET /crm/v8/org': () => ({
        body: { org: [{ id: '5725767000000020005', company_name: 'Brightwater Plumbing' }] },
      }),
    })
    const account = await createZohoOAuth(client, { fetch: fake.doFetch }).account('eu|a1')
    expect(account).toEqual({ id: '5725767000000020005', name: 'Brightwater Plumbing' })
    expect(fake.seen[0]!.url.origin).toBe('https://www.zohoapis.eu')
    expect(fake.seen[0]!.headers.authorization).toBe('Zoho-oauthtoken a1')
  })
})

describe('Zoho CRM push', () => {
  it('finds the contact by number (written any way), fills only empty fields and logs the call on it', async () => {
    const fake = fakeZoho({
      'GET /crm/v8/Contacts/search': req =>
        req.url.searchParams.get('phone') === '5035550142'
          ? {
              body: {
                data: [
                  // Zoho's search is not exact: a contact whose number is another one does not count.
                  { id: 'z-other', Last_Name: 'Other', Phone: '(503) 555-0199' },
                  { id: 'z-1', First_Name: 'Dana', Last_Name: 'Whitfield', Email: null, Phone: '(503) 555-0142' },
                ],
              },
            }
          : { status: 204 },
      'PUT /crm/v8/Contacts/z-1': () => updated('z-1'),
      'POST /crm/v8/Calls': () => created('call-77'),
    })
    const { token } = euToken()
    const records: string[] = []
    const result = await createZohoConnector({ fetch: fake.doFetch }).pushCall(token, call(), {
      onRecord: async id => void records.push(id),
    })
    expect(result).toEqual({ recordId: 'z-1', activityId: 'call-77' })
    expect(records).toEqual(['z-1'])
    expect(fake.seen.every(r => r.url.origin === 'https://www.zohoapis.eu')).toBe(true)
    const fill = fake.seen.find(r => r.method === 'PUT')!
    expect(fill.body).toEqual({ data: [{ Email: 'dana@brightwater.example' }] })
    const logged = fake.seen.find(r => r.url.pathname === '/crm/v8/Calls')!.body.data[0]
    expect(logged).toMatchObject({
      Subject: 'Leaking water heater',
      Call_Type: 'Inbound',
      Call_Start_Time: '2026-11-16T15:00:00+00:00',
      Call_Duration: '02:05',
      Who_Id: { id: 'z-1' },
    })
    expect(logged.Description).toContain('Water heater leaks in the basement.')
    expect(logged.Description).toContain('https://app.example/#call/call-1')
    expect(logged.Outbound_Call_Status).toBeUndefined()
  })

  it('adds a caller with no contact; a caller with no name is named by the number, which counts as empty', async () => {
    const fake = fakeZoho({
      'GET /crm/v8/Contacts/search': () => ({ status: 204 }),
      'POST /crm/v8/Contacts': () => created('z-new'),
      'POST /crm/v8/Calls': () => created('call-1'),
    })
    const { token } = euToken()
    const result = await createZohoConnector({ fetch: fake.doFetch }).pushCall(
      token,
      call({ caller: { name: null, email: null, company: null, phone: '+15035550142' } }),
    )
    expect(result.recordId).toBe('z-new')
    const made = fake.seen.find(r => r.method === 'POST' && r.url.pathname === '/crm/v8/Contacts')!
    expect(made.body).toEqual({ data: [{ Last_Name: '(503) 555-0142', Phone: '+15035550142' }] })
    // Searched by digits only: Zoho's search takes no "+".
    const terms = fake.seen.filter(r => r.url.pathname.endsWith('/search')).map(r => r.url.searchParams.get('phone'))
    expect(terms).toEqual(['5035550142', '15035550142'])
  })

  it('a contact named by its number gets the name a later call learns', async () => {
    const fake = fakeZoho({
      'GET /crm/v8/Contacts/z-1': () => ({
        body: { data: [{ id: 'z-1', First_Name: null, Last_Name: '(503) 555-0142', Phone: '+15035550142' }] },
      }),
      'PUT /crm/v8/Contacts/z-1': () => updated('z-1'),
      'POST /crm/v8/Calls': () => created('call-2'),
    })
    const { token } = euToken()
    await createZohoConnector({ fetch: fake.doFetch }).pushCall(token, call({ linkedRecordId: 'z-1' }))
    expect(fake.seen.find(r => r.method === 'PUT')!.body.data[0]).toMatchObject({
      First_Name: 'Dana',
      Last_Name: 'Whitfield',
    })
  })

  it('a unique field taken by a contact the search missed: that contact gets the call', async () => {
    const fake = fakeZoho({
      'GET /crm/v8/Contacts/search': () => ({ status: 204 }),
      'POST /crm/v8/Contacts': () => ({
        status: 400,
        body: {
          data: [
            {
              code: 'DUPLICATE_DATA',
              details: { api_name: 'Email', duplicate_record: { id: 'z-dup' } },
              message: 'duplicate data',
              status: 'error',
            },
          ],
        },
      }),
      'GET /crm/v8/Contacts/z-dup': () => ({
        body: { data: [{ id: 'z-dup', First_Name: 'Dana', Last_Name: 'W', Email: 'dana@brightwater.example' }] },
      }),
      'POST /crm/v8/Calls': () => created('call-3'),
    })
    const { token } = euToken()
    const result = await createZohoConnector({ fetch: fake.doFetch }).pushCall(
      token,
      call({ caller: { name: null, email: 'dana@brightwater.example', company: null, phone: '+15035550142' } }),
    )
    expect(result.recordId).toBe('z-dup')
  })

  it('a linked contact that is gone is searched for again', async () => {
    const fake = fakeZoho({
      'GET /crm/v8/Contacts/z-gone': () => ({
        status: 400,
        body: {
          code: 'INVALID_DATA',
          details: { api_name: 'id' },
          message: 'the id given seems to be invalid',
          status: 'error',
        },
      }),
      'GET /crm/v8/Contacts/search': req =>
        req.url.searchParams.get('phone') === '5035550142'
          ? { body: { data: [{ id: 'z-2', First_Name: 'Dana', Last_Name: 'Whitfield', Mobile: '+1 503 555 0142' }] } }
          : { status: 204 },
      'PUT /crm/v8/Contacts/z-2': () => updated('z-2'),
      'POST /crm/v8/Calls': () => created('call-4'),
    })
    const { token } = euToken()
    const result = await createZohoConnector({ fetch: fake.doFetch }).pushCall(
      token,
      call({ linkedRecordId: 'z-gone' }),
    )
    expect(result.recordId).toBe('z-2')
  })

  it('a caller with no contact is skipped when adding contacts is off', async () => {
    const fake = fakeZoho({ 'GET /crm/v8/Contacts/search': () => ({ status: 204 }) })
    const { token } = euToken()
    await expect(
      createZohoConnector({ fetch: fake.doFetch }).pushCall(token, call(), undefined, {
        createContacts: false,
        fillFields: true,
      }),
    ).rejects.toBeInstanceOf(PushSkipped)
    expect(fake.seen.some(r => r.method === 'POST')).toBe(false)
  })

  it('refreshes the token once on 401, then tells refused access, limits and outages apart', async () => {
    let first = true
    const fake = fakeZoho({
      'GET /crm/v8/Contacts/search': () => {
        if (first) {
          first = false
          return { status: 401, body: { code: 'INVALID_TOKEN' } }
        }
        return { status: 204 }
      },
      'POST /crm/v8/Contacts': () => created('z-3'),
      'POST /crm/v8/Calls': () => created('call-5'),
    })
    const source = euToken()
    await createZohoConnector({ fetch: fake.doFetch }).pushCall(source.token, call())
    expect(source.refreshes()).toBe(1)
    expect(fake.seen[1]!.headers.authorization).toBe('Zoho-oauthtoken access-1')

    const failing = (status: number, code: string) =>
      createZohoConnector({
        fetch: fakeZoho({ 'GET /crm/v8/Contacts/search': () => ({ status, body: { code } }) }).doFetch,
      }).pushCall(euToken().token, call())
    await expect(failing(401, 'OAUTH_SCOPE_MISMATCH')).rejects.toMatchObject({ kind: 'auth' })
    await expect(failing(403, 'NO_PERMISSION')).rejects.toMatchObject({ kind: 'auth' })
    await expect(failing(429, 'TOO_MANY_REQUESTS')).rejects.toMatchObject({ kind: 'rate_limited' })
    await expect(failing(500, 'INTERNAL_ERROR')).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('a refused call shows Zoho’s reason as invalid', async () => {
    const fake = fakeZoho({
      'GET /crm/v8/Contacts/search': () => ({ status: 204 }),
      'POST /crm/v8/Contacts': () => created('z-4'),
      'POST /crm/v8/Calls': () => ({
        status: 400,
        body: {
          data: [
            {
              code: 'MANDATORY_NOT_FOUND',
              details: { api_name: 'Call_Purpose' },
              message: 'required field not found',
              status: 'error',
            },
          ],
        },
      }),
    })
    const err = await createZohoConnector({ fetch: fake.doFetch })
      .pushCall(euToken().token, call())
      .catch(e => e)
    expect(err).toMatchObject({ kind: 'invalid' })
    expect(err.message).toMatch(/required field not found/)
  })

  it('an outgoing call is logged as completed', async () => {
    const fake = fakeZoho({
      'GET /crm/v8/Contacts/search': () => ({ status: 204 }),
      'POST /crm/v8/Contacts': () => created('z-5'),
      'POST /crm/v8/Calls': () => created('call-6'),
    })
    await createZohoConnector({ fetch: fake.doFetch }).pushCall(
      euToken().token,
      call({ direction: 'out', urgent: true }),
    )
    const logged = fake.seen.find(r => r.url.pathname === '/crm/v8/Calls')!.body.data[0]
    expect(logged).toMatchObject({ Call_Type: 'Outbound', Outbound_Call_Status: 'Completed' })
    expect(logged.Subject).toBe('Leaking water heater (Urgent)')
  })
})

describe('formats', () => {
  it('writes durations as mm:ss, never zero, and times with an offset and no milliseconds', () => {
    expect(zohoDuration(125)).toBe('02:05')
    expect(zohoDuration(0)).toBe('00:01')
    expect(zohoDuration(3725)).toBe('62:05')
    expect(zohoDateTime('2026-11-16T15:00:00.123Z')).toBe('2026-11-16T15:00:00+00:00')
  })

  it('searches numbers by digits only', () => {
    expect(zohoPhoneSearchTerms('+15035550142')).toEqual(['5035550142', '15035550142'])
    expect(zohoPhoneSearchTerms('+4915112345678')).toEqual(['15112345678', '4915112345678'])
  })
})
