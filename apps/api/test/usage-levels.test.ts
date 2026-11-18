// Call quality on Linedesk Cloud (src/usage-levels.ts, src/call-quality.ts, decisions.md 2026-11-17): the assistant's
// level (Standard, Premium, Ultra) and its model picks, who may raise it, the install's settings in Server admin, the
// checks in assistant.update and the level call.start decides. Picking Premium or Ultra is the consent; there are no
// Allow switches (call quality 4/5). Billing is switched on by replacing billingState (no Stripe keys in tests); the
// three stages are set up through the environment, so this file is instance-wide (vitest.config.ts).
import { CALL_QUALITY_INSTALL_DEFAULT, centsPerMinute } from '@linedesk/actions'
import {
  assistant_versions,
  assistants,
  billing_accounts,
  instance_settings,
  organization,
  partner_members,
  partners,
  session,
  user,
} from '@linedesk/db'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { setupActorIn, workspaceSetupActor } from '../src/agent-setup.ts'
import { listAudit } from '../src/audit.ts'
import { auth } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { runAction } from '../src/run-action.ts'
import {
  act,
  addMember,
  agent,
  asServerAdmin,
  type Caller,
  createWorkspace,
  getAssistant,
  randomNumber,
  request,
  signUp,
} from './helpers.ts'

const cloud = vi.hoisted(() => ({ on: true }))
vi.mock('../src/billing-settings.ts', async original => {
  const real = await original<typeof import('../src/billing-settings.ts')>()
  return {
    ...real,
    billingState: async (...args: Parameters<typeof real.billingState>) =>
      cloud.on ? { ...(await real.billingState(...args)), inEffect: 'stripe' as const } : real.billingState(...args),
  }
})

// Placeholder values, never sent anywhere: the three stages count as set up.
const ENV = {
  STT_PROVIDER: 'deepgram',
  DEEPGRAM_API_KEY: 'placeholder',
  LLM_PROVIDER: 'openai',
  OPENAI_API_KEY: 'placeholder',
  TTS_PROVIDER: 'elevenlabs',
  ELEVENLABS_API_KEY: 'placeholder',
}
const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// A placeholder, never sent anywhere: the realtime model counts as set up, next to the three stages.
const REALTIME = { OPENAI_REALTIME_API_KEY: 'placeholder' }
/** The ALERT lines a console.error spy saw (usage-levels.ts, alert). */
const alertLines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(c => String(c[0])).filter(line => line.startsWith('ALERT usage level'))
/** The database's own message of a failed query (drizzle wraps it in `cause`); null when it did not fail. */
const dbError = (query: PromiseLike<unknown>) =>
  Promise.resolve(query).then(
    () => null,
    (e: { cause?: { message?: string } }) => e.cause?.message ?? String(e),
  )
/** Runs `run` with these environment variables (undefined: unset), then puts them back. */
async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  const set = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  set(vars)
  try {
    return await run()
  } finally {
    set(before)
  }
}
const premiumVoice = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9', model: 'eleven_v3' }

// --- Call quality

/** The install's call quality settings back to the install default after each test (instance-wide). */
async function resetCallQuality() {
  const value = JSON.stringify(CALL_QUALITY_INSTALL_DEFAULT)
  await db
    .insert(instance_settings)
    .values({ key: 'call_quality', value, updated_at: new Date().toISOString(), updated_by: 'test' })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value } })
}
afterEach(resetCallQuality)

const setLevel = (who: Caller, assistantId: string, call_quality: string, more: Record<string, unknown> = {}) =>
  act(who, 'assistant.update', { assistantId, call_quality, ...more })
const start = async (number: string) =>
  (await act(agent(), 'call.start', { from: randomNumber(), to: number })).body.data
/** Server admin › Providers › Call quality, as a fresh server admin. */
async function adminSet(input: Record<string, unknown>) {
  const operator = await signUp()
  return asServerAdmin(operator, async () => ({ ...(await act(operator, 'callQuality.set', input)), operator }))
}
const latestVersion = async (assistantId: string) =>
  (await db.select().from(assistant_versions).where(eq(assistant_versions.assistant_id, assistantId))).sort(
    (a, b) => b.number - a.number,
  )[0]!
/** A bill of `owner` paying for these workspaces. */
async function billOf(ownerId: string, workspaceIds: string[]) {
  const billId = `bill_${crypto.randomUUID()}`
  await db.insert(billing_accounts).values({ id: billId, kind: 'cloud', owner_user_id: ownerId, status: 'active' })
  await db.update(organization).set({ billingAccountId: billId }).where(inArray(organization.id, workspaceIds))
  return billId
}

