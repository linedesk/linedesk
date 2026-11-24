// The GitHub star prompt: on for every install, due once the account is a few minutes old and the
// workspace is past onboarding, never for someone signed in as the member; any answer is final. One click: a GitHub token with
// public_repo is used once to star, then the grant is revoked and the token and scope are cleared.
import { STAR_REPO } from '@linedesk/actions'
import { account, star_prompts, workspace_settings } from '@linedesk/db'
import { decryptOAuthToken, setTokenUtil } from 'better-auth/oauth2'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { grantsStarring, revokeGitHubGrant, starOnGitHub, starOnGrant, starPromptFor } from '../src/star-prompt.ts'
import { act, addMember, createWorkspace, request, type User } from './helpers.ts'

const REPO = 'linedesk/linedesk'
const uid = (p: string) => `${p}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
const me = async (who: User) => (await request(who, 'GET', '/v1/me')).body.starPrompt

/** Better Auth's context, typed as its token helpers expect it. */
const authContext = async () => (await auth.$context) as unknown as Parameters<typeof setTokenUtil>[1]

afterEach(() => vi.unstubAllGlobals())

/** A new workspace starts in onboarding: this one has finished it. */
async function onboarded(name: string) {
  const ws = await createWorkspace(name)
  await db.update(workspace_settings).set({ onboarding_step: 'done' }).where(eq(workspace_settings.workspace_id, ws.id))
  return ws
}

/** A workspace in use: past onboarding. */
const inUse = onboarded

/** A GitHub account row as Better Auth stores it: the token encrypted. */
async function linkGitHub(who: User, scope: string, token = 'gho_test') {
  const ctx = await authContext()
  const [row] = await db
    .insert(account)
    .values({
      id: uid('acc'),
      accountId: uid('gh'),
      providerId: 'github',
      userId: who.userId,
      accessToken: (await setTokenUtil(token, ctx)) as string,
      scope,
      updatedAt: new Date(),
    })
    .returning()
  return row!
}

const githubRow = async (id: string) => (await db.select().from(account).where(eq(account.id, id)))[0]!
const answerOf = async (who: User) =>
  (await db.select().from(star_prompts).where(eq(star_prompts.user_id, who.userId)))[0]?.answer

/** GitHub as fetch sees it: PUT star answers `star`, everything else 204. */
function fakeGitHub(star = 204) {
  const github = vi.fn(
    async (_url: string, init?: RequestInit) => new Response(null, { status: init?.method === 'PUT' ? star : 204 }),
  )
  vi.stubGlobal('fetch', github)
  return github
}

describe('when the prompt is due', () => {
  test("on for every install, asking for Linedesk's own repository", () => {
    expect(STAR_REPO).toBe(REPO)
  })

  test('due from the start once onboarding is done; no calls or account age needed', async () => {
    const ws = await onboarded('Star Early Plumbing')
    expect(await me(ws.owner)).toEqual({ repo: REPO, github: false })
  })

  test('not during onboarding', async () => {
    const ws = await inUse('Star Onboarding Plumbing')
    await db
      .update(workspace_settings)
      .set({ onboarding_step: 'phone' })
      .where(eq(workspace_settings.workspace_id, ws.id))
    expect(await me(ws.owner)).toBeNull()
  })

  test('never for an instance admin signed in as the member, nor for an API key', async () => {
    const ws = await inUse('Star Impersonated Plumbing')
    const base = {
      actorId: ws.owner.userId,
      role: 'owner' as const,
      workspaceId: ws.id,
      permissions: [],
      sessionId: 's',
    }
    expect(await starPromptFor(base)).not.toBeNull()
    expect(
      await starPromptFor({ ...base, impersonation: { by: 'admin', sessionId: 's', expiresAt: new Date() } }),
    ).toBeNull()
    expect(await starPromptFor({ ...base, sessionId: undefined, apiKeyId: 'key' })).toBeNull()
  })

  test('says whether the member signed in with GitHub (one click)', async () => {
    const ws = await inUse('Star GitHub Plumbing')
    await linkGitHub(ws.owner, 'read:user,user:email')
    expect(await me(ws.owner)).toEqual({ repo: REPO, github: true })
    expect(grantsStarring('repo')).toBe(true)
    expect(grantsStarring('read:user user:email')).toBe(false)
    expect(grantsStarring(null)).toBe(false)
  })
})

describe('answering', () => {
  test('No thanks is final, for this member only', async () => {
    const ws = await inUse('Star Dismiss Plumbing')
    const member = await addMember(ws.id, 'member')
    expect((await act(ws.owner, 'starPrompt.answer', { answer: 'dismissed' })).status).toBe(200)
    expect((await act(ws.owner, 'starPrompt.answer', { answer: 'opened' })).status).toBe(200)
    expect(await answerOf(ws.owner)).toBe('dismissed')
    expect(await me(ws.owner)).toBeNull()
    expect(await me(member)).not.toBeNull()
  })

  test('no browser route hands out provider tokens', async () => {
    const ws = await inUse('Star Token Routes Plumbing')
    await linkGitHub(ws.owner, 'read:user,user:email')
    for (const path of ['/api/auth/get-access-token', '/api/auth/account-info', '/api/auth/refresh-token'])
      expect((await request(ws.owner, 'POST', path, { providerId: 'github' })).status).toBe(404)
  })
})

describe('one click: the grant is used once, then given up', () => {
  test('provider tokens are stored encrypted; rows from before stay readable', async () => {
    const ctx = await authContext()
    const stored = (await setTokenUtil('gho_plain', ctx)) as string
    expect(stored).not.toBe('gho_plain')
    expect(await decryptOAuthToken(stored, ctx)).toBe('gho_plain')
    expect(await decryptOAuthToken('gho_from_before', ctx)).toBe('gho_from_before')
  })

  test('a token with public_repo stars with the decrypted token, then token and write scope are cleared', async () => {
    const ws = await inUse('Star Grant Plumbing')
    const row = await linkGitHub(ws.owner, 'read:user,user:email,public_repo', 'gho_granted')
    const github = fakeGitHub()
    await starOnGrant(row, { context: await authContext() })
    const put = github.mock.calls.find(([, init]) => init?.method === 'PUT')!
    expect(put[0]).toBe(`https://api.github.com/user/starred/${REPO}`)
    expect(new Headers(put[1]?.headers).get('authorization')).toBe('Bearer gho_granted')
    expect(await answerOf(ws.owner)).toBe('starred')
    expect(await githubRow(row.id)).toMatchObject({
      accessToken: null,
      refreshToken: null,
      scope: 'read:user,user:email',
    })
    expect(await me(ws.owner)).toBeNull()
  })

  test('nothing is starred once answered, when GitHub refuses, or past the rate limit; the token goes anyway', async () => {
    const done = await inUse('Star Answered Plumbing')
    await act(done.owner, 'starPrompt.answer', { answer: 'dismissed' })
    const doneRow = await linkGitHub(done.owner, 'public_repo')
    const github = fakeGitHub()
    await starOnGrant(doneRow, { context: await authContext() })
    expect(github.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    expect(await githubRow(doneRow.id)).toMatchObject({ accessToken: null, scope: '' })
    expect(await answerOf(done.owner)).toBe('dismissed')

    const ws = await inUse('Star Refused Plumbing')
    const refused = fakeGitHub(403)
    for (let i = 0; i < 4; i++) {
      const row = await linkGitHub(ws.owner, 'repo', `gho_${i}`)
      await starOnGrant(row, { context: await authContext() })
      expect((await githubRow(row.id)).accessToken).toBeNull()
    }
    // Three tries an hour per member; the fourth does not reach GitHub.
    expect(refused.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(3)
    expect(await answerOf(ws.owner)).toBeUndefined()
  })

  test('wired into Better Auth: storing a GitHub token with public_repo clears it', async () => {
    const ws = await inUse('Star Hook Plumbing')
    const row = await linkGitHub(ws.owner, 'read:user,user:email')
    fakeGitHub()
    const ctx = await authContext()
    await ctx.internalAdapter.updateAccount(row.id, {
      accessToken: (await setTokenUtil('gho_upgraded', ctx)) as string,
      scope: 'read:user,user:email,public_repo',
    })
    await vi.waitFor(async () =>
      expect(await githubRow(row.id)).toMatchObject({ accessToken: null, scope: 'read:user,user:email' }),
    )
    // Other providers and GitHub tokens without write scopes are left alone.
    const plain = await linkGitHub(ws.owner, 'read:user,user:email')
    await starOnGrant({ ...plain, providerId: 'google', scope: 'public_repo' }, { context: ctx })
    await starOnGrant(plain, { context: ctx })
    expect((await githubRow(plain.id)).accessToken).not.toBeNull()
  })

  test('starOnGitHub and revokeGitHubGrant: only 204 counts, network errors are a no', async () => {
    const ok = async () => new Response(null, { status: 204 })
    const no = async () => new Response(null, { status: 403 })
    const offline = async (): Promise<Response> => {
      throw new Error('offline')
    }
    expect(await starOnGitHub('a/b', 't', ok)).toBe(true)
    expect(await starOnGitHub('a/b', 't', no)).toBe(false)
    expect(await starOnGitHub('a/b', 't', offline)).toBe(false)
    const keys = { clientId: 'Iv1.app', clientSecret: 'secret' }
    const seen = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }))
    expect(await revokeGitHubGrant('t', keys, seen as unknown as typeof fetch)).toBe(true)
    const [url, init] = seen.mock.calls[0]!
    expect(url).toBe('https://api.github.com/applications/Iv1.app/grant')
    expect(init?.method).toBe('DELETE')
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('Iv1.app:secret').toString('base64')}`,
    )
    expect(JSON.parse(init?.body as string)).toEqual({ access_token: 't' })
    expect(await revokeGitHubGrant('t', keys, offline)).toBe(false)
  })
})
