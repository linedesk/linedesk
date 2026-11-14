// Setup MCP at /mcp/setup (LIN-125): an instance admin's setup key, the short list of setup tools, and every way a
// key stops working. In INSTANCE_WIDE_FILES: it makes instance admins and stores provider keys.
import { randomBytes } from 'node:crypto'
import { SETUP_MCP_INSTRUCTIONS } from '@linedesk/actions'
import { agent_setup_keys, commands, passkey, phone_numbers, provider_settings, session, user } from '@linedesk/db'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { passkeyStepUpRefusal } from '../src/admin-step-up.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { refuseOtherAccountsPasskey } from '../src/passkeys.ts'
import { emailSender } from '../src/email.ts'
import nodemailer from 'nodemailer'
import type * as RunActionModule from '../src/run-action.ts'
import { PRIVATE_ENDPOINT } from '../src/s3-endpoint.ts'
import { devNumberLine, forAgent, installPartDone, SETUP_ACTIONS } from '../src/setup-mcp.ts'
import { hashSetupKey } from '../src/agent-setup.ts'
import { runAction } from '../src/run-action.ts'
import {
  act,
  appRequest,
  createWorkspace,
  FROM,
  randomIp,
  request,
  signUp,
  type User,
  type Workspace,
} from './helpers.ts'

/** Every action the API runs, with what its actor carried: the setup MCP must not pass the passkey on to workspace actions. */
const ran = vi.hoisted(() => [] as { name: string; setupKeyId?: string; passkeyConfirmed: boolean; admin: boolean }[])
vi.mock('../src/run-action.ts', async importOriginal => {
  const real = await importOriginal<typeof RunActionModule>()
  const runAction: typeof real.runAction = (name, input, actor, ...rest) => {
    ran.push({
      name,
      setupKeyId: actor.setupKeyId,
      passkeyConfirmed: Boolean(actor.passkeyConfirmed),
      admin: actor.permissions.includes('instance:admin'),
    })
    return real.runAction(name, input, actor, ...rest)
  }
  return { ...real, runAction }
})

let id = 0
let ws: Workspace
/** An instance admin without a workspace yet: a fresh install's first admin. */
let fresh: User

const setAdmin = (who: User, on: boolean) => db.update(user).set({ instanceAdmin: on }).where(eq(user.id, who.userId))

async function makeKey(who: User) {
  const res = await act(who, 'agentSetup.createKey', {})
  expect(res.status).toBe(200)
  return res.body.data as { key: string; url: string; keyId: string; expiresAt: string }
}

/** One JSON-RPC request, the key in the path (as Claude and ChatGPT connect) or as Bearer. */
async function mcp(
  key: string | null,
  method: string,
  params: Record<string, unknown> = {},
  { bearer = false, path = '/mcp/setup', from = randomIp() }: { bearer?: boolean; path?: string; from?: string } = {},
) {
  const res = await appRequest(key && !bearer ? `${path}/${key}` : path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [FROM]: from,
      ...(key && bearer ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find(l => l.startsWith('data: '))
        ?.slice(6) ?? 'null')
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted on in the tests
  return { status: res.status, body: JSON.parse(json) as any }
}
const call = (key: string, name: string, args: Record<string, unknown> = {}) =>
  mcp(key, 'tools/call', { name, arguments: args })
const data = (res: { body: { result: { structuredContent: Record<string, unknown> } } }) =>
  res.body.result.structuredContent

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  await setAdmin(ws.owner, true)
  fresh = await signUp()
  await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, fresh.userId))
})

describe('setup keys', () => {
  test('only an instance admin makes one; the key is in the result once, never in the command log', async () => {
    // A workspace owner who is not an instance admin.
    const owner = (await createWorkspace('Other Business')).owner
    expect((await act(owner, 'agentSetup.createKey', {})).status).toBe(403)
    const made = await makeKey(ws.owner)
    expect(made.key).toMatch(/^lds_[A-Za-z0-9_-]{43}$/)
    expect(made.url).toMatch(new RegExp(`/mcp/setup/${made.key}$`))
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, made.keyId))
    expect(row!.key_hash).not.toContain(made.key)
    expect(Date.parse(made.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000)
  })

  test('a new key ends the earlier ones; End agent access ends all of them', async () => {
    const first = await makeKey(ws.owner)
    const second = await makeKey(ws.owner)
    expect((await mcp(first.key, 'tools/list')).status).toBe(401)
    expect((await mcp(second.key, 'tools/list')).status).toBe(200)
    expect((await act(ws.owner, 'agentSetup.revoke', {})).status).toBe(200)
    expect((await mcp(second.key, 'tools/list')).status).toBe(401)
  })

  test('GET /v1/admin/agent-setup says where agents connect and which key works, never the key', async () => {
    const made = await makeKey(ws.owner)
    const res = await appRequest('/v1/admin/agent-setup', { headers: ws.owner.headers })
    const body = await res.json()
    expect(body.mcpUrl).toMatch(/\/mcp\/setup$/)
    expect(body.reachableFromCloud).toBe(false)
    expect(body.key.prefix).toBe(made.key.slice(0, 12))
    expect(JSON.stringify(body)).not.toContain(made.key)
    expect(body.progress.steps.map((s: { id: string }) => s.id)).toContain('telephony')
    // Grouped like the agent's setup_status: the server's part, then the business's.
    const groupOf = (id: string) => body.progress.steps.find((s: { id: string }) => s.id === id)?.group
    expect(groupOf('telephony')).toBe('server')
    expect(groupOf('workspace')).toBe('business')
    // Named like the app's own places, with the industry term where it helps (setupStepNames).
    const step = (id: string) => body.progress.steps.find((s: { id: string }) => s.id === id)
    expect(step('notify')).toMatchObject({ label: 'Notifications' })
    expect(step('telephony')).toMatchObject({ label: 'Phone carrier', hint: 'Telnyx or Twilio' })
    expect(step('call-audio').hint).toMatch(/LiveKit/)
    // The setup works in the admin's first business; this owner has no other one.
    expect(body.progress.otherWorkspaces).toEqual([])
  })
})

