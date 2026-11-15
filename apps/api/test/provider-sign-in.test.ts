// One email, one account: Google, Microsoft and GitHub sign-ins through Better Auth's real callback,
// with each provider's token endpoint and API faked. For every provider: an existing verified user,
// a user made by an invitation who never signed in, a user made by another provider, no user with
// sign-up closed and open, and a provider that does not prove the email.
import { account, invitation, member, session, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { MICROSOFT_CONSUMER_TENANT } from '../src/account-linking.ts'

vi.hoisted(() => {
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: 'test-google',
    GOOGLE_CLIENT_SECRET: 's',
    MICROSOFT_CLIENT_ID: 'test-microsoft',
    MICROSOFT_CLIENT_SECRET: 's',
    GITHUB_CLIENT_ID: 'test-github',
    GITHUB_CLIENT_SECRET: 's',
  })
})

const { db } = await import('../src/db.ts')
const { appRequest, createWorkspace, randomIp, FROM, signUp } = await import('./helpers.ts')

const ORIGIN = 'http://localhost:5173'
const WORK_TENANT = '6f2c1d4e-0b7a-4a55-9c0e-2a4d5b8e1f30'
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const subject = () => String(Math.floor(Math.random() * 1e12))

type Provider = 'google' | 'microsoft' | 'github'
/** What the provider says about the person; `verified: false` means it does not prove the email. */
type Identity = { email: string; verified: boolean; id?: string; microsoftWork?: boolean }

// An ID token is read, not verified, by Better Auth (it comes straight from the token endpoint over TLS).
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.c2ln`

function idTokenFor(provider: Provider, who: Identity) {
  const now = Math.floor(Date.now() / 1000)
  const base = { iat: now, exp: now + 600, name: 'Person', email: who.email }
  if (provider === 'google')
    return idToken({
      ...base,
      iss: 'https://accounts.google.com',
      aud: 'test-google',
      sub: who.id,
      email_verified: who.verified,
    })
  // Microsoft: a personal account proves its email; a work account only with xms_edov (domain owner verified).
  const tid = who.microsoftWork || !who.verified ? WORK_TENANT : MICROSOFT_CONSUMER_TENANT
  return idToken({
    ...base,
    iss: `https://login.microsoftonline.com/${tid}/v2.0`,
    aud: 'test-microsoft',
    tid,
    oid: who.id,
    sub: who.id,
    ...(who.microsoftWork && who.verified ? { xms_edov: true } : {}),
  })
}

const realFetch = globalThis.fetch
function fakeProvider(provider: Provider, who: Identity) {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    if (
      url.startsWith('https://oauth2.googleapis.com/token') ||
      url.includes('login.microsoftonline.com/common/oauth2/v2.0/token')
    )
      return json({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: idTokenFor(provider, who) })
    if (url.startsWith('https://graph.microsoft.com/')) return new Response('', { status: 404 })
    if (url.startsWith('https://github.com/login/oauth/access_token'))
      return json({ access_token: 'gho', token_type: 'bearer', scope: 'read:user,user:email' })
    if (url === 'https://api.github.com/user')
      return json({ id: Number(who.id), login: 'person', name: 'Person', email: null })
    if (url === 'https://api.github.com/user/emails')
      return json([{ email: who.email, primary: true, verified: who.verified }])
    return realFetch(input, init)
  })
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')

async function signInWith(provider: Provider, who: Identity) {
  fakeProvider(provider, { id: subject(), ...who })
  const ip = randomIp()
  const start = await appRequest('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: ip },
    body: JSON.stringify({ provider, callbackURL: `${ORIGIN}/`, errorCallbackURL: ORIGIN }),
  })
  expect(start.status).toBe(200)
  const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')!
  const back = await appRequest(`/api/auth/callback/${provider}?code=c&state=${encodeURIComponent(state)}`, {
    headers: { cookie: cookiesOf(start), [FROM]: ip },
  })
  vi.unstubAllGlobals()
  const location = back.headers.get('location') ?? ''
  const signedIn = back.headers.getSetCookie().some(c => c.includes('session_token=') && !c.includes('Max-Age=0'))
  return { signedIn, location, error: new URL(location || ORIGIN).searchParams.get('error') }
}

