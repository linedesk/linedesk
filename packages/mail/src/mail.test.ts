// Mail adapters against mocked HTTP: no request leaves the process. The same contract runs against an in-memory Gmail
// and an in-memory Microsoft Graph.
import { describe, expect, test } from 'vitest'
import { createGmail, createGmailOAuth, gmailBodyText } from './google.ts'
import { createMailProvider } from './index.ts'
import { createGraphMail, createMicrosoftMailOAuth } from './microsoft.ts'
import { addressOf, htmlToText, MailError, type MailProvider, retryWaitMs } from './provider.ts'

const TOKEN = 'secret-access-token'
const FRESH = 'fresh-access-token'
const OWN = 'help@brightwater.example'

type Stored = {
  id: string
  thread: string
  from: string
  to: string
  subject: string
  at: string
  text: string
  html?: boolean
  folder?: string
}
type Seen = { url: URL; auth: string | null; headers: Headers }

const MAIL: Stored[] = [
  {
    id: 'm3',
    thread: 't1',
    from: `Brightwater Plumbing <${OWN}>`,
    to: 'jane@example.com',
    subject: 'Re: Leaking water heater',
    at: '2030-01-08T10:00:00.000Z',
    text: 'We can come Tuesday. The call-out fee is $89.',
  },
  {
    id: 'm2',
    thread: 't1',
    from: 'Jane Doe <jane@example.com>',
    to: OWN,
    subject: 'Leaking water heater',
    at: '2030-01-07T09:00:00.000Z',
    text: '<p>Hi,<br>my water heater leaks &amp; drips.</p>',
    html: true,
  },
  {
    id: 'm1',
    thread: 't0',
    from: 'Old Customer <old@example.com>',
    to: OWN,
    subject: 'Old',
    at: '2029-06-01T09:00:00.000Z',
    text: 'Old message',
  },
  {
    id: 'junk',
    thread: 't9',
    from: 'spam@example.com',
    to: OWN,
    subject: 'Win',
    at: '2030-01-08T11:00:00.000Z',
    text: 'spam',
    folder: 'junk-id',
  },
]

const json = (body: unknown, status = 200) => Response.json(body, { status })
const b64url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

function fakeServer(route: (seen: Seen) => Response, valid = [TOKEN, FRESH]) {
  const seen: Seen[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    const req: Seen = { url: new URL(String(input)), auth: headers.get('authorization'), headers }
    seen.push(req)
    if (!valid.some(t => req.auth === `Bearer ${t}`)) return json({ error: { message: 'Invalid Credentials' } }, 401)
    return route(req)
  }
  return { fetch, seen }
}

function fakeGmail(valid?: string[]) {
  return fakeServer(({ url }) => {
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    if (path === '/messages') {
      const after = /after:(\d+)/.exec(url.searchParams.get('q') ?? '')?.[1]
      const list = MAIL.filter(m => !m.folder && (!after || Date.parse(m.at) / 1000 > Number(after)))
      const max = Number(url.searchParams.get('maxResults'))
      const start = Number(url.searchParams.get('pageToken') ?? 0)
      const page = list.slice(start, start + max)
      return json({
        messages: page.map(m => ({ id: m.id, threadId: m.thread })),
        ...(start + max < list.length && { nextPageToken: String(start + max) }),
      })
    }
    const m = MAIL.find(x => `/messages/${x.id}` === path)
    if (!m) return json({ error: { message: 'Requested entity was not found.' } }, 404)
    const body = { mimeType: m.html ? 'text/html' : 'text/plain', body: { data: b64url(m.text) } }
    return json({
      id: m.id,
      threadId: m.thread,
      internalDate: String(Date.parse(m.at)),
      labelIds: m.from.includes(OWN) ? ['SENT'] : ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: m.from },
          { name: 'To', value: m.to },
          { name: 'Subject', value: m.subject },
        ],
        parts: [
          { mimeType: 'multipart/alternative', parts: [body] },
          { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64url('attachment') } },
        ],
      },
    })
  }, valid)
}

