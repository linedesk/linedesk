// WORKSPACE_LIMIT is retired (Janik, 2026-11-15, Q2): a server that still sets it (here 2) gets one warning at start
// and no limit. What still guards creation stays: only a server admin's session with the passkey check, never while
// impersonating, and one setup link creates at most 10. The env is set before anything is imported, as at a real start.
import { organization, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterAll, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.WORKSPACE_LIMIT = '2'
})

const { auth } = await import('../src/auth.ts')
const { db } = await import('../src/db.ts')
const { runAction } = await import('../src/run-action.ts')
const { NOT_WHILE_IMPERSONATING } = await import('../src/impersonation-guard.ts')
const {
  mayCreateWorkspace,
  SETUP_LINK_CAP_TEXT,
  SETUP_LINK_WORKSPACE_CAP,
  WORKSPACE_CREATION_CLOSED,
  workspaceLimitRemovedWarning,
} = await import('../src/workspace-creation.ts')
const { SETUP_LINK_NO_OWNER } = await import('../src/workspace-creation-handlers.ts')
const { act, appRequest, asServerAdmin, FROM, randomIp, request, signUp } = await import('./helpers.ts')
const { member } = await import('@linedesk/db')
const memberTable = member

afterAll(() => {
  delete process.env.WORKSPACE_LIMIT
})

const madeNamed = (name: string) => db.select().from(organization).where(eq(organization.name, name))

test('a WORKSPACE_LIMIT still in the environment: one warning that it is ignored, whatever its value; no Better Auth limit', () => {
  expect(workspaceLimitRemovedWarning({})).toBeNull()
  for (const value of ['2', '', 'five'])
    expect(workspaceLimitRemovedWarning({ WORKSPACE_LIMIT: value })).toMatch(/^WORKSPACE_LIMIT is no longer read/)
  expect(workspaceLimitRemovedWarning()).toMatch(/no longer read/)
  expect(auth.options.plugins.find(p => p.id === 'organization')?.options).not.toHaveProperty('organizationLimit')
})

test('New workspace in the app: past the old limit of 2, no "You can create up to" answer', async () => {
  const admin = await signUp()
  await asServerAdmin(admin, async () => {
    for (const name of ['Business 1', 'Business 2', 'Business 3', 'Business 4'])
      expect((await request(admin, 'POST', '/v1/workspaces', { name })).status).toBe(200)
  })
  expect(await db.select().from(member).where(eq(member.userId, admin.userId))).toHaveLength(4)
}, 30_000)

test('several New workspace requests at once all go through', async () => {
  const admin = await signUp()
  const results = await asServerAdmin(admin, () =>
    Promise.all(['First', 'Second', 'Third'].map(name => request(admin, 'POST', '/v1/workspaces', { name }))),
  )
  expect(results.map(r => r.status)).toEqual([200, 200, 200])
  expect(await db.select().from(member).where(eq(member.userId, admin.userId))).toHaveLength(3)
}, 30_000)

test("workspace.create: the admin's own workspaces (also with their own address as owner) past 2; one for an owner as before", async () => {
  const admin = await signUp()
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, admin.userId))
  const [account] = await db.select().from(user).where(eq(user.id, admin.userId))
  await asServerAdmin(admin, async () => {
    for (const name of ['Own One', 'Own Two']) expect((await act(admin, 'workspace.create', { name })).status).toBe(200)
    const third = await act(admin, 'workspace.create', {
      name: 'Own Three',
      owner: { email: account!.email.toUpperCase() },
    })
    expect(third).toMatchObject({ status: 200, body: { data: { owner: { userId: admin.userId, joined: 'added' } } } })
    const owner = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, owner.userId))
    const [ownerAccount] = await db.select().from(user).where(eq(user.id, owner.userId))
    const forOwner = await act(admin, 'workspace.create', {
      name: 'Riverside Dental',
      owner: { email: ownerAccount!.email },
    })
    expect(forOwner.status).toBe(200)
  })
  expect(await db.select().from(member).where(eq(member.userId, admin.userId))).toHaveLength(3)
}, 30_000)

test('creating a workspace still needs a server admin: a workspace owner is refused in the app and the action, nothing made', async () => {
  const owner = await signUp()
  await asServerAdmin(owner, () => request(owner, 'POST', '/v1/workspaces', { name: 'Their Business' }))
  expect(await act(owner, 'workspace.create', { name: 'Not Mine To Make' })).toMatchObject({ status: 403 })
  expect(await request(owner, 'POST', '/v1/workspaces', { name: 'Not Mine To Make' })).toMatchObject({
    status: 403,
    body: { ok: false, code: 'workspace_creation_closed' },
  })
  expect(await madeNamed('Not Mine To Make')).toEqual([])
}, 30_000)

test('still needs the passkey check and is never possible while impersonating, nothing made', async () => {
  const admin = await signUp()
  await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, admin.userId))
  const secondFactor = process.env.ADMIN_SECOND_FACTOR
  process.env.ADMIN_SECOND_FACTOR = 'on'
  try {
    const name = `Checked ${crypto.randomUUID().slice(0, 6)}`
    // A session of the admin that has not passed the passkey check.
    const unchecked = {
      actorId: admin.userId,
      role: 'member' as const,
      workspaceId: null,
      permissions: ['instance:admin' as const],
      adminSecondFactor: 'confirm' as const,
    }
    expect(mayCreateWorkspace(unchecked)).toBe(false)
    expect(await runAction('workspace.create', { name }, unchecked)).toMatchObject({
      status: 403,
      body: { ok: false, code: 'SECOND_FACTOR_REQUIRED' },
    })
    // Signed in as this admin by another one, even with a passkey check.
    const by = await signUp()
    const impersonating = {
      ...unchecked,
      adminSecondFactor: undefined,
      passkeyConfirmed: true as const,
      impersonation: { by: by.userId, sessionId: 'impersonation', expiresAt: new Date(Date.now() + 60_000) },
    }
    expect(await runAction('workspace.create', { name }, impersonating)).toMatchObject({
      status: 403,
      body: { ok: false, error: NOT_WHILE_IMPERSONATING },
    })
    expect(await madeNamed(name)).toEqual([])
    // Control: the same admin with the passkey check makes it.
    const { impersonation: _, ...checked } = impersonating
    expect((await runAction('workspace.create', { name }, checked)).status).toBe(200)
    expect(await madeNamed(name)).toHaveLength(1)
  } finally {
    if (secondFactor === undefined) delete process.env.ADMIN_SECOND_FACTOR
    else process.env.ADMIN_SECOND_FACTOR = secondFactor
    await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, admin.userId))
  }
}, 30_000)

