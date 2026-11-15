// The sign-in email's button (sign-in-link.ts): opening the link signs nobody in, Continue does, only in the browser that
// asked for the code, once, while the code is good; the code and the link end each other and share the code's limits.
import { auth_events, invitation, member, user, verification } from '@linedesk/db'
import { and, desc, eq, like } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { CLIENT_IP_HEADER } from '../src/client-ip.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { countWrongCode } from '../src/sign-in-limits.ts'
import { linkOrigin } from '../src/sign-in-link.ts'
import { anonymous, appRequest, createWorkspace, FROM, randomIp, request, type Workspace } from './helpers.ts'

const ORIGIN = 'http://localhost:5173'
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const accountOf = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Sign-in Link Workspace', false)
})
afterEach(() => {
  vi.restoreAllMocks()
})

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map(c => c.split(';')[0]!)
    .join('; ')

/** Asks for a code like the sign-in page; returns the browser cookie it got and the email's code and link token. */
async function askForCode(email: string, browser?: string) {
  const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
  const res = await appRequest('/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      [FROM]: randomIp(),
      ...(browser ? { cookie: browser } : {}),
    },
    body: JSON.stringify({ email, type: 'sign-in' }),
  })
  expect(res.status).toBe(200)
  const cookie = browser ?? cookiesOf(res)
  await vi.waitFor(() => expect(send.mock.calls.some(([m]) => m.to === email)).toBe(true))
  const mail = send.mock.calls
    .map(([m]) => m)
    .filter(m => m.to === email)
    .at(-1)!
  const token = /#sign-in=([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1]
  expect(token).toBeTruthy()
  send.mockRestore()
  return { cookie, code: mail.subject.slice(0, 6), token: token!, mail }
}

async function linkRequest(
  step: 'check' | 'use',
  token: string,
  cookie: string | null,
  extra: Record<string, string> = {},
) {
  const res = await appRequest(`/v1/sign-in-link/${step}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      [FROM]: randomIp(),
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    body: JSON.stringify({ token }),
  })
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted on in the tests
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookies: cookiesOf(res) }
}
const check = (token: string, cookie: string | null) => linkRequest('check', token, cookie)
const use = (token: string, cookie: string | null, extra?: Record<string, string>) =>
  linkRequest('use', token, cookie, extra)
const signInWithCode = (email: string, otp: string) =>
  request(anonymous, 'POST', '/api/auth/sign-in/email-otp', { email, otp }, { origin: ORIGIN, [FROM]: randomIp() })
const whoIs = async (cookies: string) =>
  (await request({ headers: { cookie: cookies, origin: ORIGIN } }, 'GET', '/api/auth/get-session')).body?.user?.email ??
  null
const ownerEmail = async () => (await db.select().from(user).where(eq(user.id, ws.owner.userId)))[0]!.email

async function invited(email: string) {
  const id = `inv_${crypto.randomUUID().slice(0, 8)}`
  await db.insert(invitation).values({
    id,
    organizationId: ws.id,
    email,
    role: 'member',
    status: 'pending',
    inviterId: ws.owner.userId,
    expiresAt: new Date(Date.now() + 3_600_000),
  })
  return id
}

describe('the email', () => {
  test('asking for a code sets the browser cookie, for an unknown address too (no account is told)', async () => {
    const known = await appRequest('/api/auth/email-otp/send-verification-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
      body: JSON.stringify({ email: address('nobody'), type: 'sign-in' }),
    })
    expect(known.status).toBe(200)
    expect(cookiesOf(known)).toMatch(/^sign_in_browser=[A-Za-z0-9_-]{43}$/)
    expect(known.headers.getSetCookie()[0]).toMatch(/HttpOnly/i)
  })

  test('the button points to this install with the token in the fragment; only hashes and the sealed code are stored', async () => {
    const email = await ownerEmail()
    const { token, code, mail } = await askForCode(email)
    expect(mail.html).toContain(`href="${ORIGIN}/#sign-in=${token}"`)
    expect(mail.text).toContain(`Or enter this code on the sign-in page at localhost:5173:`)
    const rows = await db.select().from(verification).where(like(verification.identifier, 'sign-in-link-%'))
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(JSON.stringify(rows)).not.toContain(code)
  })

  test('the link names the origin the code was asked from only when it is one of ours', () => {
    const trusted = ['https://app.example.com', 'http://localhost:5173']
    expect(linkOrigin('http://localhost:5173', trusted, 'https://app.example.com')).toBe('http://localhost:5173')
    expect(linkOrigin('https://evil.example', trusted, 'https://app.example.com')).toBe('https://app.example.com')
    expect(linkOrigin(null, trusted, 'https://app.example.com')).toBe('https://app.example.com')
  })
})

describe('opening and continuing', () => {
  test('opening the page signs nobody in; Continue in the same browser does, verifies the address and is recorded like a code', async () => {
    const email = await ownerEmail()
    const { cookie, token } = await askForCode(email)
    // There is nothing to GET: a scanner that follows the link only loads the app's page (the token stays in the fragment).
    expect((await appRequest('/v1/sign-in-link/check', { headers: { cookie, origin: ORIGIN } })).status).not.toBe(200)
    const looked = await check(token, cookie)
    expect(looked).toMatchObject({ status: 200, body: { state: 'ready', email } })
    expect(looked.cookies).toBe('')
    expect(await check(token, cookie)).toMatchObject({ body: { state: 'ready' } })
    const done = await use(token, cookie)
    expect(done).toMatchObject({ status: 200, body: { ok: true } })
    expect(done.body.token).toBeUndefined()
    expect(await whoIs(done.cookies)).toBe(email)
    expect(await accountOf(email)).toMatchObject({ emailVerified: true })
    const [event] = await db
      .select()
      .from(auth_events)
      .where(eq(auth_events.user_id, ws.owner.userId))
      .orderBy(desc(auth_events.created_at))
      .limit(1)
    expect(event).toMatchObject({ event: 'sign_in', method: 'email_code' })
  })

  test('another browser is told to enter the code and learns nothing; the link still works where it was asked for', async () => {
    const email = await ownerEmail()
    const { cookie, token } = await askForCode(email)
    const other = 'sign_in_browser=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    for (const browser of [null, other]) {
      expect(await check(token, browser)).toEqual({ status: 200, body: { ok: true, state: 'other' }, cookies: '' })
      expect(await use(token, browser)).toMatchObject({ status: 400, body: { ok: false, state: 'other' }, cookies: '' })
    }
    // An unknown token gets the same answer as another browser.
    expect((await check('B'.repeat(43), cookie)).body).toEqual({ ok: true, state: 'other' })
    expect((await use(token, cookie)).status).toBe(200)
  })

  test('the link works once', async () => {
    const email = await ownerEmail()
    const { cookie, token } = await askForCode(email)
    const [first, second] = await Promise.all([use(token, cookie), use(token, cookie)])
    expect([first.status, second.status].sort()).toEqual([200, 400])
    expect((await check(token, cookie)).body.state).toBe('other')
  })

  test('Continue gives the browser a new value, so a planted one works at most once', async () => {
    const email = await ownerEmail()
    const { cookie, token } = await askForCode(email)
    const done = await use(token, cookie)
    expect(done.status).toBe(200)
    const fresh = /(?:^|; )(sign_in_browser=[A-Za-z0-9_-]{43})(?:;|$)/.exec(done.cookies)?.[1]
    expect(fresh).toBeTruthy()
    expect(fresh).not.toBe(cookie)
    // The next code asked for in that browser is bound to the new value, not the old one.
    const next = await askForCode(email, fresh)
    expect((await check(next.token, cookie)).body.state).toBe('other')
    expect((await check(next.token, fresh!)).body.state).toBe('ready')
  })

  test('a body over 1 KB is refused before it is read', async () => {
    for (const step of ['check', 'use']) {
      const res = await appRequest(`/v1/sign-in-link/${step}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
        body: JSON.stringify({ token: 'A'.repeat(43), pad: 'x'.repeat(2048) }),
      })
      expect(res.status).toBe(413)
    }
  })

  test('only from the app: another origin is refused', async () => {
    const email = await ownerEmail()
    const { cookie, token } = await askForCode(email)
    expect((await use(token, cookie, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await use(token, null, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await use(token, cookie)).status).toBe(200)
  })

  test('the link expires with the code', async () => {
    const email = await ownerEmail()
    const { cookie, token } = await askForCode(email)
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verification.identifier, `sign-in-otp-${email}`))
    expect((await check(token, cookie)).body.state).toBe('spent')
    const again = await askForCode(email, cookie)
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(like(verification.identifier, 'sign-in-link-%'))
    expect((await check(again.token, cookie)).body.state).toBe('other')
    expect((await use(again.token, cookie)).status).toBe(400)
  })
})