describe('call quality on Cloud: the level decides the price', () => {
  test('the owner raises to Premium; its picks must be Premium or Standard; call.start prices the level', async () => {
    const ws = await createWorkspace('Quality Premium Plumbing')
    expect((await getAssistant(ws.assistant.id))!.call_quality).toBe('standard')
    const update = (input: Record<string, unknown>) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })

    // A Premium model on Standard: refused with the level named.
    expect(await update({ llm_model: 'gpt-5.4' })).toMatchObject({
      status: 409,
      body: { error: 'That model is not part of Standard.' },
    })
    expect((await update({ voice: premiumVoice })).status).toBe(409)
    expect((await update({ llm_model: 'gpt-5.4-mini' })).status).toBe(200)
    // Not a listed model of the install's provider (OpenAI): refused on every level.
    expect((await update({ llm_model: 'gpt-5.6-terra' })).status).toBe(409)

    // Premium with no picks of its own: the server's Premium defaults (GPT-4.1, Multilingual v2), priced Premium.
    expect((await update({ call_quality: 'premium' })).status).toBe(200)
    const onDefaults = await start(ws.number)
    expect(onDefaults).toMatchObject({
      usageLevel: 'premium',
      assistant: {
        call_quality: 'premium',
        llm_model: 'gpt-5.4-mini',
        voice: { provider: 'elevenlabs', model: 'eleven_multilingual_v2' },
      },
    })
    // The Standard pick it had stays (Premium takes Standard parts) and still costs Premium.
    expect(centsPerMinute('premium')).toBe(10)

    expect((await update({ voice: premiumVoice, llm_model: 'gpt-5.4' })).status).toBe(200)
    expect(await start(ws.number)).toMatchObject({
      usageLevel: 'premium',
      assistant: { voice: premiumVoice, llm_model: 'gpt-5.4', call_quality: 'premium' },
    })
    // Other changes never fail over the level.
    expect((await update({ greeting: 'Hi, this is Maya.' })).status).toBe(200)

    // Back to Standard: the Premium picks go in the same save, the calls are Standard on the Standard defaults.
    expect((await update({ call_quality: 'standard' })).status).toBe(200)
    expect(await getAssistant(ws.assistant.id)).toMatchObject({ call_quality: 'standard', llm_model: null })
    expect((await getAssistant(ws.assistant.id))!.voice.model).toBeUndefined()
    expect(await start(ws.number)).toMatchObject({
      usageLevel: 'standard',
      assistant: { llm_model: 'gpt-4.1-mini', voice: { model: 'eleven_flash_v2_5' } },
    })
  })

  test('only the person who pays raises; anyone who edits the assistant lowers; never an API key or impersonation', async () => {
    // Bill owner B pays for W, which X owns; an admin A of W does not pay.
    const payerWs = await createWorkspace('Quality Payer Plumbing')
    const ws = await createWorkspace('Quality Paid For Heating')
    await billOf(payerWs.owner.userId, [payerWs.id, ws.id])
    const payer = payerWs.owner
    await auth.api.addMember({ body: { userId: payer.userId, organizationId: ws.id, role: 'admin' } })
    expect((await request(payer, 'POST', '/api/auth/organization/set-active', { organizationId: ws.id })).status).toBe(
      200,
    )
    const admin = await addMember(ws.id, 'admin')
    const mayRaise = async (who: Caller) => (await act(who, 'voice.options', {})).body.data.callQuality.mayRaise

    expect(await mayRaise(ws.owner)).toBe(false)
    expect(await mayRaise(admin)).toBe(false)
    expect(await mayRaise(payer)).toBe(true)
    expect(await setLevel(ws.owner, ws.assistant.id, 'premium')).toMatchObject({
      status: 403,
      body: {
        error: 'Premium and Ultra cost more a minute: only the person who pays for this workspace can pick them.',
      },
    })
    expect((await setLevel(admin, ws.assistant.id, 'premium')).status).toBe(403)
    expect((await getAssistant(ws.assistant.id))!.call_quality).toBe('standard')

    // The payer raises it, as an admin of the workspace.
    expect((await setLevel(payer, ws.assistant.id, 'premium', { llm_model: 'gpt-5.4' })).status).toBe(200)
    // Others may change the picks within the level (no raise), and lower it.
    expect((await act(admin, 'assistant.update', { assistantId: ws.assistant.id, llm_model: 'gpt-4.1' })).status).toBe(
      200,
    )
    expect((await setLevel(admin, ws.assistant.id, 'standard')).status).toBe(200)
    expect(await getAssistant(ws.assistant.id)).toMatchObject({ call_quality: 'standard', llm_model: null })

    // The payer signed in as someone else (an instance admin impersonating them): no raise.
    const operator = await signUp()
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
    await db.update(session).set({ impersonatedBy: operator.userId }).where(eq(session.userId, payer.userId))
    try {
      expect((await setLevel(payer, ws.assistant.id, 'premium')).status).toBe(403)
    } finally {
      await db.update(session).set({ impersonatedBy: null }).where(eq(session.userId, payer.userId))
    }

    // The refusals are in the audit log.
    const audit = await listAudit(db, { workspaceId: ws.id, limit: 50 })
    expect(audit.entries.filter(e => e.what === 'assistant.update' && e.refused).length).toBeGreaterThanOrEqual(2)
  })

  test('a workspace without a bill: its owner raises, its admins do not', async () => {
    const ws = await createWorkspace('Quality Unbilled Plumbing')
    const admin = await addMember(ws.id, 'admin')
    expect((await setLevel(admin, ws.assistant.id, 'premium')).status).toBe(403)
    // An AI agent's setup link of the owner: no raise either (refuseBillingActor); lowering is fine.
    const link = await act(ws.owner, 'agentSetup.createWorkspaceKey', {})
    const linkActor = (await workspaceSetupActor(ws.owner.userId, link.body.data.keyId, ws.id, 'owner'))!
    const setupActor = (await setupActorIn(linkActor, ws.id))!
    const raise = { assistantId: ws.assistant.id, call_quality: 'premium' }
    expect((await runAction('assistant.update', raise, setupActor)).status).toBe(403)
    expect((await setLevel(ws.owner, ws.assistant.id, 'premium')).status).toBe(200)
    expect((await runAction('assistant.update', { ...raise, call_quality: 'standard' }, setupActor)).status).toBe(200)
  })

  test('the bill of one workspace: its admins raise like its owner; members and API keys never (decision of 2026-11-17)', async () => {
    const ws = await createWorkspace('Quality Only Workspace Plumbing')
    const payer = await addMember(ws.id, 'admin')
    await billOf(payer.userId, [ws.id])
    const admin = await addMember(ws.id, 'admin')
    const member = await addMember(ws.id, 'member')
    const mayRaise = async (who: Caller) => (await act(who, 'voice.options', {})).body.data.callQuality.mayRaise
    expect(await mayRaise(admin)).toBe(true)
    expect(await mayRaise(ws.owner)).toBe(true)
    expect(await mayRaise(member)).toBe(false)
    expect((await setLevel(member, ws.assistant.id, 'premium')).status).toBe(403)
    // An API key of the admin never raises (refuseBillingActor), with the highest role a key can have.
    const key = await act(admin, 'apiKey.create', { name: 'quality', role: 'admin' })
    const bearer = { headers: { authorization: `Bearer ${key.body.data.key}` } }
    expect((await setLevel(bearer, ws.assistant.id, 'premium')).status).toBe(403)
    expect((await getAssistant(ws.assistant.id))!.call_quality).toBe('standard')
    expect((await setLevel(admin, ws.assistant.id, 'premium')).status).toBe(200)
  })

  test('voice.options: the levels on, their prices, their models and defaults; no prices for a partner client', async () => {
    const ws = await createWorkspace('Quality Options Plumbing')
    await billOf(ws.owner.userId, [ws.id])
    const options = async (who: Caller = ws.owner) => (await act(who, 'voice.options', {})).body.data.callQuality
    const got = await options()
    expect(got).toMatchObject({
      defaultLevel: 'standard',
      mayRaise: true,
      partnerManaged: false,
      llmProvider: 'openai',
    })
    // Ultra needs a realtime model connected: none here.
    expect(got.levels.map((l: { level: string }) => l.level)).toEqual(['standard', 'premium'])
    const [standard, premium] = got.levels
    expect(standard).toMatchObject({
      centsPerMinute: 5,
      defaults: { llm: 'gpt-4.1-mini', voice: { elevenlabs: 'eleven_flash_v2_5' }, realtime: null },
    })
    // The assistant editor has no speech recognition pick (later): no stt in its levels.
    expect(standard.defaults).not.toHaveProperty('stt')
    expect(premium).toMatchObject({
      centsPerMinute: 10,
      defaults: { llm: 'gpt-4.1', voice: { elevenlabs: 'eleven_multilingual_v2' }, realtime: null },
    })
    // Premium lists its own models and Standard's; Standard only its own.
    const ids = (l: { models: { id: string }[] }) => l.models.map(m => m.id)
    expect(ids(premium)).toEqual(expect.arrayContaining(['gpt-5.4', 'gpt-4.1', 'gpt-4.1-mini']))
    expect(ids(standard)).not.toContain('gpt-5.4')

    // With a realtime model, Ultra too.
    await withEnv(REALTIME, async () => {
      const ultra = (await options()).levels.find((l: { level: string }) => l.level === 'ultra')
      expect(ultra).toMatchObject({ centsPerMinute: 20, defaults: { realtime: 'gpt-realtime' } })
      expect(ultra.realtimeModels.map((m: { id: string }) => m.id)).toEqual(['gpt-realtime', 'gpt-realtime-2'])
    })

    // A partner's client: the levels without prices.
    const [partner] = await db
      .insert(partners)
      .values({ id: `ptr_${crypto.randomUUID()}`, name: 'Quality Partners', status: 'approved', created_by: 'cli' })
      .returning()
    await db.insert(partner_members).values({ partner_id: partner!.id, user_id: ws.owner.userId, role: 'owner' })
    await db.update(organization).set({ partnerId: partner!.id }).where(eq(organization.id, ws.id))
    const client = await options()
    expect(client.partnerManaged).toBe(true)
    expect(client.levels.map((l: { centsPerMinute: number | null }) => l.centsPerMinute)).toEqual([null, null])
  })

  test('Ultra: a realtime model only, the call answers with it; a realtime model on another level is refused', async () => {
    await withEnv(REALTIME, async () => {
      const ws = await createWorkspace('Quality Ultra Plumbing')
      const update = (input: Record<string, unknown>) =>
        act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })
      expect((await update({ realtime_model: 'gpt-realtime-2' })).status).toBe(409)
      expect((await update({ llm_model: 'gpt-4.1-mini' })).status).toBe(200)
      expect((await update({ call_quality: 'ultra', realtime_model: 'gpt-realtime-2.1' })).status).toBe(409)
      expect((await update({ call_quality: 'ultra', realtime_model: 'gpt-realtime-2' })).status).toBe(200)
      // The three-stage pick went with the move to Ultra.
      expect(await getAssistant(ws.assistant.id)).toMatchObject({
        call_quality: 'ultra',
        llm_model: null,
        realtime_model: 'gpt-realtime-2',
      })
      expect((await update({ llm_model: 'gpt-4.1-mini' })).status).toBe(409)
      expect(await start(ws.number)).toMatchObject({
        usageLevel: 'ultra',
        assistant: { call_quality: 'ultra', realtime_model: 'gpt-realtime-2' },
      })
      expect(centsPerMinute('ultra')).toBe(20)
      // No pick: the server's default for Ultra (the install's realtime model).
      expect((await update({ realtime_model: null })).status).toBe(200)
      expect(await start(ws.number)).toMatchObject({
        usageLevel: 'ultra',
        assistant: { realtime_model: 'gpt-realtime' },
      })

      // Back to Standard: the realtime pick goes.
      expect((await update({ call_quality: 'standard' })).status).toBe(200)
      expect(await getAssistant(ws.assistant.id)).toMatchObject({ call_quality: 'standard', realtime_model: null })
    })
    // Without a realtime model connected, Ultra cannot be picked.
    const ws = await createWorkspace('Quality No Realtime Plumbing')
    expect(await setLevel(ws.owner, ws.assistant.id, 'ultra')).toMatchObject({
      status: 409,
      body: { error: 'Ultra is off on this server.' },
    })
  })

  test('a new assistant starts on the install default, Standard for someone who may not pay; a copy keeps the level', async () => {
    expect((await adminSet({ default: 'premium' })).status).toBe(200)
    // A new workspace's first assistant: its owner pays.
    const ws = await createWorkspace('Quality Default Plumbing')
    expect((await getAssistant(ws.assistant.id))!.call_quality).toBe('premium')
    const created = await act(ws.owner, 'assistant.create', {})
    expect((await getAssistant(created.body.data.assistantId))!.call_quality).toBe('premium')
    const admin = await addMember(ws.id, 'admin')
    const byAdmin = await act(admin, 'assistant.create', {})
    expect((await getAssistant(byAdmin.body.data.assistantId))!.call_quality).toBe('standard')
    const copy = await act(admin, 'assistant.create', { copyOf: ws.assistant.id })
    expect((await getAssistant(copy.body.data.assistantId))!.call_quality).toBe('standard')
    const ownerCopy = await act(ws.owner, 'assistant.create', { copyOf: ws.assistant.id })
    expect((await getAssistant(ownerCopy.body.data.assistantId))!.call_quality).toBe('premium')
    // Changing the default changes new assistants only.
    expect((await adminSet({ default: 'standard' })).status).toBe(200)
    expect((await getAssistant(ws.assistant.id))!.call_quality).toBe('premium')
  })
})

