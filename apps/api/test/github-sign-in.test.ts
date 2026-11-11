// GitHub sign-in through Better Auth's real callback, with GitHub's API faked: who gets in, which
// account a GitHub sign-in joins, and that closed sign-up holds.
import { account, user } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.GITHUB_CLIENT_ID = 'test-github-client'
  process.env.GITHUB_CLIENT_SECRET = 'test-github-secret'
})

const { db } = await import('../src/db.ts')
const { appRequest, randomIp, FROM, signUp } = await import('./helpers.ts')

const ORIGIN = 'http://localhost:5173'
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
type GitHubEmail = { email: string; primary: boolean; verified: boolean }

const realFetch = globalThis.fetch

/** GitHub's token endpoint and API as seen by Better Auth; everything else goes through. */
function fakeGitHub(githubId: number, emails: GitHubEmail[], publicEmail: string | null = null) {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('https://github.com/login/oauth/access_token'))
      return json({ access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' })
    if (url === 'https://api.github.com/user')
      return json({
        id: githubId,
        login: `user${githubId}`,
        name: 'GitHub Person',
        avatar_url: null,
        email: publicEmail,
      })
    if (url === 'https://api.github.com/user/emails') return json(emails)
    return realFetch(input, init)
  })
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')

/** Starts "Continue with GitHub" and comes back through the callback, as the browser would. */
async function signInWithGitHub() {
  const ip = randomIp()
  const start = await appRequest('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: ip },
    body: JSON.stringify({ provider: 'github', callbackURL: `${ORIGIN}/`, errorCallbackURL: ORIGIN }),
  })
  expect(start.status).toBe(200)
  const { url } = (await start.json()) as { url: string }
  const authorize = new URL(url)
  const state = authorize.searchParams.get('state')!
  const back = await appRequest(`/api/auth/callback/github?code=test-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie: cookiesOf(start), [FROM]: ip },
  })
  return {
    authorize,
    status: back.status,
    location: back.headers.get('location') ?? '',
    session: back.headers.getSetCookie().some(c => c.includes('session_token=') && !c.includes('Max-Age=0')),
  }
}

const userByEmail = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]
const githubAccountOf = async (userId: string) =>
  (
    await db
      .select()
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
  )[0]

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.AUTH_SIGNUP_ENABLED
})

describe('GitHub sign-in', () => {
  test('asks GitHub for read:user and user:email and comes back to /api/auth/callback/github', async () => {
    fakeGitHub(1, [])
    const { authorize } = await signInWithGitHub()
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(authorize.searchParams.get('scope')).toBe('read:user user:email')
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/github`)
  })

  test('a new person with a verified primary address gets an account with that address, verified', async () => {
    const email = address('gh-new')
    fakeGitHub(1000 + Math.floor(Math.random() * 1e6), [{ email, primary: true, verified: true }], address('public'))
    const result = await signInWithGitHub()
    expect(result).toMatchObject({ status: 302, location: `${ORIGIN}/`, session: true })
    expect(await userByEmail(email)).toMatchObject({ emailVerified: true })
  })

  test('an unverified primary address signs nobody in and creates nobody, whatever other addresses say', async () => {
    const email = address('gh-unverified')
    const other = address('gh-other')
    fakeGitHub(
      2000 + Math.floor(Math.random() * 1e6),
      [
        { email, primary: true, verified: false },
        { email: other, primary: false, verified: true },
      ],
      other,
    )
    const result = await signInWithGitHub()
    expect(result.session).toBe(false)
    expect(result.location).toContain('error=email_not_found')
    expect(await userByEmail(email)).toBeUndefined()
    expect(await userByEmail(other)).toBeUndefined()
  })

  test('joins the existing account with the same verified address', async () => {
    const existing = await signUp(address('gh-existing'))
    const [row] = await db.update(user).set({ emailVerified: true }).where(eq(user.id, existing.userId)).returning()
    fakeGitHub(3000 + Math.floor(Math.random() * 1e6), [{ email: row!.email, primary: true, verified: true }])
    const result = await signInWithGitHub()
    expect(result).toMatchObject({ location: `${ORIGIN}/`, session: true })
    expect(await githubAccountOf(existing.userId)).toBeDefined()
  })

  test('never joins an account by a non-primary or public address', async () => {
    const victim = await signUp(address('gh-victim'))
    const [row] = await db.update(user).set({ emailVerified: true }).where(eq(user.id, victim.userId)).returning()
    // The attacker lists the victim's address publicly and as a secondary (even "verified") address.
    fakeGitHub(
      4000 + Math.floor(Math.random() * 1e6),
      [
        { email: address('attacker'), primary: true, verified: false },
        { email: row!.email, primary: false, verified: true },
      ],
      row!.email,
    )
    const result = await signInWithGitHub()
    expect(result.session).toBe(false)
    expect(await githubAccountOf(victim.userId)).toBeUndefined()
  })

  test('closed sign-up: a new GitHub user is refused; an existing account still signs in', async () => {
    const existing = await signUp(address('gh-closed-existing'))
    const [row] = await db.update(user).set({ emailVerified: true }).where(eq(user.id, existing.userId)).returning()
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    const email = address('gh-closed')
    fakeGitHub(5000 + Math.floor(Math.random() * 1e6), [{ email, primary: true, verified: true }])
    const refused = await signInWithGitHub()
    expect(refused.session).toBe(false)
    // Back to the sign-in page with a reason, not a bare 403 page.
    expect(refused.location).toBe(`${ORIGIN}/?error=SIGNUP_CLOSED&error_description=Sign-up+is+closed+on+this+server.`)
    expect(await userByEmail(email)).toBeUndefined()

    fakeGitHub(6000 + Math.floor(Math.random() * 1e6), [{ email: row!.email, primary: true, verified: true }])
    expect(await signInWithGitHub()).toMatchObject({ location: `${ORIGIN}/`, session: true })
  })
})