function fakeGraph(valid?: string[]) {
  return fakeServer(({ url, headers }) => {
    const path = url.pathname.replace('/v1.0/me', '')
    if (path === '/mailFolders/junkemail') return json({ id: 'junk-id' })
    if (path === '/mailFolders/deleteditems') return json({ id: 'deleted-id' })
    if (path === '/mailFolders/drafts') return json({ error: { code: 'ErrorItemNotFound' } }, 404)
    if (path === '/messages') {
      const since = /receivedDateTime ge (\S+)/.exec(url.searchParams.get('$filter') ?? '')?.[1]
      const list = MAIL.filter(m => !since || Date.parse(m.at) >= Date.parse(since))
      const top = Number(url.searchParams.get('$top'))
      const skip = Number(url.searchParams.get('$skip') ?? 0)
      const page = list.slice(skip, skip + top)
      const next = new URL(url)
      next.searchParams.set('$skip', String(skip + top))
      return json({
        value: page.map(m => ({ id: m.id, conversationId: m.thread, parentFolderId: m.folder ?? 'inbox-id' })),
        ...(skip + top < list.length && { '@odata.nextLink': next.toString() }),
      })
    }
    const m = MAIL.find(x => `/messages/${x.id}` === path)
    if (!m) return json({ error: { code: 'ErrorItemNotFound' } }, 404)
    const asText = headers.get('prefer') === 'outlook.body-content-type="text"'
    return json({
      id: m.id,
      conversationId: m.thread,
      from: { emailAddress: { address: addressOf(m.from) } },
      toRecipients: [{ emailAddress: { address: m.to } }],
      subject: m.subject,
      sentDateTime: m.at,
      body: { contentType: asText ? 'text' : 'html', content: asText && m.html ? htmlToText(m.text) : m.text },
    })
  }, valid)
}

const adapters: [string, (valid?: string[]) => { provider: MailProvider; seen: Seen[] }][] = [
  [
    'Gmail',
    valid => {
      const { fetch, seen } = fakeGmail(valid)
      return { provider: createGmail({ accessToken: async refresh => (refresh ? FRESH : TOKEN), fetch }), seen }
    },
  ],
  [
    'Microsoft Graph',
    valid => {
      const { fetch, seen } = fakeGraph(valid)
      return {
        provider: createGraphMail({
          accessToken: async refresh => (refresh ? FRESH : TOKEN),
          accountEmail: OWN,
          fetch,
        }),
        seen,
      }
    },
  ],
]

