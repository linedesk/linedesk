import { describe, expect, it } from 'vitest'
import {
  callNoteText,
  createJobberConnector,
  createJobberOAuth,
  JOBBER_GRAPHQL_VERSION,
  phoneSearchTerms,
  throttleWaitSec,
} from './jobber.ts'
import { AppError, type FinishedCall, PushSkipped, type TokenSource } from './types.ts'

type Seen = { url: string; headers: Record<string, string>; body: any; op: string }
type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }

/**
 * A fake Jobber: the token endpoint answers from `token`, GraphQL from the route named after the operation
 * (`LinedeskFindClient`, ...). Every request is recorded.
 */
function fakeJobber(routes: Record<string, (req: Seen) => Reply>) {
  const seen: Seen[] = []
  const doFetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const raw = typeof init.body === 'string' ? init.body : ''
    const headers = (init.headers ?? {}) as Record<string, string>
    const isGraphql = new URL(url).pathname === '/api/graphql'
    const body = isGraphql ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))
    const op = isGraphql ? (/^(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? '?') : 'token'
    const req = { url, headers, body, op }
    seen.push(req)
    const route = routes[op]
    if (!route) return new Response(JSON.stringify({ errors: [{ message: `no route ${op}` }] }), { status: 200 })
    const reply = route(req)
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
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
  summary: 'Water heater leaks in the basement.\nWants a visit this week.',
  nextSteps: ['Call back with a time', 'Bring a new valve'],
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
type Row = {
  firstName?: string | null
  lastName?: string | null
  companyName?: string | null
  phones?: string[]
  emails?: string[]
}
const client = (id: string, row: Row = {}) => ({
  id,
  firstName: row.firstName ?? null,
  lastName: row.lastName ?? null,
  companyName: row.companyName ?? null,
  phones: (row.phones ?? []).map(number => ({ number })),
  emails: (row.emails ?? []).map(address => ({ address })),
})
const found = (...nodes: unknown[]) => ({ body: { data: { clients: { nodes } } } })
const noteOk = () => ({ body: { data: { clientCreateNote: { clientNote: { id: 'note-1' }, userErrors: [] } } } })

describe('Jobber OAuth', () => {
  const app = { clientId: 'cid', clientSecret: 'secret' }

  it('sends to the consent page with no scope (the app sets them)', () => {
    const url = new URL(
      createJobberOAuth(app).authorizeUrl({ redirectUri: 'https://x.example/v1/apps/callback/jobber', state: 'st' }),
    )
    expect(url.origin + url.pathname).toBe('https://api.getjobber.com/api/oauth/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'https://x.example/v1/apps/callback/jobber',
      state: 'st',
    })
  })

  it('exchanges the code, reads the account, and takes the expiry from the JWT', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const jwt = `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.s`
    const { doFetch, seen } = fakeJobber({
      token: () => ({ body: { access_token: jwt, refresh_token: 'rt' } }),
      LinedeskAccount: () => ({ body: { data: { account: { id: 'acc-1', name: 'Brightwater Plumbing' } } } }),
    })
    const oauth = createJobberOAuth(app, { fetch: doFetch })
    const tokens = await oauth.exchangeCode({ code: 'c', redirectUri: 'https://x.example/cb' })
    expect(tokens).toMatchObject({
      accessToken: jwt,
      refreshToken: 'rt',
      scope: null,
      account: { id: 'acc-1', name: 'Brightwater Plumbing' },
    })
    expect(Date.parse(tokens.expiresAt!) - Date.now()).toBeGreaterThan(3500_000)
    expect(seen[0]!.url).toBe('https://api.getjobber.com/api/oauth/token')
    expect(seen[0]!.body).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://x.example/cb',
      client_id: 'cid',
      client_secret: 'secret',
    })
    expect(seen[1]!.headers['x-jobber-graphql-version']).toBe(JOBBER_GRAPHQL_VERSION)
    expect(seen[1]!.headers.authorization).toBe(`Bearer ${jwt}`)
  })

  it('a refused refresh is auth; a refused app is client; 429 and 5xx can be retried', async () => {
    for (const [reply, kind] of [
      [{ status: 401, text: 'The provided refresh token is not valid.' }, 'auth'],
      [{ status: 400, body: { error: 'invalid_grant' } }, 'auth'],
      [{ status: 401, text: 'The provided client id and secret do not match an existing application' }, 'client'],
      [{ status: 429, text: 'slow down', headers: { 'retry-after': '7' } }, 'rate_limited'],
      [{ status: 503, text: 'down' }, 'unavailable'],
    ] as const) {
      const { doFetch } = fakeJobber({ token: () => reply })
      const err = await createJobberOAuth(app, { fetch: doFetch })
        .refresh('rt')
        .catch(e => e)
      expect(err).toBeInstanceOf(AppError)
      expect(err.kind).toBe(kind)
      if (kind === 'rate_limited') expect(err.retryAfterSec).toBe(7)
    }
  })

  it('a refresh returns the rotated refresh token', async () => {
    const { doFetch } = fakeJobber({ token: () => ({ body: { access_token: 'at2', refresh_token: 'rt2' } }) })
    expect(await createJobberOAuth(app, { fetch: doFetch }).refresh('rt1')).toMatchObject({
      accessToken: 'at2',
      refreshToken: 'rt2',
    })
  })

  it('disconnects with appDisconnect', async () => {
    const { doFetch, seen } = fakeJobber({
      token: () => ({ body: { access_token: 'at', refresh_token: 'rt2' } }),
      LinedeskDisconnect: () => ({ body: { data: { appDisconnect: { app: { name: 'Linedesk' }, userErrors: [] } } } }),
    })
    expect(await createJobberOAuth(app, { fetch: doFetch }).revoke!('rt')).toBe(true)
    expect(seen.map(r => r.op)).toEqual(['token', 'LinedeskDisconnect'])
    expect(seen[1]!.headers.authorization).toBe('Bearer at')
  })

  it('a disconnect Jobber refuses is reported, not thrown', async () => {
    const refused = fakeJobber({ token: () => ({ status: 401, text: 'The provided refresh token is not valid.' }) })
    expect(await createJobberOAuth(app, { fetch: refused.doFetch }).revoke!('rt')).toBe(false)
    const userError = fakeJobber({
      token: () => ({ body: { access_token: 'at' } }),
      LinedeskDisconnect: () => ({ body: { data: { appDisconnect: { app: null, userErrors: [{ message: 'no' }] } } } }),
    })
    expect(await createJobberOAuth(app, { fetch: userError.doFetch }).revoke!('rt')).toBe(false)
  })

  it('talks only to api.getjobber.com', async () => {
    const { doFetch, seen } = fakeJobber({
      token: () => ({ body: { access_token: 'at' } }),
      LinedeskDisconnect: () => ({ body: { data: { appDisconnect: { userErrors: [] } } } }),
    })
    await createJobberOAuth(app, { fetch: doFetch }).revoke!('rt')
    expect(seen.every(r => new URL(r.url).origin === 'https://api.getjobber.com')).toBe(true)
  })
})

