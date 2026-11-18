// A white-label partner's own provider keys (docs/white-label.md, slice S7): who may read and change them, that a key
// never comes back, is bound to its partner and stage, is rotated, and is read by the voice agent only for a call that
// runs on it; when a call is forecast on own keys, and when its report confirms it. Makes an instance admin: an
// instance-wide file (vitest.config.ts).
import { calls, commands, partner_providers, user, workspace_settings } from '@linedesk/db'
import { and, desc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { partnerSetupActor } from '../src/agent-setup.ts'
import { db } from '../src/db.ts'
import { type Email, emailSender } from '../src/email.ts'
import {
  maskFailure,
  partnerKeySlot,
  partnerKeysForCall,
  reportConfirmsOwnKeys,
  workspaceOwnKeys,
} from '../src/partner-keys.ts'
import { reencryptSecrets } from '../src/rotate-secrets-key.ts'
import { runAction } from '../src/run-action.ts'
import { decryptSecret, parseSecretsKey } from '../src/secrets.ts'
import { act, agent, asServerAdmin, request, signUp, type User } from './helpers.ts'

const sent: Email[] = []
Object.assign(emailSender, { send: async (email: Email) => void sent.push(email) })

const newEmail = (who = 'partner') => `${who}_${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const verify = (u: User) => db.update(user).set({ emailVerified: true }).where(eq(user.id, u.userId))
const tokenFor = (to: string) =>
  sent
    .filter(e => e.to === to)
    .map(e => e.text.match(/#partner-invite=([\w-]+)/)?.[1])
    .findLast(Boolean)

const KEY = 'dg_test_0123456789abcdefSECRET'

let admin: User
async function makePartner(name: string) {
  const ownerEmail = newEmail('owner')
  const created = await asServerAdmin(admin, () => act(admin, 'partner.create', { name, ownerEmail }))
  expect(created).toMatchObject({ status: 200 })
  const id: string = created.body.data.partner.id
  expect((await asServerAdmin(admin, () => act(admin, 'partner.approve', { partnerId: id }))).status).toBe(200)
  const owner = await signUp(ownerEmail)
  await verify(owner)
  expect(await act(owner, 'partnerInvitation.accept', { token: tokenFor(ownerEmail) })).toMatchObject({ status: 200 })
  return { id, owner }
}
type Partner = Awaited<ReturnType<typeof makePartner>>

async function addPartnerAdmin(p: Partner) {
  const email = newEmail('padmin')
  expect(await act(p.owner, 'partnerMember.invite', { partnerId: p.id, email })).toMatchObject({ status: 200 })
  const who = await signUp(email)
  await verify(who)
  expect(await act(who, 'partnerInvitation.accept', { token: tokenFor(email) })).toMatchObject({ status: 200 })
  return who
}

async function createClient(p: Partner, name: string) {
  const res = await act(p.owner, 'workspace.createForClient', { partnerId: p.id, name })
  expect(res).toMatchObject({ status: 200 })
  return res.body.data.workspace.id as string
}

/** Deepgram's free check answers with a project and no balance: the key works. Anything else: refused. */
function deepgramAnswers(works: boolean) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!works) return new Response(JSON.stringify({ err_msg: `Invalid credentials ${KEY}` }), { status: 401 })
    if (url.endsWith('/v1/projects')) return Response.json({ projects: [{ project_id: 'p1' }] })
    return Response.json({ balances: [] })
  })
}

const stage = (p: Partner, s: string) =>
  db
    .select()
    .from(partner_providers)
    .where(and(eq(partner_providers.partner_id, p.id), eq(partner_providers.category, s as 'stt')))
    .then(rows => rows[0])

/** A stage's key stored as it would be after a passing test (for the call tests: no provider is asked). */
async function storeWorking(p: Partner, s: 'stt' | 'llm' | 'tts' | 'realtime', provider: string) {
  expect(
    await act(p.owner, 'partnerKeys.set', { partnerId: p.id, stage: s, provider, apiKey: `${s}_${KEY}` }),
  ).toMatchObject({ status: 200 })
  await db
    .update(partner_providers)
    .set({ status: 'ok' })
    .where(and(eq(partner_providers.partner_id, p.id), eq(partner_providers.category, s)))
}

let a: Partner
let b: Partner
let clientA: string
let clientB: string
let adminA: User

beforeAll(async () => {
  admin = await signUp()
  await verify(admin)
  a = await makePartner('Cascade IT Partners')
  b = await makePartner('Rival Agency')
  clientA = await createClient(a, 'Brightwater Plumbing')
  clientB = await createClient(b, 'Rival Client')
  adminA = await addPartnerAdmin(a)
})

afterEach(() => vi.unstubAllGlobals())
afterAll(() => vi.unstubAllGlobals())

describe('who may read and change the keys', () => {
  test('the owner connects a key: it is stored encrypted, comes back as the last four only, and is tested', async () => {
    const res = await act(a.owner, 'partnerKeys.set', {
      partnerId: a.id,
      stage: 'stt',
      provider: 'deepgram',
      apiKey: KEY,
    })
    expect(res).toMatchObject({ status: 200, body: { ok: true } })
    expect(JSON.stringify(res.body)).not.toContain(KEY)
    expect(res.body.data.stages[0]).toMatchObject({
      stage: 'stt',
      provider: 'deepgram',
      last4: 'CRET',
      status: 'untested',
    })
    const row = await stage(a, 'stt')
    expect(row!.key_encrypted).not.toContain(KEY)
    expect(decryptSecret(row!.key_encrypted, partnerKeySlot(a.id, 'stt', 'deepgram'))).toBe(KEY)
    // The command log never holds the key.
    const [logged] = await db
      .select()
      .from(commands)
      .where(eq(commands.action, 'partnerKeys.set'))
      .orderBy(desc(commands.created_at))
      .limit(1)
    expect(JSON.stringify(logged)).not.toContain(KEY)

    deepgramAnswers(true)
    const tested = await act(a.owner, 'partnerKeys.test', { partnerId: a.id, stage: 'stt' })
    expect(tested).toMatchObject({ status: 200, body: { data: { result: { ok: true } } } })
    expect((await stage(a, 'stt'))!.status).toBe('ok')

    deepgramAnswers(false)
    const failed = await act(a.owner, 'partnerKeys.test', { partnerId: a.id, stage: 'stt' })
    expect(failed.body.data.result.ok).toBe(false)
    // The provider's error echoed the key: it is masked before it is stored or shown.
    expect(JSON.stringify(failed.body)).not.toContain(KEY)
    const after = await stage(a, 'stt')
    expect(after!.status).toBe('failing')
    expect(after!.failure).not.toContain(KEY)
  })

  test('the team reads, never a key; only the owner writes', async () => {
    const read = await act(adminA, 'partnerKeys.get', { partnerId: a.id })
    expect(read).toMatchObject({ status: 200, body: { data: { canEdit: false } } })
    expect(JSON.stringify(read.body)).not.toContain(KEY)
    for (const [name, input] of [
      ['partnerKeys.set', { partnerId: a.id, stage: 'llm', provider: 'openai', apiKey: KEY }],
      ['partnerKeys.clear', { partnerId: a.id, stage: 'stt' }],
      ['partnerKeys.test', { partnerId: a.id, stage: 'stt' }],
      ['partner.setClientOwnKeys', { partnerId: a.id, workspaceId: clientA, on: true }],
    ] as const)
      expect((await act(adminA, name, input)).status, name).toBe(403)
  })

  test('another partner, a client, a stranger and a server admin get nothing', async () => {
    const stranger = await signUp()
    // A stranger in no workspace has no session to act with (401); anyone else is refused (403).
    for (const who of [b.owner, stranger])
      for (const [name, input] of [
        ['partnerKeys.get', { partnerId: a.id }],
        ['partnerKeys.set', { partnerId: a.id, stage: 'llm', provider: 'openai', apiKey: KEY }],
        ['partnerKeys.clear', { partnerId: a.id, stage: 'stt' }],
        ['partner.setClientOwnKeys', { partnerId: a.id, workspaceId: clientA, on: true }],
      ] as const)
        expect([401, 403], name).toContain((await act(who, name, input)).status)
    // A server admin manages the kill switch, never reads the keys.
    expect((await asServerAdmin(admin, () => act(admin, 'partnerKeys.get', { partnerId: a.id }))).status).toBe(403)
  })

  test("the partner's agent setup link cannot touch the keys", async () => {
    const actor = (await partnerSetupActor(a.owner.userId, 'test', a.id))!
    for (const [name, input] of [
      ['partnerKeys.get', { partnerId: a.id }],
      ['partnerKeys.set', { partnerId: a.id, stage: 'llm', provider: 'openai', apiKey: KEY }],
      ['partnerKeys.clear', { partnerId: a.id, stage: 'stt' }],
      ['partnerKeys.test', { partnerId: a.id, stage: 'stt' }],
      ['partner.setClientOwnKeys', { partnerId: a.id, workspaceId: clientA, on: true }],
    ] as const)
      expect((await runAction(name, input, actor)).status, name).toBe(403)
  })

  test("a provider of another stage is refused; the switch takes only the partner's own clients", async () => {
    expect(
      (await act(a.owner, 'partnerKeys.set', { partnerId: a.id, stage: 'stt', provider: 'openai', apiKey: KEY }))
        .status,
    ).toBe(422)
    expect(
      await act(a.owner, 'partner.setClientOwnKeys', { partnerId: a.id, workspaceId: clientB, on: true }),
    ).toMatchObject({ status: 409, body: { code: 'client_not_found' } })
    expect(
      await act(a.owner, 'partner.setClientOwnKeys', { partnerId: a.id, workspaceId: clientA, on: true }),
    ).toMatchObject({
      status: 200,
    })
    const [settings] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, clientA))
    expect(settings!.partner_keys).toBe(true)
  })

  test('an instance admin turns own keys off: nothing can be changed, the owner is emailed, and back on', async () => {
    const reason = 'Keys used for something else'
    expect(
      await asServerAdmin(admin, () => act(admin, 'partnerKeys.adminDisable', { partnerId: b.id, reason })),
    ).toMatchObject({ status: 200 })
    expect(sent.some(e => e.text.includes(reason))).toBe(true)
    expect(
      await act(b.owner, 'partnerKeys.set', { partnerId: b.id, stage: 'stt', provider: 'deepgram', apiKey: KEY }),
    ).toMatchObject({ status: 409, body: { code: 'keys_disabled' } })
    expect((await act(b.owner, 'partnerKeys.get', { partnerId: b.id })).body.data.disabled).toMatchObject({ reason })
    expect((await act(b.owner, 'partnerKeys.adminDisable', { partnerId: b.id, reason })).status).toBe(403)
    expect(await asServerAdmin(admin, () => act(admin, 'partnerKeys.adminEnable', { partnerId: b.id }))).toMatchObject({
      status: 200,
    })
    expect(
      (await act(b.owner, 'partnerKeys.set', { partnerId: b.id, stage: 'stt', provider: 'deepgram', apiKey: KEY }))
        .status,
    ).toBe(200)
  })
})

describe('key tests', () => {
  test('a few per 10 minutes per partner, then refused with a code the page words', async () => {
    const p = await makePartner('Busy Testers')
    await storeWorking(p, 'stt', 'deepgram')
    for (let i = 0; i < 10; i++)
      expect(await act(p.owner, 'partnerKeys.test', { partnerId: p.id, stage: 'stt' })).toMatchObject({ status: 200 })
    expect(await act(p.owner, 'partnerKeys.test', { partnerId: p.id, stage: 'stt' })).toMatchObject({
      status: 409,
      body: { code: 'too_many_tests' },
    })
    // Thirteen requests in a row (each test asks the stubbed provider): more than CI's default 5 s on a busy runner.
  }, 30_000)
})

describe('encryption', () => {
  test('a key copied to another partner or stage does not decrypt; a rotation re-encrypts partner keys', async () => {
    const row = (await stage(a, 'stt'))!
    expect(() => decryptSecret(row.key_encrypted, partnerKeySlot(b.id, 'stt', 'deepgram'))).toThrow()
    expect(() => decryptSecret(row.key_encrypted, partnerKeySlot(a.id, 'llm', 'deepgram'))).toThrow()
    const from = parseSecretsKey(process.env.SECRETS_KEY!)
    const to = parseSecretsKey(Buffer.alloc(32, 7).toString('base64'))
    await db
      .transaction(async tx => {
        const counts = await reencryptSecrets(tx, from, to)
        expect(counts.partner_providers).toBeGreaterThan(0)
        const [moved] = await tx
          .select()
          .from(partner_providers)
          .where(and(eq(partner_providers.partner_id, a.id), eq(partner_providers.category, 'stt')))
        expect(decryptSecret(moved!.key_encrypted, partnerKeySlot(a.id, 'stt', 'deepgram'), to)).toBe(KEY)
        tx.rollback()
      })
      .catch(e => {
        if (e?.constructor?.name !== 'TransactionRollbackError') throw e
      })
  })

  test('failure texts lose anything that looks like a key', () => {
    expect(maskFailure('401 invalid key sk-proj-abcdefghijklmnop for user')).toBe('401 invalid key [redacted] for user')
    expect(maskFailure(`bad ${KEY} here`, KEY)).toBe('bad [redacted] here')
    expect(maskFailure('token ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 refused')).toBe('token [redacted] refused')
  })
})

describe('calls on the partner keys', () => {
  test('forecast only with the switch on, the own carrier, every stage ok, and the voice of the partner provider', async () => {
    const p = await makePartner('Forecast Partners')
    const client = await createClient(p, 'Forecast Client')
    const three = { pipeline: 'three_stage' as const, voice: { provider: 'elevenlabs' } }
    const run = (choices = three) => db.transaction(tx => workspaceOwnKeys(tx, client, choices))
    expect(await run()).toBe(false)
    await storeWorking(p, 'stt', 'deepgram')
    await storeWorking(p, 'llm', 'openai')
    await storeWorking(p, 'tts', 'elevenlabs')
    expect(
      await act(p.owner, 'partner.setClientOwnKeys', { partnerId: p.id, workspaceId: client, on: true }),
    ).toMatchObject({
      status: 200,
    })
    // Partner › Clients shows the switch and whether the client's calls come in on its own carrier.
    const listed = async () =>
      (await act(p.owner, 'partner.listClients', { partnerId: p.id })).body.data.clients.find(
        (c: { id: string }) => c.id === client,
      )
    expect(await listed()).toMatchObject({ ownKeys: true, ownCarrier: false })
    // Still the install's carrier: billed.
    expect(await run()).toBe(false)
    await db.update(workspace_settings).set({ carrier: 'telnyx' }).where(eq(workspace_settings.workspace_id, client))
    expect(await listed()).toMatchObject({ ownKeys: true, ownCarrier: true })
    expect(await run()).toBe(true)
    // A voice of another provider than the partner's: billed.
    expect(await run({ ...three, voice: { provider: 'cartesia' } })).toBe(false)
    // Realtime needs the partner's realtime key.
    expect(await run({ pipeline: 'realtime' as never, voice: { provider: 'openai_realtime' } })).toBe(false)
    // A failing stage: billed.
    await db
      .update(partner_providers)
      .set({ status: 'failing' })
      .where(and(eq(partner_providers.partner_id, p.id), eq(partner_providers.category, 'llm')))
    expect(await run()).toBe(false)
    await db
      .update(partner_providers)
      .set({ status: 'ok' })
      .where(and(eq(partner_providers.partner_id, p.id), eq(partner_providers.category, 'llm')))
    // Turned off by an instance admin: billed.
    await asServerAdmin(admin, () => act(admin, 'partnerKeys.adminDisable', { partnerId: p.id, reason: 'checking it' }))
    expect(await run()).toBe(false)
    const adminRow = (await asServerAdmin(admin, () => act(admin, 'partner.adminList', {}))).body.data.partners.find(
      (x: { id: string }) => x.id === p.id,
    )
    expect(adminRow.ownKeysDisabled).toMatchObject({ reason: 'checking it' })
    await asServerAdmin(admin, () => act(admin, 'partnerKeys.adminEnable', { partnerId: p.id }))
    expect(await run()).toBe(true)
    // A partner workspace of someone else's, or none: never.
    expect(await db.transaction(tx => workspaceOwnKeys(tx, clientB, three))).toBe(false)
  })

  test('the agent reads the keys of a running own-keys call only, with the install token, never a call token', async () => {
    const p = await makePartner('Agent Partners')
    const client = await createClient(p, 'Agent Client')
    await storeWorking(p, 'stt', 'deepgram')
    await storeWorking(p, 'llm', 'openai')
    const id = `call_${crypto.randomUUID().slice(0, 12)}`
    await db
      .insert(calls)
      .values({ id, workspace_id: client, from_number: '+14155550100', to_number: '+14155550101', partner_keys: true })
    const plain = `call_${crypto.randomUUID().slice(0, 12)}`
    await db
      .insert(calls)
      .values({ id: plain, workspace_id: client, from_number: '+14155550100', to_number: '+14155550101' })

    const res = await request(agent(), 'GET', `/v1/agent/call-provider-config?callId=${id}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      stt: { provider: 'deepgram', api_key: `stt_${KEY}` },
      llm: { provider: 'openai', api_key: `llm_${KEY}` },
    })
    expect(await partnerKeysForCall(db, id)).toEqual(res.body)
    // Not forecast on own keys, finished, unknown: nothing.
    expect((await request(agent(), 'GET', `/v1/agent/call-provider-config?callId=${plain}`)).status).toBe(404)
    expect((await request(agent(), 'GET', '/v1/agent/call-provider-config?callId=nope')).status).toBe(404)
    // A member's session cannot read it.
    expect((await request(p.owner, 'GET', `/v1/agent/call-provider-config?callId=${id}`)).status).toBe(403)
    await db.update(calls).set({ status: 'completed' }).where(eq(calls.id, id))
    expect((await request(agent(), 'GET', `/v1/agent/call-provider-config?callId=${id}`)).status).toBe(404)
  })

  test('a report confirms own keys only when every stage of its pipeline says partner', () => {
    expect(reportConfirmsOwnKeys({ stt: 'partner', llm: 'partner', tts: 'partner' })).toBe(true)
    expect(reportConfirmsOwnKeys({ realtime: 'partner' })).toBe(true)
    expect(reportConfirmsOwnKeys({ stt: 'partner', llm: 'partner', tts: 'install' })).toBe(false)
    expect(reportConfirmsOwnKeys({ stt: 'partner', llm: 'partner' })).toBe(false)
    expect(reportConfirmsOwnKeys({})).toBe(false)
    expect(reportConfirmsOwnKeys(null)).toBe(false)
  })
})