describe('Server admin › Providers › Call quality', () => {
  test('read and saved by a server admin only; Ultra needs a realtime model; the default stays a level that is on', async () => {
    const ws = await createWorkspace('Quality Admin Plumbing')
    expect((await act(ws.owner, 'callQuality.get', {})).status).toBe(403)
    expect((await act(ws.owner, 'callQuality.set', { premium: false })).status).toBe(403)
    const operator = await signUp()
    await asServerAdmin(operator, async () => {
      const got = (await act(operator, 'callQuality.get', {})).body.data
      expect(got).toMatchObject({
        settings: CALL_QUALITY_INSTALL_DEFAULT,
        realtimeSetUp: false,
        centsPerMinute: { standard: 5, premium: 10, ultra: 20 },
        llmProvider: 'openai',
      })
      expect(got.levels.map((l: { level: string; enabled: boolean }) => [l.level, l.enabled])).toEqual([
        ['standard', true],
        ['premium', true],
        ['ultra', false],
      ])
      // Off already, without a realtime model: turning it on is refused.
      await act(operator, 'callQuality.set', { ultra: false })
      expect(await act(operator, 'callQuality.set', { ultra: true })).toMatchObject({
        status: 409,
        body: { error: 'Connect a realtime model first.' },
      })
      await withEnv(REALTIME, async () => {
        expect((await act(operator, 'callQuality.set', { ultra: true, default: 'ultra' })).status).toBe(200)
        // A level turned off takes the default back to Standard.
        const off = (await act(operator, 'callQuality.set', { ultra: false })).body.data
        expect(off.settings).toMatchObject({ ultra: false, default: 'standard' })
        expect(await act(operator, 'callQuality.set', { default: 'ultra' })).toMatchObject({ status: 409 })
      })
      const audit = await listAudit(db, { kind: 'admin', limit: 50 })
      expect(
        audit.entries.filter(e => e.what === 'callQuality.set' && e.actor.id === operator.userId && !e.refused),
      ).toHaveLength(3)
    })
  })

  test('default models per level: only of that level; calls without their own pick use them from the next call on', async () => {
    const ws = await createWorkspace('Quality Default Models Plumbing')
    expect((await adminSet({ models: { standard: { llm: 'gpt-4.1' } } })).body).toMatchObject({
      error: 'That model is not part of Standard.',
    })
    expect((await adminSet({ models: { premium: { voice: { elevenlabs: 'eleven_turbo_v2_5' } } } })).status).toBe(409)
    // Premium may use a Standard model as its default.
    expect((await adminSet({ models: { premium: { llm: 'gpt-4.1-mini' } } })).status).toBe(200)
    expect((await adminSet({ models: { standard: { llm: 'gpt-5.4-mini' } } })).status).toBe(200)
    expect(await start(ws.number)).toMatchObject({ usageLevel: 'standard', assistant: { llm_model: 'gpt-5.4-mini' } })
    await setLevel(ws.owner, ws.assistant.id, 'premium')
    expect(await start(ws.number)).toMatchObject({ usageLevel: 'premium', assistant: { llm_model: 'gpt-4.1-mini' } })
    // null: back to the default constant.
    expect((await adminSet({ models: { premium: { llm: null } } })).body.data.settings.models.premium).toEqual({})
    expect(await start(ws.number)).toMatchObject({ usageLevel: 'premium', assistant: { llm_model: 'gpt-4.1' } })
  })

  test("speech recognition per level: a model of the install's provider; the call hears with its level's", async () => {
    const ws = await createWorkspace('Quality Speech Plumbing')
    const operator = await signUp()
    await asServerAdmin(operator, async () => {
      const got = (await act(operator, 'callQuality.get', {})).body.data
      expect(got.sttProvider).toBe('deepgram')
      const [standard, premium, ultra] = got.levels
      // Without a pick: the provider's first model (what calls used before), on Standard and Premium.
      expect(standard.defaults.stt).toBe('flux-general-en')
      expect(premium.defaults.stt).toBe('flux-general-en')
      expect(standard.sttModels.map((m: { id: string }) => m.id)).toEqual(['flux-general-en', 'nova-3'])
      expect(ultra).toMatchObject({ sttModels: [], defaults: { stt: null } })
    })
    expect(await start(ws.number)).toMatchObject({ usageLevel: 'standard', sttModel: 'flux-general-en' })
    // Another provider's model, or one Linedesk does not know: refused.
    expect((await adminSet({ models: { premium: { stt: 'gpt-4o-transcribe' } } })).body).toMatchObject({
      error: 'That model is not part of Premium.',
    })
    expect((await adminSet({ models: { standard: { stt: 'nova-9' } } })).status).toBe(409)
    expect((await adminSet({ models: { premium: { stt: 'nova-3' } } })).status).toBe(200)
    expect(await start(ws.number)).toMatchObject({ usageLevel: 'standard', sttModel: 'flux-general-en' })
    await setLevel(ws.owner, ws.assistant.id, 'premium')
    expect(await start(ws.number)).toMatchObject({ usageLevel: 'premium', sttModel: 'nova-3' })
    // null: back to the provider's default.
    expect((await adminSet({ models: { premium: { stt: null } } })).status).toBe(200)
    expect(await start(ws.number)).toMatchObject({ usageLevel: 'premium', sttModel: 'flux-general-en' })
  })

  test('a level turned off moves its assistants to Standard (a version each, by the admin); Undo moves them back', async () => {
    const ws = await createWorkspace('Quality Off Plumbing')
    const other = await createWorkspace('Quality Off Heating')
    expect((await setLevel(ws.owner, ws.assistant.id, 'premium', { llm_model: 'gpt-5.4' })).status).toBe(200)
    expect((await setLevel(other.owner, other.assistant.id, 'premium')).status).toBe(200)
    const off = await adminSet({ premium: false })
    expect(off.status).toBe(200)
    const moved = off.body.data.moved as { level: string; assistantIds: string[] }[]
    expect(moved).toEqual([
      { level: 'premium', assistantIds: expect.arrayContaining([ws.assistant.id, other.assistant.id]) },
    ])
    expect(await getAssistant(ws.assistant.id)).toMatchObject({ call_quality: 'standard', llm_model: null })
    expect(await latestVersion(ws.assistant.id)).toMatchObject({
      changed_by: off.operator.userId,
      settings: expect.objectContaining({ call_quality: 'standard' }),
    })
    // Picking it now is refused; so is a call on it (none is left).
    expect(await setLevel(ws.owner, ws.assistant.id, 'premium')).toMatchObject({
      status: 409,
      body: { error: 'Premium is off on this server.' },
    })
    expect((await start(ws.number)).usageLevel).toBe('standard')

    // Undo: on again, and the moved assistants back on Premium (their own picks stay dropped).
    const undo = await adminSet({ premium: true, restore: { level: 'premium', assistantIds: moved[0]!.assistantIds } })
    expect(undo.status).toBe(200)
    expect(await getAssistant(ws.assistant.id)).toMatchObject({ call_quality: 'premium', llm_model: null })
    expect((await getAssistant(other.assistant.id))!.call_quality).toBe('premium')
    // Undo of a level that is off: refused.
    expect((await adminSet({ restore: { level: 'ultra', assistantIds: [ws.assistant.id] } })).status).toBe(409)
  })

  test('a level off behind the switch (stored settings changed): the call falls back to Standard with an ALERT', async () => {
    const ws = await createWorkspace('Quality Fallback Plumbing')
    await setLevel(ws.owner, ws.assistant.id, 'premium', { llm_model: 'gpt-5.4' })
    await db
      .update(instance_settings)
      .set({ value: JSON.stringify({ ...CALL_QUALITY_INSTALL_DEFAULT, premium: false }) })
      .where(eq(instance_settings.key, 'call_quality'))
    const alerts = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await start(ws.number)).toMatchObject({
        usageLevel: 'standard',
        assistant: { call_quality: 'standard', llm_model: 'gpt-4.1-mini', voice: { model: 'eleven_flash_v2_5' } },
      })
      expect(alertLines(alerts)).toEqual([
        expect.stringContaining(
          `assistant ${ws.assistant.id} of workspace ${ws.id} cannot answer on its level (Premium is off)`,
        ),
      ])
    } finally {
      alerts.mockRestore()
    }
  })

  test('a model left on a level it does not belong to (written elsewhere): the call falls back to Standard', async () => {
    const ws = await createWorkspace('Quality Stray Model Plumbing')
    await db.update(assistants).set({ llm_model: 'gpt-5.4' }).where(eq(assistants.id, ws.assistant.id))
    const alerts = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // The pick that is not Standard is not used: the Standard default answers, priced Standard.
      expect(await start(ws.number)).toMatchObject({ usageLevel: 'standard', assistant: { llm_model: 'gpt-4.1-mini' } })
    } finally {
      alerts.mockRestore()
    }
  })

  test('nothing Standard set up (only the realtime model): not_allowed and the call is not answered', async () => {
    await withEnv({ ...REALTIME, TTS_PROVIDER: undefined, ELEVENLABS_API_KEY: undefined }, async () => {
      const ws = await createWorkspace('Quality Realtime Only Plumbing')
      const alerts = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect((await start(ws.number)).usageLevel).toBe('not_allowed')
        expect(alertLines(alerts)).toEqual([expect.stringContaining('the call is not answered')])
      } finally {
        alerts.mockRestore()
      }
    })
    expect(() => centsPerMinute('not_allowed')).toThrow(/must not run/)
  })
})