describe('Jobber push', () => {
  it('searches the national digits, the national form and E.164', () => {
    expect(phoneSearchTerms('+15035550142')).toEqual(['5035550142', '(503) 555-0142', '+15035550142'])
  })

  it('creates the client when none matches and adds the call as a note', async () => {
    const { doFetch, seen } = fakeJobber({
      LinedeskFindClient: () => found(),
      LinedeskCreateClient: () => ({
        body: { data: { clientCreate: { client: client('c-1', { firstName: 'Dana' }), userErrors: [] } } },
      }),
      LinedeskNote: noteOk,
    })
    const steps: string[] = []
    const progress = {
      onRecord: async (id: string) => void steps.push(`record ${id}`),
      onLogged: async (id: string) => void steps.push(`logged ${id}`),
    }
    const result = await createJobberConnector({ fetch: doFetch }).pushCall(staticToken, call(), progress)
    expect(result).toEqual({ recordId: 'c-1', activityId: 'note-1' })
    expect(steps).toEqual(['record c-1', 'logged note-1'])
    const created = seen.find(r => r.op === 'LinedeskCreateClient')!
    expect(created.body.variables.input).toEqual({
      firstName: 'Dana',
      lastName: 'Whitfield',
      phones: [{ number: '+15035550142', primary: true, description: 'MAIN' }],
      emails: [{ address: 'dana@brightwater.example', primary: true, description: 'MAIN' }],
    })
    const note = seen.find(r => r.op === 'LinedeskNote')!
    expect(note.headers.authorization).toBe('Bearer tok')
    expect(note.body.variables.id).toBe('c-1')
    expect(note.body.variables.input.message).toBe(callNoteText(call()))
    // Never a recording or transcript.
    expect(JSON.stringify(note.body)).not.toMatch(/recording|transcript/i)
  })

  it('writes the note as plain text with the summary, the next steps and the link', () => {
    expect(callNoteText(call({ urgent: true }))).toBe(
      [
        'Leaking water heater (Urgent)',
        'Water heater leaks in the basement.\nWants a visit this week.',
        'Next steps:\n- Call back with a time\n- Bring a new valve',
        'Open the call in Linedesk: https://app.example/#call/call-1',
      ].join('\n\n'),
    )
    expect(callNoteText(call({ summary: '', nextSteps: [] }))).toBe(
      'Leaking water heater\n\nOpen the call in Linedesk: https://app.example/#call/call-1',
    )
  })

  it('names a caller with no name by the number, and fills the name on a later call', async () => {
    const fresh = fakeJobber({
      LinedeskFindClient: () => found(),
      LinedeskCreateClient: () => ({
        body: { data: { clientCreate: { client: client('c-2', { firstName: '(503) 555-0142' }), userErrors: [] } } },
      }),
      LinedeskNote: noteOk,
    })
    const anonymous = call({ caller: { name: null, email: null, company: null, phone: '+15035550142' } })
    await createJobberConnector({ fetch: fresh.doFetch }).pushCall(staticToken, anonymous)
    expect(fresh.seen.find(r => r.op === 'LinedeskCreateClient')!.body.variables.input).toEqual({
      firstName: '(503) 555-0142',
      phones: [{ number: '+15035550142', primary: true, description: 'MAIN' }],
    })

    const later = fakeJobber({
      LinedeskFindClient: () =>
        found(client('c-2', { firstName: '(503) 555-0142', phones: ['(503) 555-0142'], emails: ['d@x.example'] })),
      LinedeskFillClient: () => ({ body: { data: { clientEdit: { client: { id: 'c-2' }, userErrors: [] } } } }),
      LinedeskNote: noteOk,
    })
    await createJobberConnector({ fetch: later.doFetch }).pushCall(staticToken, call())
    expect(later.seen.find(r => r.op === 'LinedeskFillClient')!.body.variables).toEqual({
      id: 'c-2',
      input: { firstName: 'Dana', lastName: 'Whitfield' },
    })
  })

  it('fills only empty fields of a client found by phone', async () => {
    const { doFetch, seen } = fakeJobber({
      LinedeskFindClient: () => found(client('77', { firstName: 'Dee', phones: ['503.555.0142'] })),
      LinedeskFillClient: () => ({ body: { data: { clientEdit: { client: { id: '77' }, userErrors: [] } } } }),
      LinedeskNote: noteOk,
    })
    const result = await createJobberConnector({ fetch: doFetch }).pushCall(staticToken, call())
    expect(result.recordId).toBe('77')
    // The name stays "Dee"; the phone stays as typed; only the email was empty.
    expect(seen.find(r => r.op === 'LinedeskFillClient')!.body.variables.input).toEqual({
      emailsToAdd: [{ address: 'dana@brightwater.example', primary: true, description: 'MAIN' }],
    })
  })

  it('a fuzzy search hit with another number is not the caller', async () => {
    const terms: string[] = []
    const { doFetch, seen } = fakeJobber({
      LinedeskFindClient: req => {
        terms.push(req.body.variables.term)
        return found(client('99', { firstName: 'Other', phones: ['(503) 555-0199'] }))
      },
      LinedeskCreateClient: () => ({
        body: { data: { clientCreate: { client: client('c-3'), userErrors: [] } } },
      }),
      LinedeskNote: noteOk,
    })
    const result = await createJobberConnector({ fetch: doFetch }).pushCall(staticToken, call())
    expect(result.recordId).toBe('c-3')
    // Every phone term, then the email.
    expect(terms).toEqual(['5035550142', '(503) 555-0142', '+15035550142', 'dana@brightwater.example'])
    expect(seen.some(r => r.op === 'LinedeskCreateClient')).toBe(true)
  })

  it('falls back to the email, matched exactly', async () => {
    const { doFetch } = fakeJobber({
      LinedeskFindClient: req =>
        req.body.variables.term.includes('@')
          ? found(
              client('e-1', { firstName: 'Dana', phones: ['+1 503 555 0000'], emails: ['DANA@brightwater.example'] }),
            )
          : found(),
      LinedeskNote: noteOk,
    })
    expect((await createJobberConnector({ fetch: doFetch }).pushCall(staticToken, call())).recordId).toBe('e-1')
  })

  it('with adding clients off, a caller with no client is skipped and nothing is made in Jobber', async () => {
    const { doFetch, seen } = fakeJobber({ LinedeskFindClient: () => found() })
    const err = await createJobberConnector({ fetch: doFetch })
      .pushCall(staticToken, call(), {}, { createContacts: false, fillFields: true })
      .catch(e => e)
    expect(err).toBeInstanceOf(PushSkipped)
    expect(err.reason).toBe('no_contact')
    expect(seen.every(r => r.op === 'LinedeskFindClient')).toBe(true)
  })

  it('with filling fields off, an existing client is never changed', async () => {
    const { doFetch, seen } = fakeJobber({
      LinedeskFindClient: () => found(client('77', { phones: ['+15035550142'] })),
      LinedeskNote: noteOk,
    })
    await createJobberConnector({ fetch: doFetch }).pushCall(
      staticToken,
      call(),
      {},
      {
        createContacts: true,
        fillFields: false,
      },
    )
    expect(seen.some(r => r.op === 'LinedeskFillClient')).toBe(false)
    expect(seen.some(r => r.op === 'LinedeskNote')).toBe(true)
  })

  it('uses the stored link before searching, and searches when the client is gone', async () => {
    const linked = fakeJobber({
      LinedeskClient: () => ({
        body: { data: { client: client('55', { firstName: 'Dana', lastName: 'W', emails: ['d@x.example'] }) } },
      }),
      LinedeskFillClient: () => ({ body: { data: { clientEdit: { client: { id: '55' }, userErrors: [] } } } }),
      LinedeskNote: noteOk,
    })
    const result = await createJobberConnector({ fetch: linked.doFetch }).pushCall(
      staticToken,
      call({ linkedRecordId: '55' }),
    )
    expect(result.recordId).toBe('55')
    expect(linked.seen.some(r => r.op === 'LinedeskFindClient')).toBe(false)

    for (const gone of [
      { body: { data: { client: null } } },
      { body: { data: null, errors: [{ message: 'Client not found', extensions: { code: 'NOT_FOUND' } }] } },
    ]) {
      const { doFetch } = fakeJobber({
        LinedeskClient: () => gone,
        LinedeskFindClient: () => found(client('66', { firstName: 'D', phones: ['+15035550142'], emails: ['x@x'] })),
        LinedeskNote: noteOk,
      })
      expect(
        (await createJobberConnector({ fetch: doFetch }).pushCall(staticToken, call({ linkedRecordId: '55' })))
          .recordId,
      ).toBe('66')
    }
  })

  it('refreshes the token once on 401', async () => {
    const tokens: boolean[] = []
    const token: TokenSource = async force => (tokens.push(!!force), force ? 'new' : 'old')
    const { doFetch, seen } = fakeJobber({
      LinedeskFindClient: req =>
        req.headers.authorization === 'Bearer old'
          ? { status: 401, text: 'Unauthorized' }
          : found(client('1', { firstName: 'A', companyName: 'c', phones: ['+15035550142'], emails: ['a@x'] })),
      LinedeskNote: noteOk,
    })
    await createJobberConnector({ fetch: doFetch }).pushCall(token, call())
    expect(seen.filter(r => r.op === 'LinedeskFindClient')).toHaveLength(2)
    expect(tokens.slice(0, 2)).toEqual([false, true])
  })

  it('maps errors: 401 twice is auth, throttling rate limited, userErrors invalid', async () => {
    const throttled = {
      body: {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: {
          cost: { requestedQueryCost: 2500, throttleStatus: { currentlyAvailable: 500, restoreRate: 500 } },
        },
      },
    }
    for (const [reply, kind] of [
      [{ status: 401, text: 'Unauthorized' }, 'auth'],
      [{ status: 403, text: 'Forbidden' }, 'auth'],
      [{ status: 429, text: 'Too many' }, 'rate_limited'],
      [throttled, 'rate_limited'],
      [{ status: 502, text: 'bad gateway' }, 'unavailable'],
      [{ body: { errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }] } }, 'auth'],
      [{ body: { errors: [{ message: 'Field foo does not exist' }] } }, 'invalid'],
    ] as const) {
      const { doFetch } = fakeJobber({ LinedeskFindClient: () => reply })
      const err = await createJobberConnector({ fetch: doFetch })
        .pushCall(staticToken, call())
        .catch(e => e)
      expect(err).toBeInstanceOf(AppError)
      expect(err.kind).toBe(kind)
      if (reply === throttled) expect(err.retryAfterSec).toBe(4)
    }

    const { doFetch } = fakeJobber({
      LinedeskFindClient: () => found(),
      LinedeskCreateClient: () => ({
        body: { data: { clientCreate: { client: null, userErrors: [{ message: 'Email is invalid', path: [] }] } } },
      }),
    })
    const err = await createJobberConnector({ fetch: doFetch })
      .pushCall(staticToken, call())
      .catch(e => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err.kind).toBe('invalid')
    expect(err.message).toContain('Email is invalid')
  })

  it('computes the throttle wait from the cost bucket', () => {
    expect(
      throttleWaitSec({
        cost: { requestedQueryCost: 1000, throttleStatus: { currentlyAvailable: 0, restoreRate: 500 } },
      }),
    ).toBe(2)
    expect(throttleWaitSec(undefined)).toBeUndefined()
  })
})