describe('access', () => {
  test('the key works in the path and as Bearer; nothing else gets in', async () => {
    const { key } = await makeKey(ws.owner)
    expect((await mcp(key, 'tools/list')).status).toBe(200)
    expect((await mcp(key, 'tools/list', {}, { bearer: true })).status).toBe(200)
    expect((await mcp(null, 'tools/list')).status).toBe(401)
    expect((await mcp('lds_unknown', 'tools/list')).status).toBe(401)
    // A workspace API key is not a setup key, and a setup key opens nothing on the workspace MCP.
    const apiKey = (await act(ws.owner, 'apiKey.create', { name: 'Claude', role: 'admin' })).body.data.key
    expect((await mcp(apiKey, 'tools/list', {}, { bearer: true })).status).toBe(401)
    expect((await mcp(key, 'tools/list', {}, { bearer: true, path: '/mcp' })).status).toBe(401)
  })

  test('an expired key, or one whose creator is no longer an instance admin, stops working', async () => {
    const admin = await signUp()
    await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, admin.userId))
    const made = await makeKey(admin)
    expect((await mcp(made.key, 'tools/list')).status).toBe(200)
    await setAdmin(admin, false)
    expect((await mcp(made.key, 'tools/list')).status).toBe(401)
    await setAdmin(admin, true)
    await db
      .update(agent_setup_keys)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(agent_setup_keys.id, made.keyId))
    expect((await mcp(made.key, 'tools/list')).status).toBe(401)
  })

  test('too many refused keys from one address: 429, but a working key from there still gets in', async () => {
    const from = randomIp()
    for (let i = 0; i < 10; i++) expect((await mcp(`lds_wrong${i}`, 'tools/list', {}, { from })).status).toBe(401)
    expect((await mcp('lds_wrong-last', 'tools/list', {}, { from })).status).toBe(429)
    const { key } = await makeKey(ws.owner)
    expect((await mcp(key, 'tools/list', {}, { from })).status).toBe(200)
  })
})