test('the setup agent: past the old limit, but one setup link still creates at most 10 (SETUP_LINK_WORKSPACE_CAP)', async () => {
  const admin = await signUp()
  await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, admin.userId))
  const made = await act(admin, 'agentSetup.createKey', {})
  expect(made.status).toBe(200)
  const key = (made.body.data as { key: string }).key
  const create = async (name: string) => {
    const res = await appRequest(`/mcp/setup/${key}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [FROM]: randomIp(),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: name,
        method: 'tools/call',
        params: { name: 'workspace_create', arguments: { name } },
      }),
    })
    const text = await res.text()
    const json = text.startsWith('{')
      ? text
      : (text
          .split('\n')
          .find(l => l.startsWith('data: '))
          ?.slice(6) ?? 'null')
    return JSON.parse(json).result as { isError?: boolean; content: { text: string }[] }
  }
  expect(SETUP_LINK_WORKSPACE_CAP).toBe(10)
  for (let i = 1; i <= SETUP_LINK_WORKSPACE_CAP; i++) {
    const done = await create(`Location ${i}`)
    expect(done.isError, done.content[0]?.text).toBeFalsy()
  }
  const refused = await create('One too many')
  expect(refused.isError).toBe(true)
  expect(refused.content[0]!.text).toBe(SETUP_LINK_CAP_TEXT)
  expect(await db.select().from(member).where(eq(member.userId, admin.userId))).toHaveLength(SETUP_LINK_WORKSPACE_CAP)
}, 60_000)

test('with an owner, workspace.create re-checks the caller under a lock and refuses a setup link (review of #761, F3)', async () => {
  const admin = await signUp()
  await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, admin.userId))
  const owner = { email: `owner_${crypto.randomUUID().slice(0, 8)}@linedesk.test`, name: 'Olive Owner' }
  const checked = {
    actorId: admin.userId,
    role: 'member' as const,
    workspaceId: null,
    permissions: ['instance:admin' as const],
    passkeyConfirmed: true as const,
  }
  try {
    // Through a setup link: only the admin's own workspaces (their cap is counted there), never one for an owner.
    const viaLink = `Via Link ${crypto.randomUUID().slice(0, 6)}`
    expect(
      await runAction('workspace.create', { name: viaLink, owner }, { ...checked, setupKeyId: 'any-key' }),
    ).toMatchObject({
      status: 403,
      body: { ok: false, error: SETUP_LINK_NO_OWNER },
    })
    expect(await madeNamed(viaLink)).toEqual([])
    // The account is no longer a server admin, or is disabled, after the caller was resolved: refused, nothing made.
    const demoted = `Demoted ${crypto.randomUUID().slice(0, 6)}`
    await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, admin.userId))
    expect(await runAction('workspace.create', { name: demoted, owner }, checked)).toMatchObject({
      status: 403,
      body: { ok: false, error: WORKSPACE_CREATION_CLOSED },
    })
    await db.update(user).set({ instanceAdmin: true, disabledAt: new Date() }).where(eq(user.id, admin.userId))
    expect(await runAction('workspace.create', { name: demoted, owner }, checked)).toMatchObject({
      status: 403,
      body: { ok: false, error: WORKSPACE_CREATION_CLOSED },
    })
    expect(await madeNamed(demoted)).toEqual([])
    // Control: enabled and still an admin, it makes the workspace for the owner.
    await db.update(user).set({ disabledAt: null }).where(eq(user.id, admin.userId))
    expect((await runAction('workspace.create', { name: demoted, owner }, checked)).status).toBe(200)
    expect(await madeNamed(demoted)).toHaveLength(1)
  } finally {
    await db.update(user).set({ instanceAdmin: false, disabledAt: null }).where(eq(user.id, admin.userId))
  }
}, 30_000)

test("Better Auth's own create endpoint stays off, also with a trailing or double slash: 404, nothing made (review of #761, F5)", async () => {
  // Without WORKSPACE_LIMIT this gate is the only thing in front of Better Auth's organization create.
  const member = await signUp()
  const admin = await signUp()
  await asServerAdmin(admin, async () => {
    for (const who of [member, admin])
      for (const path of [
        '/api/auth/organization/create',
        '/api/auth/organization/create/',
        '/api/auth//organization/create',
      ]) {
        const name = `Bare ${crypto.randomUUID().slice(0, 8)}`
        const res = await request(
          who,
          'POST',
          path,
          { name, slug: name.toLowerCase().replace(' ', '-') },
          {
            origin: 'http://localhost:5173',
            [FROM]: randomIp(),
          },
        )
        expect(res.status, path).toBe(404)
        expect(await madeNamed(name), path).toEqual([])
      }
  })
  expect(await db.select().from(memberTable).where(eq(memberTable.userId, member.userId))).toEqual([])
}, 30_000)
