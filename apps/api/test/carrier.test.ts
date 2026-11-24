// A workspace's own carrier account: who may set it, that its credentials never come back or reach
// the command log, that "Test connection" only reads, and that one workspace's credentials are never
// another's. HTTP through the app; carrier HTTP is a stubbed fetch.
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { REDACTED } from '@linedesk/actions'
import { commands, provider_settings } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { CARRIER_TESTS_PER_10_MIN, ownCarrierProvider } from '../src/workspace-carrier.ts'
import { act, addMember, agent, createWorkspace, request, type User, type Workspace } from './helpers.ts'

const ACCOUNT_SID = `AC${'a1'.repeat(16)}`
const API_KEY_SID = `SK${'b2'.repeat(16)}`
const API_KEY_SECRET = 'twilio-api-key-secret-0123456789'
const AUTH_TOKEN = 'twilio-auth-token-abcdef0123456789'
const TELNYX_KEY = 'KEY0123456789telnyx-secret-key'

let a: Workspace
let b: Workspace
let admin: User
let member: User

beforeAll(async () => {
  a = await createWorkspace('Brightwater Plumbing & Heating')
  b = await createWorkspace('Other Business')
  admin = await addMember(a.id, 'admin')
  member = await addMember(a.id, 'member')
})

afterEach(() => vi.unstubAllGlobals())

/** Acts in a workspace (the owner of `a` and `b` are different users, but say which one anyway). */
const inWs = (who: User, ws: Workspace) => ({ headers: { ...who.headers, 'x-workspace-id': ws.id } })

type Seen = { url: string; method: string; authorization: string }
/** A carrier API that lists one number and records every request. */
function stubCarrier(status = 200, body: unknown = undefined) {
  const seen: Seen[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.push({ url: String(input), method: init?.method ?? 'GET', authorization: headers.authorization ?? '' })
    if (status !== 200) return Response.json(body ?? {}, { status })
    if (String(input).includes('telnyx'))
      return Response.json({ data: [{ id: 'num_1', phone_number: '+15035550100' }] })
    return Response.json({ incoming_phone_numbers: [{ sid: 'PN1', phone_number: '+15035550100' }] })
  })
  return seen
}

describe('carrier.set / carrier.get', () => {
  test('a workspace uses the default carrier until an owner or admin picks its own', async () => {
    const res = await act(inWs(a.owner, a), 'carrier.get', {})
    expect(res.body.data).toEqual({ carrier: 'default', canStore: true, sipReady: false, fields: [], updatedAt: null })
  })

  test('members and the agent may neither read nor set it', async () => {
    for (const name of ['carrier.get', 'carrier.set', 'carrier.test']) {
      const input = name === 'carrier.set' ? { carrier: 'telnyx', values: { api_key: TELNYX_KEY } } : {}
      expect((await act(inWs(member, a), name, input)).status).toBe(403)
      expect((await act(agent(a.id), name, input)).status).toBe(403)
    }
    expect(await ownCarrierProvider(db, a.id)).toBeNull()
  })

  test('the secrets are stored encrypted, never returned and redacted in the command log', async () => {
    const key = crypto.randomUUID()
    const set = await act(
      inWs(admin, a),
      'carrier.set',
      {
        carrier: 'twilio',
        values: { account_sid: ACCOUNT_SID, api_key_sid: API_KEY_SID, api_key_secret: API_KEY_SECRET },
      },
      key,
    )
    expect(set.status).toBe(200)
    expect(set.body.data).toMatchObject({ carrier: 'twilio', canStore: true })
    expect(set.body.data.fields).toEqual([
      { field: 'account_sid', label: 'Account SID', secret: false, set: true, value: ACCOUNT_SID, last4: null },
      { field: 'api_key_sid', label: 'API key SID', secret: false, set: true, value: API_KEY_SID, last4: null },
      { field: 'api_key_secret', label: 'API key secret', secret: true, set: true, value: null, last4: '6789' },
      { field: 'auth_token', label: 'Auth token', secret: true, set: false, value: null, last4: null },
    ])
    const [command] = await db.select().from(commands).where(eq(commands.id, key))
    expect(command?.input).toEqual({
      carrier: 'twilio',
      values: { account_sid: REDACTED, api_key_sid: REDACTED, api_key_secret: REDACTED },
    })
    const stored = await db.select().from(provider_settings).where(eq(provider_settings.workspace_id, a.id))
    expect(stored.map(r => r.field).sort()).toEqual(['account_sid', 'api_key_secret', 'api_key_sid'])
    const everything = JSON.stringify([
      set.body,
      stored,
      command,
      (await act(inWs(a.owner, a), 'carrier.get', {})).body,
      (await request(inWs(a.owner, a), 'GET', '/v1/me')).body,
    ])
    expect(everything).not.toContain(API_KEY_SECRET)
    expect(everything).not.toContain(API_KEY_SECRET.slice(0, 12))
  })

  test('credentials are replaced as a whole; switching carrier drops the old ones; default drops all', async () => {
    await act(inWs(a.owner, a), 'carrier.set', {
      carrier: 'twilio',
      values: { account_sid: ACCOUNT_SID, auth_token: AUTH_TOKEN },
    })
    const twilio = await db.select().from(provider_settings).where(eq(provider_settings.workspace_id, a.id))
    expect(twilio.map(r => r.field).sort()).toEqual(['account_sid', 'auth_token'])

    await act(inWs(a.owner, a), 'carrier.set', { carrier: 'telnyx', values: { api_key: TELNYX_KEY } })
    const telnyx = await db.select().from(provider_settings).where(eq(provider_settings.workspace_id, a.id))
    expect(telnyx.map(r => `${r.provider}.${r.field}`)).toEqual(['telnyx.api_key'])

    const reset = await act(inWs(a.owner, a), 'carrier.set', { carrier: 'default' })
    expect(reset.body.data).toMatchObject({ carrier: 'default', fields: [] })
    expect(await db.select().from(provider_settings).where(eq(provider_settings.workspace_id, a.id))).toEqual([])
  })

  test('invalid credentials are refused without echoing them', async () => {
    const cases = [
      { carrier: 'twilio', values: { account_sid: 'not-a-sid', auth_token: AUTH_TOKEN } },
      { carrier: 'twilio', values: { account_sid: ACCOUNT_SID } },
      {
        carrier: 'twilio',
        values: {
          account_sid: ACCOUNT_SID,
          auth_token: AUTH_TOKEN,
          api_key_sid: API_KEY_SID,
          api_key_secret: API_KEY_SECRET,
        },
      },
      { carrier: 'twilio', values: { account_sid: ACCOUNT_SID, api_key_sid: API_KEY_SID } },
      { carrier: 'telnyx', values: { api_key: TELNYX_KEY, extra: 'x' } },
      { carrier: 'telnyx' },
      { carrier: 'plivo', values: {} },
    ]
    for (const input of cases) {
      const res = await act(inWs(a.owner, a), 'carrier.set', input)
      expect(res.status, JSON.stringify(input)).toBe(422)
      expect(JSON.stringify(res.body)).not.toContain(AUTH_TOKEN)
      expect(JSON.stringify(res.body)).not.toContain(API_KEY_SECRET)
    }
  })
})

