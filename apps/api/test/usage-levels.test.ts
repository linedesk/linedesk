// Usage levels on Linedesk Cloud (src/usage-levels.ts, decisions.md 2026-11-16): an assistant's voice model and
// language model, the owner's Allow Premium (billing:manage, audited), the checks in assistant.update and the level
// call.start decides. Billing is switched on by replacing billingState (no Stripe keys in tests); the three stages
// are set up through the environment, so this file is instance-wide (vitest.config.ts).
import { centsPerMinute } from '@linedesk/actions'
import { assistant_versions, assistants, session, user, workspace_settings } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { setupActorIn, workspaceSetupActor } from '../src/agent-setup.ts'
import { listAudit } from '../src/audit.ts'
import { db } from '../src/db.ts'
import { runAction } from '../src/run-action.ts'
import { allowPremiumOf, PREMIUM_NOT_ALLOWED, ULTRA_NOT_ALLOWED } from '../src/usage-levels.ts'
import {
  act,
  addMember,
  agent,
  asServerAdmin,
  type Caller,
  createWorkspace,
  getAssistant,
  randomNumber,
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

const setAllow = (who: Caller, on: boolean) => act(who, 'workspace.setAllowPremium', { on })
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

describe('Allow Premium', () => {
  test('off by default; the owner turns it on and off, and it is in the audit log with who did it', async () => {
    const ws = await createWorkspace('Premium Switch Plumbing')
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data).toMatchObject({
      allowPremium: false,
      usageLevels: true,
    })
    expect(await setAllow(ws.owner, true)).toMatchObject({
      status: 200,
      body: { data: { on: true, movedToStandard: [] } },
    })
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data.allowPremium).toBe(true)
    expect((await setAllow(ws.owner, false)).body.data).toMatchObject({ on: false })
    const [row] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, ws.id))
    expect(row!.allow_premium).toBe(false)

    const audit = await listAudit(db, { kind: 'team', workspaceId: ws.id, limit: 50 })
    const entries = audit.entries.filter(e => e.what === 'workspace.setAllowPremium')
    expect(entries).toHaveLength(2)
    for (const e of entries) expect(e.actor.id).toBe(ws.owner.userId)
  })

  test('refused for an admin, a member, an API key, a setup link and an impersonation', async () => {
    const ws = await createWorkspace('Premium Refusals Plumbing')
    expect((await setAllow(await addMember(ws.id, 'admin'), true)).status).toBe(403)
    expect((await setAllow(await addMember(ws.id, 'member'), true)).status).toBe(403)

    // The owner's API key, with the highest role a key can have.
    const key = await act(ws.owner, 'apiKey.create', { name: 'billing', role: 'admin' })
    const bearer = { headers: { authorization: `Bearer ${key.body.data.key}` } }
    expect((await setAllow(bearer, true)).status).toBe(403)

    // The owner's setup link for an AI agent.
    const link = await act(ws.owner, 'agentSetup.createWorkspaceKey', {})
    const setupActor = (await workspaceSetupActor(ws.owner.userId, link.body.data.keyId, ws.id, 'owner'))!
    expect((await runAction('workspace.setAllowPremium', { on: true }, setupActor)).status).toBe(403)
    // Even with billing:manage slipped into its permissions.
    expect(
      (await runAction('workspace.setAllowPremium', { on: true }, { ...setupActor, permissions: ['billing:manage'] }))
        .status,
    ).toBe(403)

    // An instance admin signed in as the owner.
    const operator = await signUp()
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, operator.userId))
    await db.update(session).set({ impersonatedBy: operator.userId }).where(eq(session.userId, ws.owner.userId))
    try {
      expect((await setAllow(ws.owner, true)).status).toBe(403)
    } finally {
      await db.update(session).set({ impersonatedBy: null }).where(eq(session.userId, ws.owner.userId))
    }
    const [row] = await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, ws.id))
    expect(row!.allow_premium).toBe(false)
    const audit = await listAudit(db, { workspaceId: ws.id, limit: 50 })
    expect(audit.entries.filter(e => e.what === 'workspace.setAllowPremium')).toEqual([])
  })
})