const userByEmail = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]
const providerAccount = async (userId: string, providerId: string) =>
  (
    await db
      .select()
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, providerId)))
  )[0]

/** A user as an invitation or user.invite leaves it: unverified, no password, never signed in. */
async function invitedUser(email: string) {
  const id = `usr_${crypto.randomUUID().slice(0, 12)}`
  await db.insert(user).values({ id, name: 'Invited', email, emailVerified: false })
  return id
}

let ownerId: string
let workspaceId: string
/** A pending invitation to the test workspace: the only way a provider sign-in may create an account. */
async function inviteTo(email: string) {
  const id = `inv_${crypto.randomUUID().slice(0, 8)}`
  await db.insert(invitation).values({
    id,
    organizationId: workspaceId,
    email,
    role: 'member',
    status: 'pending',
    inviterId: ownerId,
    expiresAt: new Date(Date.now() + 3_600_000),
  })
  return id
}
beforeAll(async () => {
  const ws = await createWorkspace('Linking Workspace')
  ownerId = ws.owner.userId
  workspaceId = ws.id
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const providers: Provider[] = ['google', 'microsoft', 'github']
const other = (p: Provider): Provider => (p === 'google' ? 'microsoft' : p === 'microsoft' ? 'github' : 'google')

describe.each(providers)('%s sign-in', provider => {
  test('an existing verified account: lands in it', async () => {
    const existing = await signUp(address(`${provider}-verified`))
    const [row] = await db.update(user).set({ emailVerified: true }).where(eq(user.id, existing.userId)).returning()
    const result = await signInWith(provider, { email: row!.email, verified: true })
    expect(result).toMatchObject({ signedIn: true, location: `${ORIGIN}/` })
    expect(await providerAccount(existing.userId, provider)).toBeDefined()
  })

  test('an account made by an invitation that never signed in: lands in it, marks it verified, the invitation still works', async () => {
    const email = address(`${provider}-invited`)
    const userId = await invitedUser(email)
    const inviteId = `inv_${crypto.randomUUID().slice(0, 8)}`
    await db.insert(invitation).values({
      id: inviteId,
      organizationId: workspaceId,
      email,
      role: 'member',
      status: 'pending',
      inviterId: ownerId,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    const result = await signInWith(provider, { email, verified: true })
    expect(result).toMatchObject({ signedIn: true, error: null })
    expect(await providerAccount(userId, provider)).toBeDefined()
    expect((await userByEmail(email))!.emailVerified).toBe(true)
    expect((await db.select().from(invitation).where(eq(invitation.id, inviteId)))[0]!.status).toBe('pending')
  })

  test('an account made by another provider: lands in the same account', async () => {
    const email = address(`${provider}-other`)
    await inviteTo(email)
    expect((await signInWith(other(provider), { email, verified: true })).signedIn).toBe(true)
    const first = await userByEmail(email)
    expect((await signInWith(provider, { email, verified: true })).signedIn).toBe(true)
    expect(await providerAccount(first!.id, provider)).toBeDefined()
    expect(await providerAccount(first!.id, other(provider))).toBeDefined()
  })

  test('no account and no invitation: refused with "No account for this email", nobody created', async () => {
    const stranger = address(`${provider}-stranger`)
    expect(await signInWith(provider, { email: stranger, verified: true })).toMatchObject({
      signedIn: false,
      error: 'SIGNUP_CLOSED',
    })
    expect(await userByEmail(stranger)).toBeUndefined()
  })

  test('no account but a pending invitation: a new verified account that joins the workspace in the same step', async () => {
    const email = address(`${provider}-new`)
    const inviteId = await inviteTo(email)
    expect((await signInWith(provider, { email, verified: true })).signedIn).toBe(true)
    const created = (await userByEmail(email))!
    expect(created.emailVerified).toBe(true)
    const joined = await db.select().from(member).where(and(eq(member.userId, created.id), eq(member.organizationId, workspaceId)))
    expect(joined.map(m => m.role)).toEqual(['member'])
    expect((await db.select().from(invitation).where(eq(invitation.id, inviteId)))[0]!.status).toBe('accepted')
  })

  test('the provider does not prove the email: nobody signed in, linked or created', async () => {
    const existing = await signUp(address(`${provider}-unproven`))
    const [row] = await db.update(user).set({ emailVerified: true }).where(eq(user.id, existing.userId)).returning()
    expect(await signInWith(provider, { email: row!.email, verified: false })).toMatchObject({
      signedIn: false,
      error: 'email_not_found',
    })
    expect(await providerAccount(existing.userId, provider)).toBeUndefined()
    const nobody = address(`${provider}-nobody`)
    expect((await signInWith(provider, { email: nobody, verified: false })).signedIn).toBe(false)
    expect(await userByEmail(nobody)).toBeUndefined()
  })
})

describe('Microsoft work accounts', () => {
  test('a work account with a domain-verified email (xms_edov) lands in the account; one without is refused', async () => {
    const existing = await signUp(address('ms-work'))
    const [row] = await db.update(user).set({ emailVerified: true }).where(eq(user.id, existing.userId)).returning()
    expect((await signInWith('microsoft', { email: row!.email, verified: false, microsoftWork: true })).error).toBe(
      'email_not_found',
    )
    expect((await signInWith('microsoft', { email: row!.email, verified: true, microsoftWork: true })).signedIn).toBe(
      true,
    )
  })
})

describe('an unverified password account', () => {
  test('linking a proven email drops the unproven password and sessions, so whoever set it up first keeps no way in', async () => {
    const squatter = await signUp(address('squatted'))
    const [row] = await db.select().from(user).where(eq(user.id, squatter.userId))
    expect(row!.emailVerified).toBe(false)
    expect(await providerAccount(squatter.userId, 'credential')).toBeDefined()
    expect((await signInWith('google', { email: row!.email, verified: true })).signedIn).toBe(true)
    expect(await providerAccount(squatter.userId, 'credential')).toBeUndefined()
    const sessions = await db.select().from(session).where(eq(session.userId, squatter.userId))
    expect(sessions).toHaveLength(1) // only the Google sign-in's own session
  })
})

describe('a sign-in whose state is unknown or expired', () => {
  test("goes back to the app's sign-in screen with the error code, never to Better Auth's error page", async () => {
    const res = await appRequest('/api/auth/callback/google?code=c&state=not-a-state', { redirect: 'manual', headers: { [FROM]: randomIp() } })
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location')!)
    expect(to.origin).toBe(ORIGIN)
    expect(to.searchParams.get('error')).toBe('state_mismatch')
    const page = await appRequest('/api/auth/error?error=state_mismatch', { redirect: 'manual', headers: { [FROM]: randomIp() } })
    expect(page.headers.get('location')).toBe(`${ORIGIN}/?error=state_mismatch`)
  })
})

describe('a provider ID token posted by the client (F1)', () => {
  test('is refused for sign-in and for linking: Linedesk only signs in through the provider redirect', async () => {
    for (const path of ['/api/auth/sign-in/social', '/api/auth/link-social']) {
      const res = await appRequest(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
        body: JSON.stringify({ provider: 'google', idToken: { token: 'header.payload.signature' } }),
      })
      expect(res.status, path).toBe(403)
      expect(((await res.json()) as { code?: string }).code, path).toBe('ID_TOKEN_SIGN_IN_OFF')
    }
    // The redirect itself still starts.
    const redirect = await appRequest('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
      body: JSON.stringify({ provider: 'google', callbackURL: ORIGIN }),
    })
    expect(redirect.status).toBe(200)
  })
})

describe('the state of a provider sign-in', () => {
  test('lives in one encrypted cookie for 10 minutes, so a slow provider sign-in (over 5 minutes) still finishes', async () => {
    const start = await appRequest('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
      body: JSON.stringify({ provider: 'github', callbackURL: ORIGIN }),
    })
    expect(start.status).toBe(200)
    const cookies = start.headers.getSetCookie()
    const state = cookies.find(c => /oauth_state=/.test(c))
    expect(state).toMatch(/Max-Age=600/)
    expect(state).toMatch(/HttpOnly/)
    expect(cookies.some(c => /(^|\.)state=/.test(c.split(';')[0]!) && !/oauth_state/.test(c))).toBe(false)
  })
})