describe.each(adapters)('%s mail adapter', (_name, make) => {
  test('lists messages after a date, newest first, without junk, and pages', async () => {
    const { provider } = make()
    const first = await provider.listMessages({ after: '2030-01-01T00:00:00.000Z', max: 1 })
    expect(first.messages).toEqual([{ id: 'm3', threadId: 't1' }])
    expect(first.nextPageToken).not.toBeNull()
    const rest = await provider.listMessages({
      after: '2030-01-01T00:00:00.000Z',
      max: 1,
      pageToken: first.nextPageToken!,
    })
    expect(rest.messages.map(m => m.id)).toEqual(['m2'])
  })

  test('reads a message as plain text and knows the mailbox sent it', async () => {
    const { provider } = make()
    const answer = await provider.getMessage('m3')
    expect(answer).toMatchObject({ id: 'm3', threadId: 't1', from: OWN, to: ['jane@example.com'], fromMailbox: true })
    expect(answer?.text).toBe('We can come Tuesday. The call-out fee is $89.')
    const question = await provider.getMessage('m2')
    expect(question).toMatchObject({ from: 'jane@example.com', fromMailbox: false, subject: 'Leaking water heater' })
    expect(question?.text).toBe('Hi,\nmy water heater leaks & drips.')
  })

  test('a missing message is null', async () => {
    expect(await make().provider.getMessage('gone')).toBeNull()
  })

  test('a refused token is refreshed once, then the request is repeated', async () => {
    const { provider, seen } = make([FRESH])
    expect((await provider.getMessage('m3'))?.id).toBe('m3')
    expect(seen.filter(s => s.url.pathname.endsWith('/messages/m3')).map(s => s.auth)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${FRESH}`,
    ])
  })

  test('a token refused after the refresh is an auth error', async () => {
    const { provider } = make(['other'])
    await expect(provider.getMessage('m3')).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('Gmail', () => {
  test('a per-user rate limit is retried after a wait, then the read goes on', async () => {
    let calls = 0
    const waits: number[] = []
    const fetch: typeof globalThis.fetch = async () => {
      calls++
      if (calls <= 2)
        return json(
          {
            error: {
              message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'",
              errors: [{ reason: 'rateLimitExceeded' }],
            },
          },
          429,
        )
      return json({ messages: [{ id: 'm1', threadId: 't1' }] })
    }
    const gmail = createGmail({ accessToken: async () => TOKEN, fetch, sleep: async ms => void waits.push(ms) })
    const page = await gmail.listMessages()
    expect(page.messages).toEqual([{ id: 'm1', threadId: 't1' }])
    expect(calls).toBe(3)
    expect(waits).toHaveLength(2)
  })

  test('a rate limit that does not end fails as rate_limited after the retries', async () => {
    let calls = 0
    const fetch: typeof globalThis.fetch = async () => {
      calls++
      return json({ error: { message: 'slow down', errors: [{ reason: 'userRateLimitExceeded' }] } }, 403)
    }
    const err = await createGmail({ accessToken: async () => TOKEN, fetch, sleep: async () => {} })
      .listMessages()
      .catch(e => e)
    expect(err).toMatchObject({ kind: 'rate_limited' })
    expect(calls).toBe(5)
  })

  test("the wait honors the provider's Retry-After and grows without one", () => {
    expect(retryWaitMs(0, '3')).toBe(3000)
    expect(retryWaitMs(0, '120')).toBe(30_000)
    expect(retryWaitMs(0, null)).toBeGreaterThanOrEqual(2000)
    expect(retryWaitMs(2, null)).toBeGreaterThanOrEqual(8000)
  })

  test("the API being off in the app project is the app's failure, not the account's", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      json({ error: { message: 'Gmail API has not been used', errors: [{ reason: 'accessNotConfigured' }] } }, 403)
    const err = await createGmail({ accessToken: async () => TOKEN, fetch })
      .listMessages()
      .catch(e => e)
    expect(err).toBeInstanceOf(MailError)
    expect(err).toMatchObject({ kind: 'invalid', code: 'api_disabled' })
  })

  test('the body prefers text/plain and skips attachments', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', filename: 'a.txt', body: { data: b64url('attachment') } },
        { mimeType: 'text/html', body: { data: b64url('<b>html</b>') } },
        { mimeType: 'text/plain', body: { data: b64url('plain ü') } },
      ],
    }
    expect(gmailBodyText(payload)).toBe('plain ü')
  })

  test('OAuth asks for read-only mail with a refresh token and checks the granted scope', () => {
    const oauth = createGmailOAuth({ clientId: 'id', clientSecret: 'secret' })
    const url = new URL(
      oauth.authorizeUrl({
        redirectUri: 'https://app.example/v1/mail/callback/google',
        state: 's',
        codeChallenge: 'c',
      }),
    )
    expect(url.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/gmail.readonly')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(oauth.grantsMailRead('openid https://www.googleapis.com/auth/userinfo.email')).toBe(false)
    expect(oauth.grantsMailRead('openid https://www.googleapis.com/auth/gmail.readonly')).toBe(true)
  })
})

describe('Microsoft Graph', () => {
  test('a page token from elsewhere is refused', async () => {
    const { fetch } = fakeGraph()
    const provider = createGraphMail({ accessToken: async () => TOKEN, accountEmail: OWN, fetch })
    await expect(provider.listMessages({ pageToken: 'https://evil.example/me/messages?x' })).rejects.toMatchObject({
      kind: 'invalid',
    })
  })

  test('OAuth asks for Mail.Read only and checks the granted scope', () => {
    const oauth = createMicrosoftMailOAuth({ clientId: 'id', clientSecret: 'secret' })
    const url = new URL(
      oauth.authorizeUrl({
        redirectUri: 'https://app.example/v1/mail/callback/microsoft',
        state: 's',
        codeChallenge: 'c',
      }),
    )
    expect(url.searchParams.get('scope')).toBe('openid email offline_access User.Read Mail.Read')
    expect(oauth.grantsMailRead('openid User.Read')).toBe(false)
    expect(oauth.grantsMailRead('openid https://graph.microsoft.com/Mail.Read User.Read')).toBe(true)
  })

  test('createMailProvider picks the adapter', () => {
    expect(createMailProvider('microsoft', { accessToken: async () => TOKEN, accountEmail: OWN }).name).toBe(
      'microsoft',
    )
    expect(createMailProvider('google', { accessToken: async () => TOKEN, accountEmail: OWN }).name).toBe('google')
  })
})

test('addressOf takes the bare address', () => {
  expect(addressOf('Mike Brennan <Mike@Brightwater.example>')).toBe('mike@brightwater.example')
  expect(addressOf('jane@example.com')).toBe('jane@example.com')
})