describe('assistant choices on Cloud', () => {
  test('Premium needs Allow Premium; Standard is always fine; options in neither list need own keys', async () => {
    const ws = await createWorkspace('Premium Choices Plumbing')
    const update = (input: Record<string, unknown>) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })

    expect(await update({ voice: premiumVoice })).toMatchObject({ status: 409, body: { error: PREMIUM_NOT_ALLOWED } })
    expect(await update({ llm_model: 'gpt-5.4' })).toMatchObject({ status: 409, body: { error: PREMIUM_NOT_ALLOWED } })
    expect((await update({ llm_model: 'gpt-5.4-mini' })).status).toBe(200)
    expect((await update({ voice: { ...premiumVoice, model: 'eleven_flash_v2_5' } })).status).toBe(200)
    // Not a listed model of the install's provider (OpenAI): refused on every install.
    expect((await update({ llm_model: 'gpt-5.6-terra' })).status).toBe(409)
    expect((await update({ llm_model: 'google/gemini-3.8-flash' })).status).toBe(409)

    await setAllow(ws.owner, true)
    expect((await update({ voice: premiumVoice, llm_model: 'gpt-5.4' })).status).toBe(200)
    expect(await getAssistant(ws.assistant.id)).toMatchObject({ voice: premiumVoice, llm_model: 'gpt-5.4' })
    // Other changes never fail over the level.
    expect((await update({ greeting: 'Hi, this is Maya.' })).status).toBe(200)

    // The install's own voice model in neither list (set in the environment): on Cloud the provider's Standard default
    // stands in for it, so saving the assistant on "Default" is never refused over it (M2).
    process.env.TTS_MODEL = 'eleven_turbo_v2_5'
    try {
      expect(
        (await update({ voice: { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' }, llm_model: null })).status,
      ).toBe(200)
    } finally {
      delete process.env.TTS_MODEL
    }
  })

  test('voice.options lists the levels; Premium greyed out until allowed', async () => {
    const ws = await createWorkspace('Premium Options Plumbing')
    const levels = async () => (await act(ws.owner, 'voice.options', {})).body.data.levels
    const before = await levels()
    expect(before).toMatchObject({
      billed: true,
      allowPremium: false,
      standardCentsPerMinute: 5,
      premiumCentsPerMinute: 10,
      llmProvider: 'openai',
    })
    expect(before.defaultModel).toEqual({ id: 'gpt-4.1-mini', level: 'standard' })
    expect(before.defaultVoiceModels.elevenlabs).toEqual({ id: 'eleven_flash_v2_5', level: 'standard' })
    expect(before.models.find((m: { id: string }) => m.id === 'gpt-5.4')).toMatchObject({
      level: 'premium',
      allowed: false,
    })
    expect(before.voiceModels.elevenlabs.find((m: { id: string }) => m.id === 'eleven_v3')).toMatchObject({
      allowed: false,
    })
    await setAllow(ws.owner, true)
    expect((await levels()).models.find((m: { id: string }) => m.id === 'gpt-5.4')).toMatchObject({ allowed: true })
  })

  test('call.start decides the level once; turning Allow Premium off moves the assistants back to Standard', async () => {
    const ws = await createWorkspace('Premium Calls Plumbing')
    const start = async () => (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
    expect((await start()).usageLevel).toBe('standard')

    await setAllow(ws.owner, true)
    await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, voice: premiumVoice, llm_model: 'gpt-4.1' })
    const premium = await start()
    expect(premium.usageLevel).toBe('premium')
    expect(premium.assistant).toMatchObject({ voice: premiumVoice, llm_model: 'gpt-4.1', voice_pipeline: 'three_stage' })

    // A Premium choice left in the row (saved before a list changed, or written elsewhere): the call answers on the
    // install's defaults, Standard.
    await db.update(workspace_settings).set({ allow_premium: false }).where(eq(workspace_settings.workspace_id, ws.id))
    const alerts = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fallback = await start()
    expect(fallback.usageLevel).toBe('standard')
    // The models the call was checked with are named on the assistant, so the agent uses exactly those.
    expect(fallback.assistant).toMatchObject({
      voice: { provider: 'elevenlabs', voice_id: premiumVoice.voice_id, model: 'eleven_flash_v2_5' },
      llm_model: 'gpt-4.1-mini',
      voice_pipeline: 'three_stage',
    })
    expect(alertLines(alerts)).toEqual([expect.stringContaining(`assistant ${ws.assistant.id} of workspace ${ws.id} is not allowed`)])
    alerts.mockRestore()

    await db.update(workspace_settings).set({ allow_premium: true }).where(eq(workspace_settings.workspace_id, ws.id))
    const other = await createWorkspace('Premium Untouched Plumbing')
    await setAllow(other.owner, true)
    await act(other.owner, 'assistant.update', { assistantId: other.assistant.id, llm_model: 'gpt-4.1' })

    const off = await setAllow(ws.owner, false)
    expect(off.body.data.movedToStandard).toEqual([ws.assistant.id])
    const [row] = await db.select().from(assistants).where(eq(assistants.id, ws.assistant.id))
    expect(row).toMatchObject({ llm_model: null, voice: { provider: 'elevenlabs', voice_id: premiumVoice.voice_id } })
    expect(row!.voice.model).toBeUndefined()
    expect((await getAssistant(other.assistant.id))!.llm_model).toBe('gpt-4.1')
    // The move is a version of its own, by the owner who turned Allow Premium off.
    const versions = await db
      .select()
      .from(assistant_versions)
      .where(eq(assistant_versions.assistant_id, ws.assistant.id))
    const latest = versions.sort((a, b) => b.number - a.number)[0]!
    expect(latest).toMatchObject({ changed_by: ws.owner.userId, settings: expect.objectContaining({ llm_model: null }) })
  })
})

describe('self-hosted (no billing)', () => {
  test('every listed option, no levels, no Allow Premium needed; call.start passes no level', async () => {
    cloud.on = false
    try {
      const ws = await createWorkspace('Self Hosted Plumbing')
      expect((await act(ws.owner, 'workspace.getSettings', {})).body.data.usageLevels).toBe(false)
      expect(
        (
          await act(ws.owner, 'assistant.update', {
            assistantId: ws.assistant.id,
            voice: premiumVoice,
            llm_model: 'gpt-5.4',
          })
        ).status,
      ).toBe(200)
      expect((await act(ws.owner, 'voice.options', {})).body.data.levels).toMatchObject({ billed: false })
      const started = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
      expect(started.usageLevel).toBeNull()
      expect(started.assistant).toMatchObject({ voice: premiumVoice, llm_model: 'gpt-5.4' })
    } finally {
      cloud.on = true
    }
  })
})

describe('a realtime model on Cloud (Ultra, not allowed yet)', () => {
  // A placeholder, never sent anywhere: the realtime model counts as set up, next to the three stages.
  const REALTIME = { OPENAI_REALTIME_API_KEY: 'placeholder' }

  test('not offered; the three stages are the default; saving a voice or model is never refused over it', async () => {
    await withEnv(REALTIME, async () => {
      const ws = await createWorkspace('Realtime Cloud Plumbing')
      const options = (await act(ws.owner, 'voice.options', {})).body.data
      expect(options.pipelines).toEqual({ realtime: false, three_stage: true })
      expect(options.realtime).toBe(false)
      expect(options.levels).toMatchObject({ allowUltra: false, realtimeAllowed: false })
      const update = (input: Record<string, unknown>) =>
        act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })
      expect((await update({ llm_model: 'gpt-5.4-mini' })).status).toBe(200)
      expect((await update({ voice: { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9' } })).status).toBe(200)
      // Picking the realtime model is Ultra: refused with what to do instead.
      expect(await update({ voice_pipeline: 'realtime' })).toMatchObject({
        status: 409,
        body: { error: ULTRA_NOT_ALLOWED },
      })
      const started = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
      expect(started).toMatchObject({
        usageLevel: 'standard',
        blocked: false,
        assistant: { voice_pipeline: 'three_stage', llm_model: 'gpt-5.4-mini' },
      })
    })
  })

  test('an assistant on the realtime model from before: its calls answer on the Standard three stages, with an ALERT', async () => {
    await withEnv(REALTIME, async () => {
      const ws = await createWorkspace('Realtime Before Plumbing')
      await db.update(assistants).set({ voice_pipeline: 'realtime' }).where(eq(assistants.id, ws.assistant.id))
      const alerts = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const started = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
        expect(started.usageLevel).toBe('standard')
        expect(started.assistant).toMatchObject({ voice_pipeline: 'three_stage', llm_model: 'gpt-4.1-mini' })
        expect(alertLines(alerts)).toEqual([
          expect.stringMatching(/realtime model gpt-realtime\): the call falls back to the Standard defaults/),
        ])
      } finally {
        alerts.mockRestore()
      }
      // Other saves still go through: the realtime pick is not this save's, its calls fall back anyway.
      expect(
        (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, llm_model: 'gpt-5.4-mini' })).status,
      ).toBe(200)
      // A version restored with the same voice, model and pipeline is not checked against the level.
      expect((await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'Hello there.' })).status).toBe(200)
      const versions = (await act(ws.owner, 'assistant.versions', { assistantId: ws.assistant.id })).body.data.versions
      const restored = await act(ws.owner, 'assistant.restoreVersion', {
        assistantId: ws.assistant.id,
        number: versions[1].number,
      })
      expect(restored.status).toBe(200)
    })
  })

  test('nothing Standard set up (only the realtime model): the level stays not_allowed and the call is not answered', async () => {
    await withEnv({ ...REALTIME, TTS_PROVIDER: undefined, ELEVENLABS_API_KEY: undefined }, async () => {
      const ws = await createWorkspace('Realtime Only Plumbing')
      const alerts = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const started = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
        expect(started.usageLevel).toBe('not_allowed')
        expect(alertLines(alerts)).toEqual([expect.stringContaining('the call is not answered')])
      } finally {
        alerts.mockRestore()
      }
    })
    // A level without a price never reaches billing: the lookup throws.
    expect(() => centsPerMinute('not_allowed')).toThrow(/must not run/)
  })

  test('self-hosted: the realtime model is offered and answers, as before', async () => {
    cloud.on = false
    try {
      await withEnv(REALTIME, async () => {
        const ws = await createWorkspace('Realtime Self Hosted Plumbing')
        const options = (await act(ws.owner, 'voice.options', {})).body.data
        expect(options.pipelines).toEqual({ realtime: true, three_stage: true })
        expect(options.levels.realtimeAllowed).toBe(true)
        const started = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
        expect(started.usageLevel).toBeNull()
        expect(started.assistant.voice_pipeline).toBeNull()
      })
    } finally {
      cloud.on = true
    }
  })
})