describe('ended setup links', () => {
  /** A well-formed key nobody ever made. */
  const unknownKey = () => `lds_${randomBytes(32).toString('base64url')}`
  // The server operator, as user-passkeys.ts runs the actions.
  const cli: Actor = {
    actorId: 'cli',
    role: 'member',
    workspaceId: null,
    permissions: ['instance:admin'],
    passkeyConfirmed: true,
  }
  const newAdmin = async () => {
    const admin = await signUp()
    await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, admin.userId))
    return admin
  }

  test('an ended key answers 401 SETUP_KEY_ENDED with why, and never counts towards the address limit', async () => {
    const from = randomIp()
    const admin = await newAdmin()
    const first = await makeKey(admin)
    const second = await makeKey(admin)
    // Far more retries than the 10 unknown keys an address may send: never a 429.
    for (let i = 0; i < 15; i++)
      expect(await mcp(first.key, 'tools/list', {}, { from })).toMatchObject({
        status: 401,
        body: {
          code: 'SETUP_KEY_ENDED',
          reason: 'replaced',
          error: expect.stringMatching(/Ask the admin for the new link/),
        },
      })
    // As Bearer too.
    expect((await mcp(first.key, 'tools/list', {}, { from, bearer: true })).body.code).toBe('SETUP_KEY_ENDED')
    // Unknown keys still count: 10, then the address is blocked; they never get the ended answer.
    for (let i = 0; i < 10; i++) {
      const res = await mcp(unknownKey(), 'tools/list', {}, { from })
      expect(res.status).toBe(401)
      expect(res.body.code).toBeUndefined()
    }
    expect((await mcp(unknownKey(), 'tools/list', {}, { from })).status).toBe(429)
    // A blocked address still hears why its own ended link stopped (it only tells the key's holder), and a working
    // key from there still gets in.
    expect((await mcp(first.key, 'tools/list', {}, { from })).body).toMatchObject({ code: 'SETUP_KEY_ENDED' })
    expect((await mcp(second.key, 'tools/list', {}, { from })).status).toBe(200)

    expect((await act(admin, 'agentSetup.revoke', {})).status).toBe(200)
    expect((await mcp(second.key, 'tools/list')).body).toMatchObject({
      code: 'SETUP_KEY_ENDED',
      reason: 'ended',
      error: expect.stringMatching(/was ended and no longer works\. Ask the admin for a new one/),
    })
    const third = await makeKey(admin)
    await db
      .update(agent_setup_keys)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(agent_setup_keys.id, third.keyId))
    expect((await mcp(third.key, 'tools/list')).body).toMatchObject({ code: 'SETUP_KEY_ENDED', reason: 'expired' })
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, first.keyId))
    expect(row!.ended_reason).toBe('replaced')
  })

  test("an ended key's answer only goes to whoever holds it: a near miss or a malformed key is unknown", async () => {
    const admin = await newAdmin()
    const { key } = await makeKey(admin)
    expect((await act(admin, 'agentSetup.revoke', {})).status).toBe(200)
    const nearMiss = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`
    for (const other of [nearMiss, key.slice(0, -1), key.toUpperCase()]) {
      const res = await mcp(other, 'tools/list')
      expect(res.status).toBe(401)
      expect(res.body.code).toBeUndefined()
    }
  })

  test('the per-key limit comes first: a limited key stays 429 when it ends meanwhile, never the ended answer', async () => {
    const admin = await newAdmin()
    const { key } = await makeKey(admin)
    let status = 200
    for (let i = 0; i < 125 && status === 200; i++) status = (await mcp(key, 'tools/list')).status
    expect(status).toBe(429)
    expect((await act(admin, 'agentSetup.revoke', {})).status).toBe(200)
    expect(await mcp(key, 'tools/list')).toMatchObject({
      status: 429,
      body: { error: expect.stringMatching(/rate limit/) },
    })
  })

  test('removing the admin role ends their setup links for good: a later grant does not revive them', async () => {
    const admin = await newAdmin()
    const { key, keyId } = await makeKey(admin)
    const was = process.env.ADMIN_SECOND_FACTOR
    process.env.ADMIN_SECOND_FACTOR = 'off'
    try {
      expect((await act(fresh, 'instanceAdmin.revoke', { userId: admin.userId })).status).toBe(200)
    } finally {
      process.env.ADMIN_SECOND_FACTOR = was
    }
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
    expect(row).toMatchObject({ ended_reason: 'admin_role_removed', revoked_at: expect.anything() })
    expect((await mcp(key, 'tools/list')).body).toMatchObject({ code: 'SETUP_KEY_ENDED', reason: 'ended' })
    await setAdmin(admin, true)
    expect((await mcp(key, 'tools/list')).body).toMatchObject({ code: 'SETUP_KEY_ENDED', reason: 'ended' })
  })

  test('an ended key keeps the per-key limit of a working one', async () => {
    const admin = await newAdmin()
    const { key } = await makeKey(admin)
    expect((await act(admin, 'agentSetup.revoke', {})).status).toBe(200)
    let status = 401
    for (let i = 0; i < 125 && status === 401; i++) status = (await mcp(key, 'tools/list')).status
    expect(status).toBe(429)
  })

  test('the enrolment code for an admin without a passkey ends nothing: their link and sessions keep working', async () => {
    const admin = await newAdmin()
    const { key } = await makeKey(admin)
    const sessions = await db.select().from(session).where(eq(session.userId, admin.userId))
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const res = await runAction('user.issuePasskeyEnrolment', { userId: admin.userId }, cli)
    expect(res).toMatchObject({ status: 200, body: { data: { enrolmentCode: expect.any(String) } } })
    expect((await mcp(key, 'tools/list')).status).toBe(200)
    expect(await db.select().from(session).where(eq(session.userId, admin.userId))).toEqual(sessions)
    expect((await request(admin, 'GET', '/v1/me')).status).toBe(200)
    const [row] = await db
      .select()
      .from(agent_setup_keys)
      .where(eq(agent_setup_keys.key_hash, hashSetupKey(key)))
    expect(row!.revoked_at).toBeNull()
    send.mockRestore()
  })

  test('with a passkey, --enrol is refused and the reset (--remove) ends their sessions and setup links, saying how many', async () => {
    const admin = await newAdmin()
    const { key } = await makeKey(admin)
    await db.insert(passkey).values({
      id: `pk_${crypto.randomUUID().slice(0, 12)}`,
      userId: admin.userId,
      publicKey: 'cHVibGlj',
      credentialID: `cred-${crypto.randomUUID()}`,
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
    })
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const refused = await runAction('user.issuePasskeyEnrolment', { userId: admin.userId }, cli)
    expect(refused.status).toBe(409)
    expect((await mcp(key, 'tools/list')).status).toBe(200)
    const reset = await runAction('user.resetPasskeys', { userId: admin.userId }, cli)
    expect(reset).toMatchObject({
      status: 200,
      body: { data: { removed: 1, sessionsEnded: 1, setupLinksEnded: 1, enrolmentCode: expect.any(String) } },
    })
    expect(await db.select().from(session).where(eq(session.userId, admin.userId))).toEqual([])
    expect((await mcp(key, 'tools/list')).body).toMatchObject({
      code: 'SETUP_KEY_ENDED',
      // Stored as passkeys_reset, shown as the generic `ended`.
      reason: 'ended',
      error: expect.not.stringMatching(/passkey/),
    })
    send.mockRestore()
  })
})

describe('tools', () => {
  test('setup tools only: no users, admins, keys, impersonation or deleting', async () => {
    const { key } = await makeKey(ws.owner)
    const names: string[] = (await mcp(key, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name)
    for (const name of ['setup_status', 'providers_list', 'workspace_create', 'forwarding_guide'])
      expect(names).toContain(name)
    for (const action of SETUP_ACTIONS) expect(names).toContain(action.replaceAll('.', '_'))
    for (const name of [
      'user_invite',
      'instanceAdmin_grant',
      'user_impersonate',
      'workspace_delete',
      'apiKey_create',
      'agentSetup_createKey',
      'membership_add',
      'call_delete',
    ])
      expect(names).not.toContain(name)
    expect((await call(key, 'apiKey_create', { name: 'x' })).body.error.message).toMatch(/not found/)
  })

  test('a fresh install: setup_status points at the providers, then the business; workspace_create makes it once', async () => {
    const { key } = await makeKey(fresh)
    const before = data(await call(key, 'setup_status')) as {
      next_step: string
      steps: { id: string; group: string; state: string; alias?: string; how?: string[] }[]
      app_links: Record<string, string>
      install: { public: boolean; place?: string; note?: string }
    }
    // The provider steps carry the group ids of Admin › Providers; the old names stay as aliases.
    expect(before.steps.map(s => s.id).slice(0, 5)).toEqual([
      'answering',
      'telephony',
      'email',
      'call-audio',
      'workspace',
    ])
    expect(before.steps.find(s => s.id === 'answering')?.alias).toBe('ai')
    expect(before.steps.find(s => s.id === 'call-audio')?.alias).toBe('livekit')
    // Each step names its part of the setup: the server's (once per install), then the first business's.
    expect(before.steps.map(s => s.group)).toEqual([
      ...Array(4).fill('server'),
      ...Array(before.steps.length - 4).fill('business'),
    ])
    // The same words as the app.
    expect(before.steps.slice(0, 4).map(s => s.state)).toEqual(['todo', 'todo', 'todo', 'todo'])
    expect((before.steps[0] as { detail?: string }).detail).toMatch(/^Not set up/)
    // The tests run on localhost: the agent hears that phone calls need a server, and how to move there.
    expect(before.install).toMatchObject({ public: false, place: 'this_computer' })
    expect(before.install.note).toContain('scripts/install.sh')
    // Only the next step carries its instructions.
    expect(before.steps.filter(s => s.how).map(s => s.id)).toEqual([before.next_step])
    expect(before.app_links.providers).toMatch(/#admin\/providers$/)
    // One link per group.
    expect(before.app_links.providers_email).toMatch(/#admin\/providers\/email$/)
    expect(before.app_links.providers_call_audio).toMatch(/#admin\/providers\/call-audio$/)
    expect(before.app_links.providers_sign_in).toMatch(/#admin\/providers\/sign-in$/)

    const made = data(await call(key, 'workspace_create', { name: 'Riverside Dental', timeZone: 'America/Chicago' }))
    expect(made).toMatchObject({ ok: true, workspace: { name: 'Riverside Dental' } })
    const again = await call(key, 'workspace_create', { name: 'Second' })
    expect(again.body.result.isError).toBe(true)
    const after = data(await call(key, 'setup_status')) as { steps: { id: string; state: string }[] }
    expect(after.steps.find(s => s.id === 'workspace')?.state).toBe('done')
    expect(after.steps.map(s => s.id)).toEqual(expect.arrayContaining(['business', 'pickup', 'notify', 'phone']))
  })

  test('workspace and provider tools run through the registry as the admin, in their own workspace', async () => {
    const { key } = await makeKey(ws.owner)
    expect(data(await call(key, 'workspace_updateSettings', { pickupMode: 'no_answer' }))).toMatchObject({ ok: true })
    const stored = await call(key, 'provider_setKeys', {
      provider: 'deepgram',
      values: { api_key: 'dg-test-key-1234' },
    })
    // The free test runs right after saving and comes back as `test`, as the tool's description says.
    expect(data(stored)).toMatchObject({ ok: true, test: { ok: expect.any(Boolean), message: expect.any(String) } })
    const [row] = await db.select().from(provider_settings).where(eq(provider_settings.provider, 'deepgram'))
    expect(row!.value_encrypted).not.toContain('dg-test-key-1234')
    expect(row!.updated_by).toBe(ws.owner.userId)
    const listed = data(await call(key, 'providers_list', { category: 'stt' })) as {
      providers: { provider: string; fields: { field: string; set: boolean }[] }[]
    }
    expect(listed.providers.find(p => p.provider === 'deepgram')?.fields).toContainEqual(
      expect.objectContaining({ field: 'api_key', set: true }),
    )
    expect(JSON.stringify(listed)).not.toContain('dg-test-key-1234')
    await db.delete(provider_settings).where(eq(provider_settings.provider, 'deepgram'))
  })

  test('forwarding_guide gives the codes for a number in a forwarding mode', async () => {
    const { key } = await makeKey(ws.owner)
    await db.update(phone_numbers).set({ mode: 'forward_conditional' }).where(eq(phone_numbers.workspace_id, ws.id))
    const guide = data(await call(key, 'forwarding_guide', { carrier: 'Verizon' })) as {
      forward_to: string
      guides: { id: string; instructions: { on: { code: string }[] } }[]
    }
    expect(guide.forward_to).toBe(ws.number)
    expect(guide.guides[0]!.instructions.on[0]!.code).toContain(ws.number.slice(2))
  })
})

describe('every key through the agent (LIN-182)', () => {
  const SECRET = 'sk-secret-value-WXYZ'
  const text = (res: { body: { result: { content: { text: string }[] } } }) => res.body.result.content[0]!.text
  const passkeyRow = (userId: string) => ({
    id: `pk_${crypto.randomUUID().slice(0, 12)}`,
    userId,
    publicKey: 'cHVibGlj',
    credentialID: `cred-${crypto.randomUUID()}`,
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
  })
  /** The admin's own browser session: signed in a moment ago, with a passkey or not. */
  const signedIn = (who: User, withPasskey: boolean) =>
    db
      .update(session)
      // A new sign-in: its passkey (if any) has given no setup link a grant yet.
      .set({ createdAt: new Date(), passkeyVerifiedAt: withPasskey ? new Date() : null, passkeyGrantUsedAt: null })
      .where(eq(session.userId, who.userId))
  const clear = (...providers: string[]) =>
    Promise.all(providers.map(p => db.delete(provider_settings).where(eq(provider_settings.provider, p))))

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"invalid key"}', { status: 401 }))
  })
  afterEach(async () => {
    process.env.ADMIN_SECOND_FACTOR = 'off'
    vi.restoreAllMocks()
    await db.delete(passkey).where(eq(passkey.userId, ws.owner.userId))
    await signedIn(ws.owner, false)
    await clear('resend', 's3', 'google_places', 'google')
  })

  test('recording storage and business lookup: stored, tested right after, never echoed; the audit log says it was the agent', async () => {
    const made = await makeKey(ws.owner)
    const res = await call(made.key, 'provider_setKeys', {
      provider: 'google_places',
      values: { api_key: SECRET },
    })
    expect(res.body.result.isError).toBeFalsy()
    const saved = data(res) as {
      ok: boolean
      data: { provider: { fields: { field: string; last4: string | null; value: unknown }[] } }
      test: { ok: boolean; message: string }
    }
    expect(saved.ok).toBe(true)
    // The free test ran at once: a made-up key fails with a message the agent can pass on.
    expect(saved.test).toMatchObject({ ok: expect.any(Boolean), message: expect.any(String) })
    expect(saved.data.provider.fields.find(f => f.field === 'api_key')).toMatchObject({ last4: 'WXYZ', value: null })
    // The test's words are for the agent: it stores keys itself, the admin is never sent to the app.
    expect(saved.test.message).toMatch(/provider_setKeys/)
    expect(JSON.stringify(res.body)).not.toMatch(/Admin › Providers/)
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
    const [row] = await db.select().from(provider_settings).where(eq(provider_settings.provider, 'google_places'))
    expect(row!.value_encrypted).not.toContain(SECRET)
    // The command log keeps the values redacted and names the setup key; so does the audit log.
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'provider.setKeys'), eq(commands.actor_id, ws.owner.userId)))
      .orderBy(desc(commands.created_at))
      .limit(1)
    expect(logged!.setup_key_id).toBe(made.keyId)
    expect(JSON.stringify(logged!.input)).not.toContain(SECRET)
    const audit = (await request(ws.owner, 'GET', '/v1/admin/audit?kind=keys')).body.entries as {
      what: string
      viaSetupKey: string | null
    }[]
    expect(audit.find(e => e.what === 'provider.setKeys')?.viaSetupKey).toBe(made.keyId)

    const s3 = await call(made.key, 'provider_setKeys', {
      provider: 's3',
      values: { bucket: 'calls', access_key_id: 'AKIAEXAMPLE', secret_access_key: SECRET },
    })
    expect(data(s3)).toMatchObject({ ok: true, test: { ok: false } })
    expect(JSON.stringify(s3.body)).not.toContain(SECRET)
    expect(data(await call(made.key, 'provider_setActive', { category: 'recording', provider: 's3' }))).toMatchObject({
      ok: true,
    })
  })

  test('the phone step offers the simulated dev number only on an install that is not public', () => {
    // The tests run on localhost.
    expect(devNumberLine().join(' ')).toMatch(/TELEPHONY_PROVIDER=dev .*restart.*simulated number/)
    const before = process.env.PUBLIC_URL
    process.env.PUBLIC_URL = 'https://desk.example.com'
    try {
      expect(devNumberLine()).toEqual([])
    } finally {
      if (before === undefined) delete process.env.PUBLIC_URL
      else process.env.PUBLIC_URL = before
    }
  })

  test('forAgent turns the app wording (under Admin › Providers) into what the agent does', () => {
    expect(
      forAgent('Deepgram rejected the key (HTTP 401). Enter a valid key under Admin › Providers › Deepgram.'),
    ).toBe(
      'Deepgram rejected the key (HTTP 401). Ask the admin for a valid key and store it again with provider_setKeys.',
    )
    expect(forAgent('Telnyx refused the request. Check the settings under Admin › Providers › Telnyx.')).toBe(
      'Telnyx refused the request. Check the settings with the admin, then store it again with provider_setKeys.',
    )
    expect(forAgent('Email is not set up: connect it in Admin, Providers, Email')).toBe(
      'Email is not set up: set up email with provider_setKeys',
    )
  })

  test('a refused input names the field, never the value', async () => {
    const { key } = await makeKey(ws.owner)
    const res = await call(key, 'provider_setKeys', { provider: 's3', values: { endpoint: `ftp://${SECRET}` } })
    expect(res.body.result.isError).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
  })

  test('with the passkey rule off (as in the app), email is stored and tested at once, no restart', async () => {
    const { key } = await makeKey(ws.owner)
    const res = await call(key, 'provider_setKeys', {
      provider: 'resend',
      values: { api_key: SECRET, from: 'desk@brightwater.test' },
    })
    expect(data(res)).toMatchObject({ ok: true, test: { ok: expect.any(Boolean) } })
    // Email applies at once: no restart to wait for.
    expect(data(res)).not.toHaveProperty('note')
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
    expect(await db.select().from(provider_settings).where(eq(provider_settings.provider, 'resend'))).toHaveLength(2)
  })

  test('setup_status lists the passkey first while the admin has none, with how to add it (LIN-189)', async () => {
    type Status = {
      steps: { id: string; group: string; state: string; how?: string[] }[]
      next_step: string | null
    }
    // Admins need no passkey on this install: no passkey step, the providers come first as before.
    const { key } = await makeKey(ws.owner)
    const off = data(await call(key, 'setup_status')) as Status
    expect(off.steps.map(s => s.id)).not.toContain('passkey')
    expect(off.steps[0]!.id).toBe('answering')

    process.env.ADMIN_SECOND_FACTOR = 'on'
    const before = data(await call(key, 'setup_status')) as Status
    expect(before.steps.map(s => s.id).slice(0, 5)).toEqual([
      'passkey',
      'answering',
      'telephony',
      'email',
      'call-audio',
    ])
    const step = before.steps[0]!
    // The admin's own part of the setup, before the server's.
    expect(before.steps.slice(0, 2).map(s => s.group)).toEqual(['you', 'server'])
    // Only the admin can add it, in the browser: the agent asks and goes on with the next step meanwhile.
    expect(step.state).toBe('admin_only')
    expect(before.next_step).toBe('answering')
    const how = step.how!.join(' ')
    expect(how).toMatch(/agents cannot add passkeys/)
    expect(how).toContain('/#account/security')
    expect(how).toMatch(/enrolment code is filled in already/)
    expect(how).toContain('user-passkeys.ts --enrol')
    expect(how).toMatch(/"Allow with passkey"/)
    // The next step keeps its own how-to as well.
    expect(before.steps.find(s => s.id === 'answering')?.how).toBeDefined()

    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    const after = data(await call(key, 'setup_status')) as Status
    expect(after.steps[0]).toMatchObject({ id: 'passkey', state: 'done' })
    expect(after.steps[0]!.how).toBeUndefined()
  })

  test('the install part is finished when its four provider steps are done, the passkey step aside', () => {
    const step = (id: string, state: string) =>
      ({ id, label: id, state }) as Parameters<typeof installPartDone>[0][number]
    const providers = ['answering', 'telephony', 'email', 'call-audio'].map(id => step(id, 'done'))
    const business = [step('workspace', 'todo'), step('test_call', 'admin_only')]
    // The passkey comes first and only the admin adds it: it never holds the install part back.
    expect(installPartDone([step('passkey', 'admin_only'), ...providers, ...business])).toBe(true)
    expect(installPartDone([...providers, ...business])).toBe(true)
    // With the passkey first, the old "first four" left call audio out.
    expect(
      installPartDone([step('passkey', 'done'), ...providers.slice(0, 3), step('call-audio', 'todo'), ...business]),
    ).toBe(false)
  })

  test('email and sign-in keep the passkey step-up: PASSKEY_NEEDED says what to ask, nothing is stored', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await signedIn(ws.owner, false)
    const { key, keyId } = await makeKey(ws.owner)
    // No passkey yet: the agent hears how the admin gets one, not "paste it in the app".
    const enrol = await call(key, 'provider_setKeys', { provider: 'resend', values: { api_key: SECRET } })
    expect(enrol.body.result.isError).toBe(true)
    expect(text(enrol)).toMatch(/^PASSKEY_NEEDED: .*enrol/)
    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    for (const [name, args] of [
      ['provider_setKeys', { provider: 'resend', values: { api_key: SECRET } }],
      ['provider_setKeys', { provider: 'google', values: { client_id: 'id', client_secret: SECRET } }],
      ['provider_clearKeys', { provider: 'smtp' }],
      ['provider_setActive', { category: 'email', provider: 'resend' }],
    ] as const) {
      const res = await call(key, name, args)
      expect(res.body.result.isError).toBe(true)
      expect(text(res)).toMatch(/^PASSKEY_NEEDED: email and sign-in .*"Allow with passkey"/)
      // It says how to wait for the Allow (setup_status, read-only) instead of retrying the refused tool blindly.
      expect(text(res)).toMatch(
        /do not call this tool again yet\. Call setup_status .* email_and_sign_in_allowed: true/,
      )
      // The link names this key: Allow on that page confirms it and nothing else.
      expect(text(res)).toContain(`/#setup-agent?allow=${keyId}`)
      expect(text(res)).not.toMatch(/paste (it|the key) in/i)
      expect(JSON.stringify(res.body)).not.toContain(SECRET)
    }
    expect(await db.select().from(provider_settings).where(eq(provider_settings.provider, 'resend'))).toEqual([])
    const state = (await request(ws.owner, 'GET', '/v1/admin/agent-setup')).body
    expect(state.key.emailAndSignIn).toBe(false)
    // Allow needs the passkey itself.
    const refused = await act(ws.owner, 'agentSetup.confirmPasskey', { keyId })
    expect(refused).toMatchObject({ status: 403, body: { code: 'PASSKEY_STEP_UP_REQUIRED' } })
  })

  test('Allow with a passkey (or a key made right after a passkey sign-in) lets the same link set email and sign-in', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    await signedIn(ws.owner, false)
    const { key, keyId } = await makeKey(ws.owner)
    await signedIn(ws.owner, true)
    const allowed = await act(ws.owner, 'agentSetup.confirmPasskey', { keyId })
    expect(allowed.status).toBe(200)
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
    // 12 hours from that passkey sign-in, never past the key's own end.
    expect(Date.parse(row!.passkey_confirmed_until!) - Date.now()).toBeGreaterThan(11.9 * 3_600_000)
    expect(Date.parse(row!.passkey_confirmed_until!) - Date.now()).toBeLessThanOrEqual(12 * 3_600_000)
    expect((await request(ws.owner, 'GET', '/v1/admin/agent-setup')).body.key.emailAndSignIn).toBe(true)
    const res = await call(key, 'provider_setKeys', {
      provider: 'resend',
      values: { api_key: SECRET, from: 'desk@brightwater.test' },
    })
    expect(data(res)).toMatchObject({ ok: true, test: { message: expect.any(String) } })
    expect(JSON.stringify(res.body)).not.toContain(SECRET)
    // A passkey confirmation that ran out stops it again.
    await db
      .update(agent_setup_keys)
      .set({ passkey_confirmed_until: new Date(Date.now() - 1000).toISOString() })
      .where(eq(agent_setup_keys.id, keyId))
    expect(text(await call(key, 'provider_clearKeys', { provider: 'resend' }))).toMatch(/^PASSKEY_NEEDED/)
    // A key made right after a new passkey sign-in carries it from the start (the earlier sign-in gave its one grant).
    await signedIn(ws.owner, true)
    const fresh = await makeKey(ws.owner)
    const [made] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, fresh.keyId))
    expect(made!.passkey_confirmed_until).not.toBeNull()
    expect(data(await call(fresh.key, 'provider_setActive', { category: 'email', provider: 'resend' }))).toMatchObject({
      ok: true,
    })
  })

  test('the passkey confirmation never reaches the workspace tools, and a setup key cannot allow itself', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    await signedIn(ws.owner, true)
    const { key, keyId } = await makeKey(ws.owner)
    const names: string[] = (await mcp(key, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name)
    expect(names).not.toContain('agentSetup_confirmPasskey')
    expect(names).not.toContain('agentSetup_withdrawPasskey')
    expect(names).not.toContain('agentSetup_createKey')
    expect((await call(key, 'agentSetup_confirmPasskey', { keyId })).body.error.message).toMatch(/not found/)
    // A confirmed key: a provider action gets the confirmation, a workspace action runs without it (and without
    // instance:admin), as the business's owner would.
    ran.length = 0
    expect(data(await call(key, 'provider_setActive', { category: 'email', provider: 'resend' }))).toMatchObject({
      ok: true,
    })
    expect(data(await call(key, 'workspace_rename', { name: 'Brightwater Plumbing & Heating' }))).toMatchObject({
      ok: true,
    })
    expect(ran.find(r => r.name === 'provider.setActive')).toMatchObject({
      setupKeyId: keyId,
      passkeyConfirmed: true,
      admin: true,
    })
    expect(ran.find(r => r.name === 'workspace.rename')).toEqual({
      name: 'workspace.rename',
      setupKeyId: keyId,
      passkeyConfirmed: false,
      admin: false,
    })
  })

  test("Allow confirms only the key the agent named, and only if it is the admin's own working key (M1)", async () => {
    process.env.ADMIN_SECOND_FACTOR = 'off'
    const theirs = await makeKey(fresh)
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    // Someone with only the mailbox (no passkey sign-in) makes a key; then a second one ends the first.
    await signedIn(ws.owner, false)
    const first = await makeKey(ws.owner)
    const second = await makeKey(ws.owner)
    const state = (await request(ws.owner, 'GET', '/v1/admin/agent-setup')).body
    expect(state.key).toMatchObject({ id: second.keyId, emailAndSignIn: false, emailAndSignInUntil: null })
    expect(Date.parse(state.key.createdAt)).toBeLessThanOrEqual(Date.now())
    // The admin then allows with a passkey sign-in: an id that is not theirs, ended or made up is refused.
    await signedIn(ws.owner, true)
    for (const keyId of [first.keyId, theirs.keyId, 'sk_madeup']) {
      const refused = await act(ws.owner, 'agentSetup.confirmPasskey', { keyId })
      expect(refused.status, keyId).toBe(409)
      expect(refused.body.error).toMatch(/not your working one/)
    }
    const confirmed = () =>
      db.select().from(agent_setup_keys).where(isNotNull(agent_setup_keys.passkey_confirmed_until))
    expect((await confirmed()).map(r => r.id)).not.toContain(second.keyId)
    expect((await confirmed()).map(r => r.id)).not.toContain(theirs.keyId)
    // An expired key is not the working one either.
    await db
      .update(agent_setup_keys)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(agent_setup_keys.id, second.keyId))
    expect((await act(ws.owner, 'agentSetup.confirmPasskey', { keyId: second.keyId })).status).toBe(409)
    // The key the agent's link names, still working: allowed.
    const third = await makeKey(ws.owner)
    await db.update(agent_setup_keys).set({ passkey_confirmed_until: null }).where(eq(agent_setup_keys.id, third.keyId))
    // Making it used that passkey sign-in's one grant: Allow comes with a new passkey prompt.
    await signedIn(ws.owner, true)
    const allowed = await act(ws.owner, 'agentSetup.confirmPasskey', { keyId: third.keyId })
    expect(allowed).toMatchObject({ status: 200, body: { data: { keyId: third.keyId } } })
    expect((await confirmed()).map(r => r.id)).toEqual(expect.arrayContaining([third.keyId]))
    expect((await confirmed()).map(r => r.id)).not.toContain(theirs.keyId)
  })

  test('Allow needs a passkey sign-in of the last minutes, works without email, and the agent sees it in setup_status', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    // Email is not set up on this install: the grant must not depend on it (no notification on the way).
    await clear('smtp', 'resend')
    await signedIn(ws.owner, false)
    const { key, keyId } = await makeKey(ws.owner)
    const status = async () => data(await call(key, 'setup_status')) as { email_and_sign_in_allowed: boolean }
    expect((await status()).email_and_sign_in_allowed).toBe(false)
    // The reported failure: a passkey sign-in from an hour ago used to let Allow through without a passkey prompt.
    // Now the passkey is asked for again (the page then shows the passkey prompt), and nothing is allowed.
    const hourAgo = new Date(Date.now() - 3_600_000)
    await db
      .update(session)
      .set({ createdAt: hourAgo, passkeyVerifiedAt: hourAgo })
      .where(eq(session.userId, ws.owner.userId))
    const stale = await act(ws.owner, 'agentSetup.confirmPasskey', { keyId })
    expect(stale).toMatchObject({ status: 403, body: { code: 'PASSKEY_STEP_UP_REQUIRED', stepUp: 'confirm' } })
    const [untouched] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
    expect(untouched!.passkey_confirmed_until).toBeNull()
    // Other step-ups still take that sign-in: only the Allow asks every time.
    const hourOldPasskey = { actorId: ws.owner.userId, passkeyConfirmed: true } as Actor
    const setKeys = { name: 'provider.setKeys', permission: 'instance:admin' } as const
    expect(await passkeyStepUpRefusal(setKeys, { provider: 'resend' }, hourOldPasskey)).toBeNull()
    // Right after the passkey sign-in (what "Allow with passkey" does first): allowed, and the agent can go on.
    await signedIn(ws.owner, true)
    const allowed = await act(ws.owner, 'agentSetup.confirmPasskey', { keyId })
    expect(allowed).toMatchObject({ status: 200, body: { data: { keyId } } })
    expect((await status()).email_and_sign_in_allowed).toBe(true)
    const res = await call(key, 'provider_setKeys', {
      provider: 'resend',
      values: { api_key: SECRET, from: 'desk@brightwater.test' },
    })
    expect(data(res)).toMatchObject({ ok: true })
  })

  test('one passkey sign-in gives one grant: Withdraw and Allow again needs a new passkey prompt (review L1)', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    await signedIn(ws.owner, false)
    const { keyId } = await makeKey(ws.owner)
    await signedIn(ws.owner, true)
    expect((await act(ws.owner, 'agentSetup.confirmPasskey', { keyId })).status).toBe(200)
    expect((await act(ws.owner, 'agentSetup.withdrawPasskey', {})).status).toBe(200)
    // Same passkey sign-in, still within the minutes: used up.
    expect(await act(ws.owner, 'agentSetup.confirmPasskey', { keyId })).toMatchObject({
      status: 403,
      body: { code: 'PASSKEY_STEP_UP_REQUIRED' },
    })
    // A key made now from the same sign-in starts without the grant too.
    const again = await makeKey(ws.owner)
    const [made] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, again.keyId))
    expect(made!.passkey_confirmed_until).toBeNull()
    // A new passkey prompt (a new sign-in) allows again.
    await signedIn(ws.owner, true)
    expect((await act(ws.owner, 'agentSetup.confirmPasskey', { keyId: again.keyId })).status).toBe(200)
  })

  test('a new link carries the grant only from an unused passkey sign-in of the last minutes (review M1)', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    // A passkey sign-in an hour ago (a session cookie someone could have taken): the new link has no grant.
    const hourAgo = new Date(Date.now() - 3_600_000)
    await db
      .update(session)
      .set({ createdAt: hourAgo, passkeyVerifiedAt: hourAgo, passkeyGrantUsedAt: null })
      .where(eq(session.userId, ws.owner.userId))
    const old = await makeKey(ws.owner)
    const [stale] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, old.keyId))
    expect(stale!.passkey_confirmed_until).toBeNull()
    expect(text(await call(old.key, 'provider_setActive', { category: 'email', provider: 'resend' }))).toMatch(
      /^PASSKEY_NEEDED/,
    )
    // Right after one: it has the grant, and that sign-in is used up.
    await signedIn(ws.owner, true)
    const fresh = await makeKey(ws.owner)
    const [made] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, fresh.keyId))
    expect(made!.passkey_confirmed_until).not.toBeNull()
    const [own] = await db.select().from(session).where(eq(session.userId, ws.owner.userId))
    expect(own!.passkeyGrantUsedAt).not.toBeNull()
  })

  test('the Allow dialog gets what the agent asked for, from where, without secrets (review L3)', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    await signedIn(ws.owner, false)
    const { key } = await makeKey(ws.owner)
    const res = await call(key, 'provider_setKeys', {
      provider: 'smtp',
      values: { url: `smtps://desk:${SECRET}@mail.brightwater.test:465`, from: 'desk@brightwater.test' },
    })
    expect(text(res)).toMatch(/^PASSKEY_NEEDED/)
    const state = (await request(ws.owner, 'GET', '/v1/admin/agent-setup')).body
    expect(state.key.request).toMatchObject({
      what: 'Set up email with SMTP (server mail.brightwater.test:465, from desk@brightwater.test)',
      at: expect.any(String),
    })
    expect(state.key.request.ip).toEqual(expect.any(String))
    expect(JSON.stringify(state)).not.toContain(SECRET)
    expect(JSON.stringify(state)).not.toContain('desk:')
    // Allowed: nothing waits any more.
    await signedIn(ws.owner, true)
    expect((await act(ws.owner, 'agentSetup.confirmPasskey', { keyId: state.key.id })).status).toBe(200)
    expect((await request(ws.owner, 'GET', '/v1/admin/agent-setup')).body.key.request).toBeNull()
  })

  test('setup_status { read_only: true } notes nothing, so waiting for Allow has no side effects (review I1)', async () => {
    const { key } = await makeKey(ws.owner)
    const before = await db.select({ id: commands.id }).from(commands)
    const status = data(await call(key, 'setup_status', { read_only: true }))
    expect(status).toHaveProperty('email_and_sign_in_allowed')
    expect(await db.select({ id: commands.id }).from(commands)).toHaveLength(before.length)
  })

  test("a passkey confirmation takes only the signed-in account's passkeys (review L4)", async () => {
    const own = passkeyRow(ws.owner.userId)
    const theirs = passkeyRow(fresh.userId)
    await db.insert(passkey).values([own, theirs])
    // The browser is offered only this account's passkeys.
    const options = await request(ws.owner, 'GET', '/api/auth/passkey/generate-authenticate-options')
    expect(options.status).toBe(200)
    expect(options.body.allowCredentials.map((c: { id: string }) => c.id)).toEqual([own.credentialID])
    // And the server refuses another account's passkey for a signed-in browser; without a session any passkey signs
    // its own account in (the sign-in page).
    await expect(refuseOtherAccountsPasskey(ws.owner.userId, theirs.credentialID)).rejects.toMatchObject({
      body: { code: 'PASSKEY_OTHER_ACCOUNT' },
    })
    await expect(refuseOtherAccountsPasskey(ws.owner.userId, own.credentialID)).resolves.toBeUndefined()
    await expect(refuseOtherAccountsPasskey(null, theirs.credentialID)).resolves.toBeUndefined()
    await db.delete(passkey).where(eq(passkey.userId, fresh.userId))
  })

  test('Withdraw ends the passkey confirmation without a passkey; the page shows until when it lasts (L1)', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    await signedIn(ws.owner, true)
    const { key } = await makeKey(ws.owner)
    const until = (await request(ws.owner, 'GET', '/v1/admin/agent-setup')).body.key.emailAndSignInUntil
    expect(Date.parse(until)).toBeGreaterThan(Date.now() + 11 * 3_600_000)
    await signedIn(ws.owner, false)
    expect((await act(ws.owner, 'agentSetup.withdrawPasskey', {})).status).toBe(200)
    expect((await request(ws.owner, 'GET', '/v1/admin/agent-setup')).body.key).toMatchObject({
      emailAndSignIn: false,
      emailAndSignInUntil: null,
    })
    expect(text(await call(key, 'provider_setActive', { category: 'email', provider: 'resend' }))).toMatch(
      /^PASSKEY_NEEDED/,
    )
    // A setup key cannot withdraw (or do anything with) setup links.
    expect((await call(key, 'agentSetup_withdrawPasskey')).body.error.message).toMatch(/not found/)
  })

  test('recording storage on this server or a private network needs the Allow; link-local never (M2)', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await db.insert(passkey).values(passkeyRow(ws.owner.userId))
    await signedIn(ws.owner, false)
    const { key, keyId } = await makeKey(ws.owner)
    const stored = async () =>
      (await db.select().from(provider_settings).where(eq(provider_settings.provider, 's3'))).map(r => r.field)
    // `localhost` is a name that resolves to a loopback address: checked after DNS, like the written ones.
    for (const endpoint of [
      'http://127.0.0.1:9000',
      'http://localhost:9000',
      'http://10.0.0.5:9000',
      'http://[::1]:9000',
    ]) {
      const res = await call(key, 'provider_setKeys', { provider: 's3', values: { endpoint, bucket: 'calls' } })
      expect(res.body.result.isError, endpoint).toBe(true)
      expect(text(res)).toMatch(/^PASSKEY_NEEDED: a storage endpoint on this server or a private network/)
      expect(text(res)).toContain(`/#setup-agent?allow=${keyId}`)
    }
    for (const endpoint of ['http://169.254.169.254', 'http://[fe80::1]:9000']) {
      const res = await call(key, 'provider_setKeys', { provider: 's3', values: { endpoint } })
      expect(res.body.result.isError, endpoint).toBe(true)
      expect(text(res)).toMatch(/link-local or cloud metadata/)
    }
    expect(await stored()).toEqual([])
    // A public address is stored and tested at once (the test request is the faked fetch).
    const fetched = vi.mocked(globalThis.fetch)
    const pub = await call(key, 'provider_setKeys', {
      provider: 's3',
      values: {
        endpoint: 'https://93.184.215.14',
        bucket: 'calls',
        access_key_id: 'AKIAEXAMPLE',
        secret_access_key: SECRET,
      },
    })
    expect(data(pub)).toMatchObject({ ok: true, test: { ok: false } })
    expect(fetched).toHaveBeenCalled()
    expect(await stored()).toContain('endpoint')

    // The admin puts storage on the Docker network themselves: fine for them, but the unconfirmed setup key
    // cannot test it (no request goes there, and the provider is not marked as failing).
    expect(
      (await act(ws.owner, 'provider.setKeys', { provider: 's3', values: { endpoint: 'http://127.0.0.1:9000' } }))
        .status,
    ).toBe(200)
    fetched.mockClear()
    const tested = await call(key, 'provider_test', { provider: 's3' })
    expect(tested.body.result.isError).toBe(true)
    expect(text(tested)).toContain(PRIVATE_ENDPOINT)
    expect(fetched).not.toHaveBeenCalled()
    // Link-local is refused for the admin too, in the app.
    const app = await act(ws.owner, 'provider.setKeys', {
      provider: 's3',
      values: { endpoint: 'http://169.254.169.254' },
    })
    expect(app.status).toBe(409)
    expect(app.body.error).toMatch(/link-local/)

    // After the admin's Allow, the same link may use a private endpoint, but still no link-local one.
    await signedIn(ws.owner, true)
    expect((await act(ws.owner, 'agentSetup.confirmPasskey', { keyId })).status).toBe(200)
    expect(
      data(await call(key, 'provider_setKeys', { provider: 's3', values: { endpoint: 'http://localhost:9000' } })),
    ).toMatchObject({ ok: true })
    expect(
      text(await call(key, 'provider_setKeys', { provider: 's3', values: { endpoint: 'http://169.254.169.254' } })),
    ).toMatch(/link-local/)
  })

  test("resetting an admin's passkeys ends their setup links, a confirmed one too (M3)", async () => {
    process.env.ADMIN_SECOND_FACTOR = 'off'
    const victim = await signUp()
    await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, victim.userId))
    const { key, keyId } = await makeKey(victim)
    await db
      .update(agent_setup_keys)
      .set({ passkey_confirmed_until: new Date(Date.now() + 3_600_000).toISOString() })
      .where(eq(agent_setup_keys.id, keyId))
    expect((await mcp(key, 'tools/list')).status).toBe(200)
    const mails: string[] = []
    const send = vi.spyOn(emailSender, 'send').mockImplementation(async e => void mails.push(e.text))
    expect((await act(fresh, 'user.resetPasskeys', { userId: victim.userId })).status).toBe(200)
    const [row] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, keyId))
    expect(row!.revoked_at).not.toBeNull()
    expect((await mcp(key, 'tools/list')).status).toBe(401)
    expect(mails.some(t => /ended their sessions and AI agent setup links/.test(t))).toBe(true)
    send.mockRestore()
    // Disabling an admin ends them too.
    await db.update(user).set({ disabledAt: null }).where(eq(user.id, victim.userId))
    const other = await signUp()
    await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, other.userId))
    const again = await makeKey(other)
    expect((await act(fresh, 'user.disable', { userId: other.userId })).status).toBe(200)
    const [ended] = await db.select().from(agent_setup_keys).where(eq(agent_setup_keys.id, again.keyId))
    expect(ended!.revoked_at).not.toBeNull()
  })

  test('the alert for an email or sign-in change says it came through the agent and names the link (L2)', async () => {
    // Email alerts go through the sender before the change (here the API log, EMAIL_TO_LOG) and the new one (Resend,
    // nodemailer's transport replaced): both are collected.
    const mails: { subject: string; text: string }[] = []
    const log = console.log
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      const line = String(args[0])
      const logged = line.match(/\nSubject: (.*)\n\n([\s\S]*)\n$/)
      if (line.includes('[email, not sent') && logged) mails.push({ subject: logged[1]!, text: logged[2]! })
      else log(...args)
    })
    vi.spyOn(nodemailer, 'createTransport').mockImplementation((() => ({
      sendMail: async (mail: { subject: string; text: string }) => void mails.push(mail),
      verify: async () => true,
    })) as never)
    const made = await makeKey(ws.owner)
    expect(
      data(
        await call(made.key, 'provider_setKeys', {
          provider: 'resend',
          values: { api_key: SECRET, from: 'desk@brightwater.test' },
        }),
      ),
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(mails.some(m => /Resend settings changed by an AI agent/.test(m.subject))).toBe(true))
    const alert = mails.find(m => /Resend settings changed/.test(m.subject))!
    expect(alert.text).toContain(`through the AI agent setup link ${made.key.slice(0, 12)}…, made `)
    expect(alert.text).not.toContain(made.key)
    expect(alert.text).not.toContain(SECRET)
    // Done in the app, it says so as before.
    mails.length = 0
    await act(ws.owner, 'provider.clearKeys', { provider: 'resend' })
    await vi.waitFor(() => expect(mails.some(m => /Resend settings removed$/.test(m.subject))).toBe(true))
    expect(mails.find(m => /Resend settings removed/.test(m.subject))!.text).toMatch(/\(Admin, Providers\)/)
    vi.restoreAllMocks()
  })

  test('the test email round trip and the install progress are agent tools', async () => {
    const { key } = await makeKey(ws.owner)
    const names: string[] = (await mcp(key, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['provider_tryOut', 'provider_confirmEmail', 'install_setProgress']))
    expect(data(await call(key, 'install_setProgress', { skip: 'call-audio' }))).toMatchObject({ ok: true })
    const wrong = await call(key, 'provider_confirmEmail', { code: '123456' })
    expect(wrong.body.result.isError).toBe(true)
    expect(text(wrong)).toMatch(/No test code is pending/)
  })

  test('the rate limit of the setup key covers saving keys too', async () => {
    const { key } = await makeKey(ws.owner)
    let status = 200
    for (let i = 0; i < 125 && status === 200; i++) status = (await mcp(key, 'tools/list')).status
    expect(status).toBe(429)
    const res = await call(key, 'provider_setKeys', { provider: 'google_places', values: { api_key: SECRET } })
    expect(res.status).toBe(429)
    expect(await db.select().from(provider_settings).where(eq(provider_settings.provider, 'google_places'))).toEqual([])
  })

  test('the agent is never sent to the app to paste a key: instructions, setup_status and optional groups', async () => {
    expect(SETUP_MCP_INSTRUCTIONS).not.toMatch(/paste those keys in the app|never changed through these tools/)
    expect(SETUP_MCP_INSTRUCTIONS).toMatch(/Resend API key/)
    expect(SETUP_MCP_INSTRUCTIONS).toMatch(/PASSKEY_NEEDED/)
    const { key } = await makeKey(ws.owner)
    const init = await mcp(key, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.body.result.instructions).toBe(SETUP_MCP_INSTRUCTIONS)
    const status = data(await call(key, 'setup_status')) as {
      steps: { id: string; how?: string[] }[]
      optional: { id: string; how?: string[] }[]
      app_links: Record<string, string>
    }
    expect(status.optional.map(o => o.id)).toEqual(['sign-in', 'calendar', 'recording', 'business'])
    const all = JSON.stringify(status)
    expect(all).not.toMatch(/paste (it|the key|them) in the app|cannot change email/i)
    expect(status.app_links.agent_setup).toMatch(/#setup-agent$/)
    const listed = data(await call(key, 'providers_list', { category: 'sign_in' })) as {
      providers: { provider: string; redirect_uris?: string[] }[]
    }
    expect(listed.providers.find(p => p.provider === 'google')?.redirect_uris?.[0]).toMatch(
      /\/api\/auth\/callback\/google$/,
    )
  })
})