describe('the bill owner changes', () => {
  test("the old payer's Premium and Ultra go to Standard (billPayerChanged)", async () => {
    await withEnv(REALTIME, async () => {
      const ws = await createWorkspace('Quality Payer Change Plumbing')
      const second = (await act(ws.owner, 'assistant.create', {})).body.data.assistantId
      await setLevel(ws.owner, ws.assistant.id, 'premium')
      await setLevel(ws.owner, second, 'ultra')
      const { billPayerChanged } = await import('../src/usage-levels.ts')
      const { reset } = await db.transaction(tx => billPayerChanged(tx, [ws.id], ws.owner.userId))
      expect(reset).toMatchObject({ movedToStandard: [ws.assistant.id], movedOffUltra: [second] })
      expect((await getAssistant(ws.assistant.id))!.call_quality).toBe('standard')
      expect(await getAssistant(second)).toMatchObject({ call_quality: 'standard', realtime_model: null })
    })
  })
})

describe('self-hosted (no billing)', () => {
  test('the same three levels, no prices, anyone who edits may pick; call.start passes no level', async () => {
    cloud.on = false
    try {
      const ws = await createWorkspace('Quality Self Hosted Plumbing')
      const admin = await addMember(ws.id, 'admin')
      const options = (await act(admin, 'voice.options', {})).body.data.callQuality
      expect(options.mayRaise).toBe(true)
      expect(options.levels.map((l: { centsPerMinute: number | null }) => l.centsPerMinute)).toEqual([null, null])
      expect(
        (await setLevel(admin, ws.assistant.id, 'premium', { voice: premiumVoice, llm_model: 'gpt-5.4' })).status,
      ).toBe(200)
      const started = await start(ws.number)
      expect(started.usageLevel).toBeNull()
      expect(started.assistant).toMatchObject({ voice: premiumVoice, llm_model: 'gpt-5.4' })
    } finally {
      cloud.on = true
    }
  })

  test('Ultra without a realtime model connected: the three stages answer, a call is never left unanswered', async () => {
    cloud.on = false
    try {
      const ws = await createWorkspace('Quality Self Hosted Ultra Plumbing')
      await db.update(assistants).set({ call_quality: 'ultra' }).where(eq(assistants.id, ws.assistant.id))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(await start(ws.number)).toMatchObject({ usageLevel: null, assistant: { call_quality: 'standard' } })
      } finally {
        warn.mockRestore()
      }
      await withEnv(REALTIME, async () => {
        expect(await start(ws.number)).toMatchObject({
          usageLevel: null,
          assistant: { call_quality: 'ultra', realtime_model: 'gpt-realtime' },
        })
      })
    } finally {
      cloud.on = true
    }
  })
})