describe("the install's defaults on Cloud are Standard", () => {
  test('Server admin cannot save a voice or language model that is not Standard; self-hosted can', async () => {
    const operator = await signUp()
    await asServerAdmin(operator, async () => {
      const voice = await act(operator, 'provider.setKeys', { provider: 'elevenlabs', values: { model: 'eleven_v3' } })
      expect(voice.status).toBe(409)
      expect(voice.body.error).toMatch(/eleven_v3 is not a Standard voice model/)
      const llm = await act(operator, 'provider.setKeys', { provider: 'openai', values: { model: 'gpt-5.4' } })
      expect(llm.status).toBe(409)
      expect(llm.body.error).toMatch(/gpt-5.4 is not a Standard language model/)
      cloud.on = false
      try {
        expect(
          (await act(operator, 'provider.setKeys', { provider: 'elevenlabs', values: { model: 'eleven_v3' } })).status,
        ).toBe(200)
      } finally {
        cloud.on = true
        await act(operator, 'provider.setKeys', { provider: 'elevenlabs', values: { model: '' } })
      }
    })
  })

  test('every model of the install list must be Standard: a Premium fallback is refused, and from the environment named in an ALERT', async () => {
    // The environment first: a model saved in Server admin (even an empty one) stands before it.
    await withEnv({ LLM_MODEL: 'gpt-4.1-mini, gpt-5.4-pro-fallback' }, async () => {
      // The ALERT comes once per process, from the first read of the install's model: watched from the start.
      const alerts = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const ws = await createWorkspace('Fallback Env Plumbing')
        const started = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
        expect(started.usageLevel).toBe('standard')
        expect(alertLines(alerts)).toEqual(
          expect.arrayContaining([expect.stringContaining('fallback language model "gpt-5.4-pro-fallback" (openai) is not Standard')]),
        )
      } finally {
        alerts.mockRestore()
      }
    })
    const operator = await signUp()
    await asServerAdmin(operator, async () => {
      const saved = await act(operator, 'provider.setKeys', { provider: 'openai', values: { model: 'gpt-4.1-mini, gpt-5.4' } })
      expect(saved.status).toBe(409)
      expect(saved.body.error).toMatch(/gpt-5.4 is not a Standard language model/)
      expect(
        (await act(operator, 'provider.setKeys', { provider: 'openai', values: { model: 'gpt-4.1-mini, gpt-5.4-nano' } })).status,
      ).toBe(200)
      await act(operator, 'provider.setKeys', { provider: 'openai', values: { model: '' } })
    })
  })

  test('a Premium default from the environment: calls use the Standard one, with an ALERT, never Premium unpaid', async () => {
    await withEnv({ LLM_MODEL: 'gpt-5.4', TTS_MODEL: 'eleven_v3' }, async () => {
      const ws = await createWorkspace('Premium Env Plumbing')
      const alerts = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const started = (await act(agent(), 'call.start', { from: randomNumber(), to: ws.number })).body.data
        expect(started.usageLevel).toBe('standard')
        expect(started.assistant).toMatchObject({
          llm_model: 'gpt-4.1-mini',
          voice: { provider: 'elevenlabs', model: 'eleven_flash_v2_5' },
        })
        const levels = (await act(ws.owner, 'voice.options', {})).body.data.levels
        expect(levels.defaultModel).toEqual({ id: 'gpt-4.1-mini', level: 'standard' })
        expect(levels.defaultVoiceModels.elevenlabs).toEqual({ id: 'eleven_flash_v2_5', level: 'standard' })
      } finally {
        alerts.mockRestore()
      }
    })
  })
})