describe('carrier.test', () => {
  test('lists the numbers of the account with the workspace credentials: one GET, nothing else', async () => {
    await act(inWs(a.owner, a), 'carrier.set', {
      carrier: 'twilio',
      values: { account_sid: ACCOUNT_SID, api_key_sid: API_KEY_SID, api_key_secret: API_KEY_SECRET },
    })
    const seen = stubCarrier()
    const res = await act(inWs(a.owner, a), 'carrier.test', {})
    expect(res.body.data).toEqual({ ok: true, message: 'Connected. 1 number in the account.' })
    expect(seen).toEqual([
      {
        url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/IncomingPhoneNumbers.json?PageSize=20`,
        method: 'GET',
        authorization: `Basic ${Buffer.from(`${API_KEY_SID}:${API_KEY_SECRET}`).toString('base64')}`,
      },
    ])
  })

  test('a refusal says so without the carrier text; other errors are scrubbed of every credential', async () => {
    await act(inWs(a.owner, a), 'carrier.set', { carrier: 'telnyx', values: { api_key: TELNYX_KEY } })
    stubCarrier(401, { errors: [{ detail: `key ${TELNYX_KEY} is wrong` }] })
    expect((await act(inWs(a.owner, a), 'carrier.test', {})).body.data).toEqual({
      ok: false,
      message: 'Telnyx rejected the credentials (HTTP 401)',
    })
    stubCarrier(500, { errors: [{ detail: `boom ${TELNYX_KEY}` }] })
    const failed = (await act(inWs(a.owner, a), 'carrier.test', {})).body.data
    expect(failed.ok).toBe(false)
    expect(failed.message).not.toContain(TELNYX_KEY)
    expect(failed.message).toContain('[redacted]')
  })

  test('the default carrier has nothing to test', async () => {
    await act(inWs(b.owner, b), 'carrier.set', { carrier: 'default' })
    expect((await act(inWs(b.owner, b), 'carrier.test', {})).body.data).toEqual({
      ok: false,
      message: 'The workspace uses the default carrier.',
    })
  })
})

describe('isolation between workspaces', () => {
  test("workspace B never sees or uses A's credentials", async () => {
    await act(inWs(a.owner, a), 'carrier.set', { carrier: 'telnyx', values: { api_key: TELNYX_KEY } })
    // A's owner cannot act in B: membership is checked before the action runs.
    expect((await act(inWs(a.owner, b), 'carrier.get', {})).status).toBe(403)
    expect((await act(inWs(b.owner, b), 'carrier.get', {})).body.data.carrier).toBe('default')
    expect(await ownCarrierProvider(db, b.id)).toBeNull()

    const seen = stubCarrier()
    await act(inWs(b.owner, b), 'carrier.set', {
      carrier: 'telnyx',
      values: { api_key: 'KEY-of-workspace-b-0123456789' },
    })
    await act(inWs(b.owner, b), 'carrier.test', {})
    expect(seen.map(s => s.authorization)).toEqual(['Bearer KEY-of-workspace-b-0123456789'])
  })

  test("a ciphertext copied into another workspace's row does not decrypt there", async () => {
    await act(inWs(a.owner, a), 'carrier.set', { carrier: 'telnyx', values: { api_key: TELNYX_KEY } })
    await act(inWs(b.owner, b), 'carrier.set', {
      carrier: 'telnyx',
      values: { api_key: 'KEY-of-workspace-b-0123456789' },
    })
    const [fromA] = await db.select().from(provider_settings).where(eq(provider_settings.workspace_id, a.id))
    await db
      .update(provider_settings)
      .set({ value_encrypted: fromA!.value_encrypted })
      .where(and(eq(provider_settings.workspace_id, b.id), eq(provider_settings.field, 'api_key')))
    const seen = stubCarrier()
    const res = await act(inWs(b.owner, b), 'carrier.test', {})
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('The saved carrier credentials cannot be read on this server. Enter them again.')
    expect(seen).toEqual([])
    await expect(ownCarrierProvider(db, b.id)).rejects.toThrow('cannot be read')
  })
})

describe('carrier.test limits', () => {
  test('carrier.test is rate limited per workspace', async () => {
    const ws = await createWorkspace('Tester Business')
    await act(inWs(ws.owner, ws), 'carrier.set', { carrier: 'telnyx', values: { api_key: TELNYX_KEY } })
    const seen = stubCarrier()
    for (let i = 0; i < CARRIER_TESTS_PER_10_MIN; i++) {
      expect((await act(inWs(ws.owner, ws), 'carrier.test', {})).body.data.ok).toBe(true)
    }
    const refused = await act(inWs(ws.owner, ws), 'carrier.test', {})
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe('Too many connection tests. Try again in a few minutes.')
    expect(seen).toHaveLength(CARRIER_TESTS_PER_10_MIN)
  })
})

describe("webhooks verify with the workspace's own key", () => {
  test('Telnyx: the public key saved with the workspace, not another workspace or the install', async () => {
    const own = generateKeyPairSync('ed25519')
    const other = generateKeyPairSync('ed25519')
    const raw = (k: typeof own) => k.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
    await act(inWs(a.owner, a), 'carrier.set', {
      carrier: 'telnyx',
      values: { api_key: TELNYX_KEY, public_key: raw(own) },
    })
    await act(inWs(b.owner, b), 'carrier.set', {
      carrier: 'telnyx',
      values: { api_key: 'KEY-of-workspace-b-0123456789', public_key: raw(other) },
    })
    const rawBody = JSON.stringify({ data: { id: 'ev1', event_type: 'call.hangup', payload: {} } })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signedBy = (k: typeof own) => ({
      rawBody,
      headers: {
        'telnyx-timestamp': timestamp,
        'telnyx-signature-ed25519': sign(null, Buffer.from(`${timestamp}|${rawBody}`), k.privateKey).toString('base64'),
      },
    })
    const providerA = (await ownCarrierProvider(db, a.id))!
    expect(providerA.parseWebhook(signedBy(own)).status).toBe('hangup')
    expect(() => providerA.parseWebhook(signedBy(other))).toThrow('signature is not valid')
    expect(() => providerA.parseWebhook({ ...signedBy(own), headers: {} })).toThrow('no signature headers')
    const providerB = (await ownCarrierProvider(db, b.id))!
    expect(() => providerB.parseWebhook(signedBy(own))).toThrow('signature is not valid')
  })

  test("Twilio: the workspace's auth token; with an API key webhooks are refused", async () => {
    await act(inWs(a.owner, a), 'carrier.set', {
      carrier: 'twilio',
      values: { account_sid: ACCOUNT_SID, auth_token: AUTH_TOKEN },
    })
    const url = 'https://linedesk.test/hook'
    const form = { CallSid: 'CA1', CallStatus: 'completed' }
    const signature = (token: string) =>
      createHmac('sha1', token)
        .update(
          Object.entries(form)
            .sort()
            .reduce((t, [k, v]) => t + k + v, url),
        )
        .digest('base64')
    const request = (token: string) => ({
      url,
      rawBody: new URLSearchParams(form).toString(),
      headers: { 'x-twilio-signature': signature(token) },
    })
    const providerA = (await ownCarrierProvider(db, a.id))!
    expect(providerA.parseWebhook(request(AUTH_TOKEN)).status).toBe('hangup')
    expect(() => providerA.parseWebhook(request('another-token'))).toThrow('signature is not valid')
    await act(inWs(a.owner, a), 'carrier.set', {
      carrier: 'twilio',
      values: { account_sid: ACCOUNT_SID, api_key_sid: API_KEY_SID, api_key_secret: API_KEY_SECRET },
    })
    await expect(ownCarrierProvider(db, a.id).then(p => p!.parseWebhook(request(AUTH_TOKEN)))).rejects.toThrow(
      'auth token',
    )
  })
})