describe('the code and the link end each other', () => {
  test('a typed code spends the link', async () => {
    const email = await ownerEmail()
    const { cookie, token, code } = await askForCode(email)
    expect((await signInWithCode(email, code)).status).toBe(200)
    expect((await check(token, cookie)).body.state).toBe('spent')
    expect((await use(token, cookie)).status).toBe(400)
  })

  test('the link spends the code', async () => {
    const email = await ownerEmail()
    const { cookie, token, code } = await askForCode(email)
    expect((await use(token, cookie)).status).toBe(200)
    expect((await signInWithCode(email, code)).status).toBe(400)
  })

  test('a newer code replaces the older link', async () => {
    const email = await ownerEmail()
    const first = await askForCode(email)
    const second = await askForCode(email, first.cookie)
    expect((await check(first.token, first.cookie)).body.state).toBe('spent')
    expect((await use(second.token, first.cookie)).status).toBe(200)
  })
})

describe('the limits of the code', () => {
  test('three wrong tries spend the link too', async () => {
    const email = await ownerEmail()
    const { cookie, token, code } = await askForCode(email)
    const wrong = code === '123456' ? '654321' : '123456'
    for (let i = 0; i < 3; i++) expect((await signInWithCode(email, wrong)).status).toBe(400)
    expect((await check(token, cookie)).body.state).toBe('spent')
    expect((await use(token, cookie)).status).toBe(400)
  })

  test('an address locked by wrong codes from this IP is refused through the link as well', async () => {
    const email = await ownerEmail()
    const { cookie, token } = await askForCode(email)
    const ip = randomIp()
    for (let i = 0; i < 10; i++)
      countWrongCode({ body: { email }, headers: new Headers({ [CLIENT_IP_HEADER]: ip }) } as never)
    expect(await use(token, cookie, { [FROM]: ip })).toMatchObject({ status: 429, cookies: '' })
    expect(await whoIs('')).toBeNull()
  })
})

describe('invitations', () => {
  test('an invited address signs in with the link: the account is made verified and joins the workspace', async () => {
    const email = address('invited-link')
    const id = await invited(email)
    const { cookie, token } = await askForCode(email)
    const done = await use(token, cookie)
    expect(done.status).toBe(200)
    const created = await accountOf(email)
    expect(created).toMatchObject({ emailVerified: true })
    expect(
      await db
        .select()
        .from(member)
        .where(and(eq(member.userId, created!.id), eq(member.organizationId, ws.id))),
    ).toHaveLength(1)
    expect((await db.select().from(invitation).where(eq(invitation.id, id)))[0]!.status).toBe('accepted')
    expect(await whoIs(done.cookies)).toBe(email)
  })
})