describe('audit, locking and limits', () => {
  test("an admin's or a setup link's change of the voice model, language model or pipeline is in the audit log", async () => {
    const ws = await createWorkspace('Premium Audit Plumbing')
    await setAllow(ws.owner, true)
    const admin = await addMember(ws.id, 'admin')
    expect(
      (await act(admin, 'assistant.update', { assistantId: ws.assistant.id, voice: premiumVoice, llm_model: 'gpt-5.4' }))
        .status,
    ).toBe(200)
    // API keys run only the public API (no assistant.update); an AI agent's setup link can change the assistant.
    const link = await act(ws.owner, 'agentSetup.createWorkspaceKey', {})
    const linkActor = (await workspaceSetupActor(ws.owner.userId, link.body.data.keyId, ws.id, 'owner'))!
    const setupActor = (await setupActorIn(linkActor, ws.id))!
    expect((await runAction('assistant.update', { assistantId: ws.assistant.id, llm_model: null }, setupActor)).status).toBe(200)
    // A save that changes neither is not listed.
    await act(admin, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'Hi, Brightwater here.' })

    const audit = await listAudit(db, { kind: 'team', workspaceId: ws.id, limit: 50 })
    const changes = audit.entries.filter(e => e.what === 'assistant.update')
    expect(changes).toHaveLength(2)
    expect(changes.map(e => e.usageLevelChange)).toEqual([
      {
        before: { voice_model: 'elevenlabs/eleven_v3', llm_model: 'gpt-5.4', voice_pipeline: null },
        after: { voice_model: 'elevenlabs/eleven_v3', llm_model: null, voice_pipeline: null },
      },
      {
        before: { voice_model: null, llm_model: null, voice_pipeline: null },
        after: { voice_model: 'elevenlabs/eleven_v3', llm_model: 'gpt-5.4', voice_pipeline: null },
      },
    ])
    expect(changes[0]).toMatchObject({ actor: { id: ws.owner.userId }, viaSetupKey: link.body.data.keyId })
    expect(changes[1]).toMatchObject({ actor: { id: admin.userId }, viaSetupKey: null })
  })

  test('a save checked against Allow Premium holds it: turning it off waits until that save is in', async () => {
    const ws = await createWorkspace('Premium Lock Plumbing')
    await setAllow(ws.owner, true)
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    let read!: () => void
    const wasRead = new Promise<void>(resolve => (read = resolve))
    const save = db.transaction(async tx => {
      expect(await allowPremiumOf(tx, ws.id, { lock: true })).toBe(true)
      read()
      await held
    })
    await wasRead
    // The owner's switch (an update of the same row) cannot go ahead while the save holds the row.
    expect(
      await dbError(
        db.transaction(async tx => {
          await tx.execute("set local lock_timeout = '200ms'")
          await tx
            .update(workspace_settings)
            .set({ allow_premium: false })
            .where(eq(workspace_settings.workspace_id, ws.id))
        }),
      ),
    ).toMatch(/lock timeout/)
    release()
    await save
    expect((await setAllow(ws.owner, false)).status).toBe(200)
  })

  test('Allow Premium off at the same moment as a save of the assistant: one waits for the other, never a 500', async () => {
    const ws = await createWorkspace('Premium Race Plumbing')
    const update = (input: Record<string, unknown>) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })
    for (let run = 0; run < 8; run++) {
      await setAllow(ws.owner, true)
      expect((await update({ llm_model: 'gpt-4.1' })).status).toBe(200)
      // A save that keeps the Premium model (the web app sends it with every save) or picks another Premium one.
      const save = run % 2 ? { greeting: `Hi, run ${run}.`, llm_model: 'gpt-4.1' } : { llm_model: 'gpt-5.4' }
      const [saved, off] = await Promise.all([update(save), setAllow(ws.owner, false)])
      expect(off.status).toBe(200)
      expect([200, 409]).toContain(saved.status)
      // Whichever went first, no Premium model is left with Allow Premium off.
      const row = await getAssistant(ws.assistant.id)
      expect(row!.llm_model).toBeNull()
    }
  })

  test('a version restore at the same moment as Allow Premium off never writes the Premium model back', async () => {
    const ws = await createWorkspace('Premium Restore Race Plumbing')
    const update = (input: Record<string, unknown>) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })
    await setAllow(ws.owner, true)
    expect((await update({ llm_model: 'gpt-4.1', greeting: 'Hello from the old version.' })).status).toBe(200)
    const versions = (await act(ws.owner, 'assistant.versions', { assistantId: ws.assistant.id })).body.data.versions
    const old = versions[0].number
    for (let run = 0; run < 6; run++) {
      await setAllow(ws.owner, true)
      // The same Premium model as the version, only the greeting differs: no level change, before the fix no lock.
      expect((await update({ llm_model: 'gpt-4.1', greeting: `Now, run ${run}.` })).status).toBe(200)
      const [restored, off] = await Promise.all([
        act(ws.owner, 'assistant.restoreVersion', { assistantId: ws.assistant.id, number: old }),
        setAllow(ws.owner, false),
      ])
      expect(off.status).toBe(200)
      expect([200, 409]).toContain(restored.status)
      expect((await getAssistant(ws.assistant.id))!.llm_model).toBeNull()
    }
  })

  test('the longest call is 30 minutes in the database too', async () => {
    const ws = await createWorkspace('Call Length Check Plumbing')
    expect(
      await dbError(db.update(assistants).set({ max_call_minutes: 31 }).where(eq(assistants.id, ws.assistant.id))),
    ).toMatch(/assistants_max_call_minutes/)
    await db.update(assistants).set({ max_call_minutes: 30 }).where(and(eq(assistants.id, ws.assistant.id)))
    expect((await getAssistant(ws.assistant.id))!.max_call_minutes).toBe(30)
  })
})

describe('languages follow the voice the call speaks with', () => {
  test('Hungarian with Eleven Multilingual v2 is refused; with Flash v2.5 it is fine', async () => {
    const ws = await createWorkspace('Language Voice Plumbing')
    await setAllow(ws.owner, true)
    const update = (input: Record<string, unknown>) =>
      act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, ...input })
    const flash = { provider: 'elevenlabs', voice_id: 'cgSgspJ2msm6clMCkdW9', model: 'eleven_flash_v2_5' }
    const multilingual = { ...flash, model: 'eleven_multilingual_v2' }
    expect((await update({ voice: flash, languages: { main: 'en', mode: 'allowed', allowed: ['hu'] } })).status).toBe(200)
    // Changing the voice checks the languages again: Multilingual v2 does not speak Hungarian.
    const refused = await update({ voice: multilingual })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/eleven_multilingual_v2.*can't speak Hungarian/)
    expect((await update({ voice: multilingual, languages: { main: 'en', mode: 'allowed', allowed: ['pl'] } })).status).toBe(200)
  })
})