describe('models come from the call quality level, not from the provider', () => {
  test('a voice or language provider takes no model; the defaults per level are set under Call quality', async () => {
    const operator = await signUp()
    await asServerAdmin(operator, async () => {
      expect(
        (await act(operator, 'provider.setKeys', { provider: 'elevenlabs', values: { model: 'eleven_v3' } })).status,
      ).toBe(422)
      expect(
        (await act(operator, 'provider.setKeys', { provider: 'openai', values: { model: 'gpt-5.4' } })).status,
      ).toBe(422)
    })
  })
})

describe('audit, locking and limits', () => {
  test('a change of the level or a model by an admin or a setup link is in the audit log', async () => {
    const ws = await createWorkspace('Quality Audit Plumbing')
    await setLevel(ws.owner, ws.assistant.id, 'premium')
    const admin = await addMember(ws.id, 'admin')
    expect(
      (
        await act(admin, 'assistant.update', {
          assistantId: ws.assistant.id,
          voice: premiumVoice,
          llm_model: 'gpt-5.4',
        })
      ).status,
    ).toBe(200)
    const link = await act(ws.owner, 'agentSetup.createWorkspaceKey', {})
    const linkActor = (await workspaceSetupActor(ws.owner.userId, link.body.data.keyId, ws.id, 'owner'))!
    const setupActor = (await setupActorIn(linkActor, ws.id))!
    expect(
      (await runAction('assistant.update', { assistantId: ws.assistant.id, call_quality: 'standard' }, setupActor))
        .status,
    ).toBe(200)
    // A save that changes neither is not listed.
    await act(admin, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'Hi, Brightwater here.' })

    const audit = await listAudit(db, { kind: 'team', workspaceId: ws.id, limit: 50 })
    const changes = audit.entries.filter(e => e.what === 'assistant.update' && e.usageLevelChange)
    const premiumPicks = {
      call_quality: 'premium',
      voice_model: 'elevenlabs/eleven_v3',
      llm_model: 'gpt-5.4',
      realtime_model: null,
    }
    expect(changes.map(e => e.usageLevelChange)).toEqual([
      {
        before: premiumPicks,
        after: { call_quality: 'standard', voice_model: null, llm_model: null, realtime_model: null },
      },
      {
        before: { call_quality: 'premium', voice_model: null, llm_model: null, realtime_model: null },
        after: premiumPicks,
      },
      {
        before: { call_quality: 'standard', voice_model: null, llm_model: null, realtime_model: null },
        after: { call_quality: 'premium', voice_model: null, llm_model: null, realtime_model: null },
      },
    ])
    expect(changes[0]).toMatchObject({ actor: { id: ws.owner.userId }, viaSetupKey: link.body.data.keyId })
    expect(changes[1]).toMatchObject({ actor: { id: admin.userId }, viaSetupKey: null })
  })

  test('a level turned off at the same moment as a save of the assistant: one waits for the other, never a 500', async () => {
    const ws = await createWorkspace('Quality Race Plumbing')
    const update = (input: Record<string, unknown>) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })
    const operator = await signUp()
    await asServerAdmin(operator, async () => {
      for (let run = 0; run < 6; run++) {
        expect((await act(operator, 'callQuality.set', { premium: true })).status).toBe(200)
        expect((await update({ call_quality: 'premium', llm_model: 'gpt-4.1' })).status).toBe(200)
        const save = run % 2 ? { greeting: `Hi, run ${run}.`, llm_model: 'gpt-4.1' } : { llm_model: 'gpt-5.4' }
        const [saved, off] = await Promise.all([update(save), act(operator, 'callQuality.set', { premium: false })])
        expect(off.status).toBe(200)
        expect([200, 409]).toContain(saved.status)
        // Whichever went first, nothing is left on Premium with Premium off.
        expect(await getAssistant(ws.assistant.id)).toMatchObject({ call_quality: 'standard', llm_model: null })
      }
    })
  })

  test('a version restore at the same moment as a level turned off never writes the level back', async () => {
    const ws = await createWorkspace('Quality Restore Race Plumbing')
    const update = (input: Record<string, unknown>) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })
    expect((await update({ call_quality: 'premium', greeting: 'Hello from the old version.' })).status).toBe(200)
    const versions = (await act(ws.owner, 'assistant.versions', { assistantId: ws.assistant.id })).body.data.versions
    const old = versions[0].number
    const operator = await signUp()
    await asServerAdmin(operator, async () => {
      for (let run = 0; run < 6; run++) {
        expect((await act(operator, 'callQuality.set', { premium: true })).status).toBe(200)
        expect((await update({ call_quality: 'premium', greeting: `Now, run ${run}.` })).status).toBe(200)
        const [restored, off] = await Promise.all([
          act(ws.owner, 'assistant.restoreVersion', { assistantId: ws.assistant.id, number: old }),
          act(operator, 'callQuality.set', { premium: false }),
        ])
        expect(off.status).toBe(200)
        expect([200, 409]).toContain(restored.status)
        expect((await getAssistant(ws.assistant.id))!.call_quality).toBe('standard')
      }
    })
  })

  test('restoring a version on a raised level is a raise: refused for someone who may not pay', async () => {
    const ws = await createWorkspace('Quality Restore Raise Plumbing')
    expect((await setLevel(ws.owner, ws.assistant.id, 'premium', { greeting: 'Premium days.' })).status).toBe(200)
    const premiumVersion = (await latestVersion(ws.assistant.id)).number
    expect((await setLevel(ws.owner, ws.assistant.id, 'standard')).status).toBe(200)
    const admin = await addMember(ws.id, 'admin')
    const restore = (who: Caller) =>
      act(who, 'assistant.restoreVersion', { assistantId: ws.assistant.id, number: premiumVersion })
    expect((await restore(admin)).status).toBe(403)
    expect((await restore(ws.owner)).status).toBe(200)
    expect((await getAssistant(ws.assistant.id))!.call_quality).toBe('premium')
  })

  test('the level is one of three in the database too; the longest call is 30 minutes', async () => {
    const ws = await createWorkspace('Quality Check Plumbing')
    expect(
      await dbError(
        db
          .update(assistants)
          .set({ call_quality: 'gold' as 'standard' })
          .where(eq(assistants.id, ws.assistant.id)),
      ),
    ).toMatch(/assistants_call_quality/)
    expect(
      await dbError(db.update(assistants).set({ max_call_minutes: 31 }).where(eq(assistants.id, ws.assistant.id))),
    ).toMatch(/assistants_max_call_minutes/)
    await db
      .update(assistants)
      .set({ max_call_minutes: 30 })
      .where(and(eq(assistants.id, ws.assistant.id)))
    expect((await getAssistant(ws.assistant.id))!.max_call_minutes).toBe(30)
  })
})

describe('languages follow the voice the call speaks with', () => {
  test('Hungarian with Eleven Multilingual v2 is refused; with Flash v2.5 it is fine; Premium on its default too', async () => {
    const ws = await createWorkspace('Language Voice Plumbing')
    const update = (input: Record<string, unknown>) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })
    const flash = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9', model: 'eleven_flash_v2_5' }
    const multilingual = { ...flash, model: 'eleven_multilingual_v2' }
    expect((await update({ voice: flash, languages: { main: 'en', mode: 'allowed', allowed: ['hu'] } })).status).toBe(
      200,
    )
    expect((await update({ call_quality: 'premium' })).status).toBe(200)
    // Changing the voice checks the languages again: Multilingual v2 does not speak Hungarian.
    const refused = await update({ voice: multilingual })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/eleven_multilingual_v2.*can't speak Hungarian/)
    expect(
      (await update({ voice: multilingual, languages: { main: 'en', mode: 'allowed', allowed: ['pl'] } })).status,
    ).toBe(200)
  })
})
