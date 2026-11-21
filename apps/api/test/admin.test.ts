// The admin area: who gets in, what never leaves (secrets), and the rules of its actions.
// Instance admins and provider keys are global to the database, so every test that creates
// them lives in this one file (files run in parallel, tests in a file do not).
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  actions,
  PROMPT_OVERRIDE_MAX,
  PROMPT_TEXTS,
  REDACTED,
  recordingKey,
  ZAPIER_APP_SETTING,
} from '@linedesk/actions'
import {
  admin_devices,
  api_keys,
  assistants,
  auth_events,
  call_evaluations,
  calls,
  commands,
  instance_settings,
  invitation,
  ledger_entries,
  member as memberTable,
  number_purchases,
  organization,
  passkey,
  phone_numbers,
  prompt_overrides,
  provider_settings,
  push_subscriptions,
  session,
  setup_emails,
  setup_events,
  usage_counters,
  user,
  voice_clones,
} from '@linedesk/db'
import { APIError } from 'better-auth/api'
import { and, eq, getTableName, inArray, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { mapOidcProfile } from '../src/account-linking.ts'
import {
  adminSignInEmail,
  alertInstanceAdmins,
  alertOnAdminSignIn,
  browserOf,
  isLocalInstance,
  plainSnippet,
} from '../src/admin-alerts.ts'
import { deviceCookie, deviceHash, pruneOldAdminDevices } from '../src/admin-devices.ts'
import { adminHandlers } from '../src/admin-handlers.ts'
import { costEstimate } from '../src/admin-overview.ts'
import {
  adminSecondFactorGap,
  adminSecondFactorRequired,
  markPasskeySession,
  noteUserVerified,
  passkeysOffWarning,
  secondFactorOffWarning,
} from '../src/admin-second-factor.ts'
import { mayReceiveEnrolmentCode } from '../src/admin-step-up.ts'
import { signInMethod } from '../src/audit.ts'
import { auth } from '../src/auth.ts'
import { brandName, decodeLogo, resetBranding } from '../src/branding.ts'
import { notifyCallFinished } from '../src/call-notifications.ts'
import { CLIENT_IP_HEADER } from '../src/client-ip.ts'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import type { Email, EmailSender } from '../src/email.ts'
import { emailSender, sendNotice } from '../src/email.ts'
import { adminAlertEmail, passkeysResetAlert } from '../src/emails/alerts.ts'
import { signInCodeEmail } from '../src/emails/templates.ts'
import { mayRunWhileImpersonating } from '../src/impersonation-guard.ts'
import {
  createAdminWithPassword,
  grantFirstUser,
  instanceAdminEmails,
  instanceAdminHooks,
  refuseUnverifiedAdminAddress,
} from '../src/instance-admin.ts'
import { loadInstanceEnv } from '../src/instance-env.ts'
import { SPENDING_CAP_ALERT, setJobQueue } from '../src/jobs.ts'
import { issueFirstPasskeyEnrolment, issuePasskeyEnrolment } from '../src/passkey-enrolment.ts'
import { installLanguageOptions, telephonyProvider } from '../src/provider-settings.ts'
import { deleteExpiredRecordings } from '../src/recording-retention.ts'
import { recordingStoreCache } from '../src/recording-store.ts'
import { runAction } from '../src/run-action.ts'
import { markSetupSignIn } from '../src/setup.ts'
import { forgetTests } from '../src/setup-checklist.ts'
import { atRiskWorkspaces, sendDueSetupEmails, workspacesOldEnough } from '../src/setup-emails.ts'
import { countSignInFailures, limitSignIns } from '../src/sign-in-limits.ts'
import { mayCreateUser } from '../src/signup-gate.ts'
import { sendSpendingAlert } from '../src/spending-cap.ts'
import { lockActiveSender } from '../src/team.ts'
import { TEST_CALLS_OVER_CAP } from '../src/test-call.ts'
import { KEPT_TABLES, workspaceTables } from '../src/workspace-delete.ts'
import { fakeS3 } from './fake-s3.ts'
import {
  act,
  addMember,
  agent,
  anonymous,
  appRequest,
  type Caller,
  createWorkspace,
  FROM,
  getCall,
  randomIp,
  request,
  signUp,
  type User,
  type Workspace,
} from './helpers.ts'

const SECRET = 'KEY-made-up-0123456789-abcd'
const adminRoutes = [
  '/v1/admin/workspaces',
  '/v1/admin/users',
  '/v1/admin/usage',
  '/v1/admin/providers',
  '/v1/admin/system',
  '/v1/admin/overview',
  '/v1/admin/health',
  '/v1/admin/onboarding',
  '/v1/admin/funnel',
  '/v1/admin/install-setup',
  '/v1/admin/call-reviews',
] as const
const AGENT_ROUTE = '/v1/agent/provider-config'
const adminActions = [...actions.values()].filter(def => def.permission === 'instance:admin')

let home: Workspace // the operator's own workspace
let other: Workspace // a customer: its owner is no instance admin
let operator: User
let member: User // a member of `other`

const setAdmin = (who: User, instanceAdmin: boolean) =>
  db.update(user).set({ instanceAdmin }).where(eq(user.id, who.userId))
const emailOf = async (who: User) => (await db.select().from(user).where(eq(user.id, who.userId)))[0]!.email
const signIn = async (who: User) =>
  request(
    anonymous,
    'POST',
    '/api/auth/sign-in/email',
    { email: await emailOf(who), password: 'test-password-1234' },
    { origin: 'http://localhost:5173', [FROM]: randomIp() },
  )
const providers = async (who: Caller = operator) => (await request(who, 'GET', '/v1/admin/providers')).body
const fieldOf = async (provider: string, field: string) =>
  (await providers()).providers
    .find((p: { provider: string }) => p.provider === provider)
    .fields.find((f: { field: string }) => f.field === field)
const clearAll = async () => {
  await db.delete(provider_settings)
  await db.delete(instance_settings)
}

beforeAll(async () => {
  home = await createWorkspace('Linedesk Operations')
  other = await createWorkspace('Brightwater Plumbing & Heating')
  operator = home.owner
  await setAdmin(operator, true)
  member = await addMember(other.id, 'member')
})

describe('access', () => {
  test('instance admin is not a workspace role: /v1/me shows it for the operator only', async () => {
    expect((await request(operator, 'GET', '/v1/me')).body.permissions).toContain('instance:admin')
    const owner = (await request(other.owner, 'GET', '/v1/me')).body
    expect(owner.role).toBe('owner')
    expect(owner.permissions).not.toContain('instance:admin')
    expect((await request(agent(home.id), 'GET', '/v1/me')).body.permissions).not.toContain('instance:admin')
  })

  test.each(adminRoutes)('GET %s: operator only', async path => {
    expect((await request(operator, 'GET', path)).status).toBe(200)
    expect(await request(other.owner, 'GET', path)).toMatchObject({
      status: 403,
      body: { ok: false, error: 'missing permission instance:admin' },
    })
    expect((await request(member, 'GET', path)).status).toBe(403)
    expect((await request(agent(other.id), 'GET', path)).status).toBe(403)
    expect((await request(agent(), 'GET', path)).status).toBe(403)
    expect((await request(anonymous, 'GET', path)).status).toBe(401)
  })

  test('the registry has the admin actions', () => {
    expect(adminActions.map(def => def.name).sort()).toEqual([
      'afterCallTranscript.get',
      'afterCallTranscript.set',
      'agentSetup.createKey',
      'billing.adminBill',
      'billing.adminBills',
      'billing.adminEvents',
      'billing.adminReview',
      'billing.adminSetStatus',
      'billing.adminSummary',
      'billing.adminTaxAddressMissing',
      'billing.credit',
      'billing.moveWorkspace',
      'billing.recordPortOut',
      'billing.refund',
      'billing.reprocessEvent',
      'billing.reviewHold',
      'billing.setCap',
      'billing.setConcurrency',
      'billing.transferOwner',
      'billingEnabled.get',
      'billingEnabled.set',
      'billingRules.get',
      'billingRules.set',
      'branding.set',
      'calendarTools.get',
      'calendarTools.set',
      'callQuality.get',
      'callQuality.set',
      'feedback.resend',
      'feedback.setupReports',
      'founderEmail.get',
      'founderEmail.set',
      'germanNumbers.get',
      'germanNumbers.group',
      'germanNumbers.set',
      'install.setProgress',
      'instanceAdmin.grant',
      'instanceAdmin.revoke',
      'invitation.resend',
      'invitation.revoke',
      'membership.add',
      'membership.remove',
      'membership.setRole',
      'outboundCountries.get',
      'outboundCountries.set',
      'partner.adminList',
      'partner.adminMoveClient',
      'partner.approve',
      'partner.create',
      'partner.setClientLimit',
      'partner.suspend',
      'partnerBrand.approve',
      'partnerBrand.protectedNames',
      'partnerBrand.reset',
      'partnerBrand.reviews',
      'partnerBrand.setProtectedNames',
      'partnerDomain.adminRemove',
      'partnerKeys.adminDisable',
      'partnerKeys.adminEnable',
      'partnerSender.adminRemove',
      'provider.clearKeys',
      'provider.confirmEmail',
      'provider.connectOneKey',
      'provider.setActive',
      'provider.setKeys',
      'provider.test',
      'provider.tryOut',
      'setupEmails.get',
      'setupEmails.set',
      'signup.getSelfServe',
      'signup.setRules',
      'signup.setSelfServe',
      'signupAccess.get',
      'signupAccess.set',
      'systemPrompt.get',
      'systemPrompt.resetPart',
      'systemPrompt.setPart',
      'user.disable',
      'user.enable',
      'user.impersonate',
      'user.invite',
      'user.issuePasskeyEnrolment',
      'user.resetPasskeys',
      'voiceCloning.get',
      'voiceCloning.set',
      'workspace.create',
      'workspace.delete',
      'workspace.disable',
      'workspace.enable',
      'workspace.setSpendingCap',
      'zapierApp.get',
      'zapierApp.set',
    ])
  })

  // user.impersonate only runs through its own route: see describe('impersonation').
  test.each(adminActions.map(def => def.name).filter(name => name !== 'user.impersonate'))(
    '%s: 403 for a workspace owner, a member and the agent, and nothing changes',
    async name => {
      const input = {
        provider: 'openai',
        category: 'llm',
        values: { api_key: SECRET },
        apiKey: SECRET,
        userId: operator.userId,
        workspaceId: home.id,
        role: 'owner',
        memberId: 'any',
        invitationId: 'any',
      }
      for (const who of [other.owner, member, agent(home.id), agent()]) {
        expect(await act(who, name, input), name).toMatchObject({
          status: 403,
          body: { ok: false, error: 'missing permission instance:admin' },
        })
      }
      expect((await request(anonymous, 'POST', `/v1/actions/${name}`, input)).status).toBe(401)
      expect(await db.select().from(provider_settings)).toEqual([])
      const [account] = await db.select().from(user).where(eq(user.id, operator.userId))
      expect(account).toMatchObject({ instanceAdmin: true, disabledAt: null })
      expect((await db.select().from(organization).where(eq(organization.id, home.id)))[0]?.disabledAt).toBeNull()
    },
  )

  test('an instance admin without a workspace reaches the admin area and nothing else', async () => {
    const loner = await signUp()
    expect((await request(loner, 'GET', '/v1/me')).status).toBe(401)
    await setAdmin(loner, true)
    expect((await request(loner, 'GET', '/v1/me')).body).toMatchObject({
      permissions: ['instance:admin', 'setupLink:end', 'secondFactor:own', 'account:own'],
      workspace: null,
    })
    expect((await request(loner, 'GET', '/v1/admin/users')).status).toBe(200)
    expect((await act(loner, 'call.markDone', { callId: other.call.id })).status).toBe(403)
    expect((await request(loner, 'GET', '/v1/shape/calls?offset=-1')).status).toBe(404)
    await setAdmin(loner, false)
    expect((await request(loner, 'GET', '/v1/admin/users')).status).toBe(401)
  })

  test('an instance admin creates a workspace; anyone else is refused', async () => {
    const loner = await signUp()
    try {
      expect((await request(loner, 'POST', '/v1/workspaces', { name: 'Not Allowed Yet' })).body).toMatchObject({
        code: 'workspace_creation_closed',
      })
      await setAdmin(loner, true)
      const created = await request(loner, 'POST', '/v1/workspaces', { name: 'Operator Workspace' })
      expect(created).toMatchObject({ status: 200, body: { ok: true, workspace: { name: 'Operator Workspace' } } })
    } finally {
      await setAdmin(loner, false)
    }
  })
})

describe('Zapier app link', () => {
  const INVITE = 'https://zapier.com/developer/invite/1/abc/'
  afterAll(() => db.delete(instance_settings).where(eq(instance_settings.key, ZAPIER_APP_SETTING)))

  test('none by default; an instance admin sets and clears it, workspaces read it in integration.list, audited', async () => {
    expect((await act(operator, 'zapierApp.get', {})).body.data).toEqual({ url: null })
    expect((await act(other.owner, 'integration.list', {})).body.data.appUrl).toBeNull()
    expect((await act(other.owner, 'zapierApp.set', { url: INVITE })).status).toBe(403)
    expect((await act(operator, 'zapierApp.set', { url: INVITE })).body.data).toEqual({ url: INVITE })
    expect((await act(operator, 'zapierApp.get', {})).body.data).toEqual({ url: INVITE })
    expect((await act(other.owner, 'integration.list', {})).body.data.appUrl).toBe(INVITE)
    const audit = (await request(operator, 'GET', '/v1/admin/audit?kind=admin')).body.entries as { what: string }[]
    expect(audit.some(e => e.what === 'zapierApp.set')).toBe(true)
    expect((await act(operator, 'zapierApp.set', { url: null })).body.data).toEqual({ url: null })
    expect((await act(other.owner, 'integration.list', {})).body.data.appUrl).toBeNull()
  })

  test('only an https link on zapier.com', async () => {
    for (const url of [
      'http://zapier.com/x',
      'https://evil.example/zapier.com',
      'https://zapier.com.evil.example/',
      'nope',
    ])
      expect((await act(operator, 'zapierApp.set', { url })).status, url).toBe(422)
    expect(
      (await act(operator, 'zapierApp.set', { url: 'https://zapier.com/apps/linedesk/integrations' })).status,
    ).toBe(200)
  })
})

describe('provider keys', () => {
  const logs = ['log', 'info', 'warn', 'error', 'debug'].map(level => vi.spyOn(console, level as 'log'))
  const logged = () => JSON.stringify(logs.flatMap(spy => spy.mock.calls))
  const envBefore = { ...process.env }
  afterEach(async () => {
    process.env = { ...envBefore }
    vi.unstubAllGlobals()
    await clearAll()
  })
  afterAll(() => logs.forEach(spy => spy.mockRestore()))

  test('a stored secret never comes back: not in a response, the command log, the table or a log line', async () => {
    const key = crypto.randomUUID()
    const set = await act(
      operator,
      'provider.setKeys',
      { provider: 'telnyx', values: { api_key: SECRET, public_key: 'cHVibGljLWtleQ==' } },
      key,
    )
    expect(set.status).toBe(200)
    expect(set.body.data.provider.fields).toMatchObject([
      {
        field: 'api_key',
        secret: true,
        source: 'app',
        last4: 'abcd',
        value: null,
        updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
        updated_by: { id: operator.userId, name: 'Test User' },
      },
      { field: 'public_key', secret: false, source: 'app', last4: null, value: 'cHVibGljLWtleQ==' },
      { field: 'check_number', secret: false, source: null, value: null },
    ])
    const replay = await act(operator, 'provider.setKeys', { provider: 'telnyx', values: { api_key: SECRET } }, key)
    const invalid = await act(operator, 'provider.setKeys', { provider: 'telnyx', values: { api_secret: SECRET } })
    expect(invalid.status).toBe(422)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ errors: [{ detail: `bad key ${SECRET}` }] }), { status: 500 })),
    )
    const tested = await act(operator, 'provider.test', { provider: 'telnyx' })
    expect(tested.body.data).toMatchObject({
      ok: false,
      status: 'error',
      reason: 'network',
      message: expect.stringMatching(/^Telnyx did not answer or failed on its side \(HTTP 500\)/),
    })

    const [command] = await db.select().from(commands).where(eq(commands.id, key))
    expect(command?.input).toEqual({ provider: 'telnyx', values: { api_key: REDACTED, public_key: REDACTED } })
    const stored = await db.select().from(provider_settings)
    expect(stored).toHaveLength(2)
    const everything = JSON.stringify([
      set.body,
      replay.body,
      invalid.body,
      tested.body,
      await providers(),
      (await request(operator, 'GET', '/v1/me')).body,
      await db.select().from(commands).where(eq(commands.actor_id, operator.userId)),
      stored,
    ])
    expect(everything).not.toContain(SECRET)
    expect(everything).not.toContain(SECRET.slice(0, 12))
    expect(logged()).not.toContain(SECRET)
  })

  test('a short secret shows no last characters', async () => {
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: 'short-key' } })
    expect(await fieldOf('deepgram', 'api_key')).toMatchObject({ source: 'app', last4: null })
  })

  test('the stored value wins, the environment is the fallback, and the agent gets the value in effect', async () => {
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: null, last4: null, updated_at: null })
    const config = () => request(agent(), 'GET', AGENT_ROUTE)
    // Nothing set up: the agent can start and gets nothing to work with yet.
    expect((await config()).body).toEqual({
      stt: null,
      llm: null,
      tts: null,
      realtime: null,
      tts_providers: [],
      recording: null,
    })

    process.env.OPENAI_API_KEY = 'env-openai-key-0123456789'
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: 'env', last4: null, value: null })
    // A provider holds only its key (decision of 2026-11-18): no model, voice or summary model field.
    expect(
      (await providers()).providers
        .find((p: { provider: string }) => p.provider === 'openai')
        .fields.map((f: { field: string }) => f.field),
    ).toEqual(['api_key'])
    expect(JSON.stringify(await providers())).not.toContain('env-openai-key')
    expect((await config()).body).toEqual({
      stt: null,
      llm: { provider: 'openai', api_key: 'env-openai-key-0123456789' },
      tts: null,
      realtime: null,
      tts_providers: [],
      recording: null,
    })

    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: 'app', last4: 'abcd' })
    expect((await config()).body.llm).toEqual({ provider: 'openai', api_key: SECRET })

    expect((await act(operator, 'provider.clearKeys', { provider: 'openai' })).status).toBe(200)
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: 'env' })
    expect((await config()).body.llm.api_key).toBe('env-openai-key-0123456789')
  })

  test('AssemblyAI answering with Deepgram set up too: the agent gets Deepgram as its fallback, and every language is offered (LIN-656)', async () => {
    const config = async () => (await request(agent(), 'GET', AGENT_ROUTE)).body
    // A voice provider that speaks Polish; without one the install offers only Flux's 10 (spokenLanguages).
    await act(operator, 'provider.setKeys', {
      provider: 'elevenlabs',
      values: { api_key: 'elevenlabs-key-0123456789' },
    })
    expect((await installLanguageOptions(db)).languages).toContain('pl')
    await act(operator, 'provider.setKeys', {
      provider: 'assemblyai_stt',
      values: { api_key: 'assemblyai-key-0123456789' },
    })
    expect((await act(operator, 'provider.setActive', { category: 'stt', provider: 'assemblyai_stt' })).status).toBe(
      200,
    )
    expect((await config()).stt_fallback).toBeUndefined()
    expect((await installLanguageOptions(db)).languages).not.toContain('pl')
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: 'deepgram-key-0123456789' } })
    expect((await config()).stt_fallback).toEqual({ provider: 'deepgram', api_key: 'deepgram-key-0123456789' })
    expect((await installLanguageOptions(db)).languages).toContain('pl')
    // Deepgram itself answering: no fallback.
    await act(operator, 'provider.setActive', { category: 'stt', provider: 'deepgram' })
    expect((await config()).stt_fallback).toBeUndefined()
    await act(operator, 'provider.setActive', { category: 'stt', provider: null })
    await act(operator, 'provider.clearKeys', { provider: 'assemblyai_stt' })
    await act(operator, 'provider.clearKeys', { provider: 'deepgram' })
    await act(operator, 'provider.clearKeys', { provider: 'elevenlabs' })
  })

  test('per category one provider is active: the first that is set up, or the one the admin picks', async () => {
    const active = async () => (await providers()).active
    const config = async () => (await request(agent(), 'GET', AGENT_ROUTE)).body
    expect(await active()).toEqual({
      telephony: { provider: null, chosen: false },
      stt: { provider: null, chosen: false },
      llm: { provider: null, chosen: false },
      tts: { provider: null, chosen: false },
      realtime: { provider: null, chosen: false },
      email: { provider: null, chosen: false },
      sign_in: { provider: null, chosen: false },
      recording: { provider: null, chosen: false },
      transcript: { provider: null, chosen: false },
      business: { provider: null, chosen: false },
      billing: { provider: null, chosen: false },
      apps: { provider: null, chosen: false },
      bot_check: { provider: null, chosen: false },
      domains: { provider: null, chosen: false },
    })

    // Only OpenRouter is set up: it is used although OpenAI, the default, comes first in the registry.
    await act(operator, 'provider.setKeys', {
      provider: 'openrouter',
      values: { api_key: 'or-made-up-0123456789' },
    })
    expect((await active()).llm).toEqual({ provider: 'openrouter', chosen: false })
    expect((await config()).llm).toEqual({
      provider: 'openrouter',
      api_key: 'or-made-up-0123456789',
      // Not set: the agent asks OpenRouter for zero data retention (on unless "false").
      zero_data_retention: null,
    })
    // Both set up: the first one, OpenAI.
    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect((await active()).llm).toEqual({ provider: 'openai', chosen: false })

    const picked = await act(operator, 'provider.setActive', { category: 'llm', provider: 'openrouter' })
    expect(picked.body.data.active.llm).toEqual({ provider: 'openrouter', chosen: true })
    expect((await config()).llm).toMatchObject({ provider: 'openrouter', api_key: 'or-made-up-0123456789' })

    // OpenAI picked without a key of its own: it uses the OpenAI key stored for the realtime model.
    const realtimeKey = 'sk-realtime-made-up-0123456789'
    await act(operator, 'provider.clearKeys', { provider: 'openai' })
    await act(operator, 'provider.setKeys', { provider: 'openai_realtime', values: { api_key: realtimeKey } })
    await act(operator, 'provider.setActive', { category: 'llm', provider: 'openai' })
    expect((await config()).llm).toEqual({ provider: 'openai', api_key: realtimeKey })
    // Disconnecting the realtime model ends that use too; OpenAI gets its own key back for the rest of this test.
    await act(operator, 'provider.clearKeys', { provider: 'openai_realtime' })
    expect((await config()).llm).toBeNull()
    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect((await config()).llm).toEqual({ provider: 'openai', api_key: SECRET })

    // A picked provider that is not set up gives the agent nothing, instead of silently using another one.
    await act(operator, 'provider.setActive', { category: 'tts', provider: 'elevenlabs' })
    await act(operator, 'provider.setKeys', {
      provider: 'cartesia',
      values: { api_key: 'cartesia-made-up-0123456789' },
    })
    expect((await active()).tts).toEqual({ provider: 'elevenlabs', chosen: true })
    expect((await config()).tts).toBeNull()

    expect((await act(operator, 'provider.setActive', { category: 'tts', provider: null })).status).toBe(200)
    expect((await config()).tts).toEqual({
      provider: 'cartesia',
      api_key: 'cartesia-made-up-0123456789',
    })
    expect((await act(operator, 'provider.setActive', { category: 'tts', provider: 'deepgram' })).status).toBe(422)
  })

  test('a connected realtime model answers calls; disconnecting it goes back to the stages', async () => {
    const config = async () => (await request(agent(), 'GET', AGENT_ROUTE)).body
    const realtimeFlag = async () => (await act(home.owner, 'voice.options', {})).body.data.realtime
    // OPENAI_API_KEY is the language model's: it does not switch calls to realtime.
    process.env.OPENAI_API_KEY = 'env-openai-key-0123456789'
    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect((await config()).realtime).toBeNull()
    expect(await realtimeFlag()).toBe(false)

    await act(operator, 'provider.setKeys', {
      provider: 'openai_realtime',
      values: { api_key: SECRET },
    })
    expect((await providers()).active.realtime).toEqual({ provider: 'openai_realtime', chosen: false })
    expect((await config()).realtime).toEqual({
      provider: 'openai_realtime',
      api_key: SECRET,
    })
    expect((await config()).llm).toMatchObject({ provider: 'openai' })
    expect(await realtimeFlag()).toBe(true)

    expect((await act(operator, 'provider.clearKeys', { provider: 'openai_realtime' })).status).toBe(200)
    expect((await config()).realtime).toBeNull()
    expect(await realtimeFlag()).toBe(false)
    expect((await act(operator, 'provider.setActive', { category: 'realtime', provider: 'openai' })).status).toBe(422)
  })

  test('email and sign-in apps are stored like other keys and loaded as variables at start', async () => {
    const smtp = 'smtps://user:smtp-password-made-up@smtp.example.com:465'
    expect(
      (
        await act(operator, 'provider.setKeys', {
          provider: 'smtp',
          values: { url: smtp, from: 'Desk <desk@example.com>' },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await act(operator, 'provider.setKeys', {
          provider: 'google',
          values: { client_id: 'gid', client_secret: SECRET },
        })
      ).status,
    ).toBe(200)
    expect(
      (await act(operator, 'provider.setKeys', { provider: 'smtp', values: { url: 'https://smtp.example.com' } }))
        .status,
    ).toBe(422)
    expect(
      (
        await act(operator, 'provider.setKeys', {
          provider: 'oidc',
          values: { discovery_url: 'http://id.example.com' },
        })
      ).status,
    ).toBe(422)
    // Every sign-in app that is set up is in use; there is nothing to pick.
    expect((await act(operator, 'provider.setActive', { category: 'sign_in', provider: 'google' })).status).toBe(422)
    const env: Record<string, string | undefined> = { SMTP_URL: 'smtp://from-the-server', GITHUB_CLIENT_ID: 'kept' }
    await loadInstanceEnv(db, env)
    expect(env).toMatchObject({
      SMTP_URL: smtp,
      EMAIL_FROM: 'Desk <desk@example.com>',
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: SECRET,
      GITHUB_CLIENT_ID: 'kept',
    })
    expect(logged()).not.toContain(SECRET)
    expect(logged()).not.toContain('smtp-password-made-up')
  })

  test('push keys are made once, stored encrypted and the same for every start', async () => {
    const first: Record<string, string | undefined> = {}
    await loadInstanceEnv(db, first)
    expect(first.VAPID_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{80,}$/)
    expect(first.VAPID_PRIVATE_KEY).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    const stored = await db.select().from(instance_settings).where(eq(instance_settings.key, 'push.vapid_private_key'))
    expect(stored[0]?.value).not.toContain(first.VAPID_PRIVATE_KEY)
    const second: Record<string, string | undefined> = {}
    await loadInstanceEnv(db, second)
    expect(second.VAPID_PUBLIC_KEY).toBe(first.VAPID_PUBLIC_KEY)
    expect(second.VAPID_PRIVATE_KEY).toBe(first.VAPID_PRIVATE_KEY)
    // Keys set on the server win.
    const own: Record<string, string | undefined> = { VAPID_PUBLIC_KEY: 'own-public', VAPID_PRIVATE_KEY: 'own-private' }
    await loadInstanceEnv(db, own)
    expect(own).toMatchObject({ VAPID_PUBLIC_KEY: 'own-public', VAPID_PRIVATE_KEY: 'own-private' })
  })

  test('the clear values go to the agent token only', async () => {
    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    for (const who of [operator, other.owner]) {
      const res = await request(who, 'GET', AGENT_ROUTE)
      expect(res).toMatchObject({ status: 403, body: { ok: false, error: 'missing permission agent' } })
      expect(JSON.stringify(res.body)).not.toContain(SECRET)
    }
    expect((await request(anonymous, 'GET', AGENT_ROUTE)).status).toBe(401)
    expect((await request(agent(undefined, 'wrong-token'), 'GET', AGENT_ROUTE)).status).toBe(401)
    expect((await request(agent(other.id), 'GET', AGENT_ROUTE)).body.llm).toMatchObject({
      provider: 'openai',
      api_key: SECRET,
    })
  })

  test('without SECRETS_KEY saving is refused with the reason, and nothing is stored', async () => {
    delete process.env.SECRETS_KEY
    const res = await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^SECRETS_KEY is not set, so keys cannot be stored/)
    expect(await db.select().from(provider_settings)).toEqual([])
    expect((await providers()).can_store).toBe(false)
    // The rejected command is logged too, redacted like an accepted one.
    const logged = await db.select().from(commands).where(eq(commands.actor_id, operator.userId))
    const rejected = logged.filter(c => c.rejected && c.action === 'provider.setKeys')
    expect(rejected.at(-1)?.input).toEqual({ provider: 'openai', values: { api_key: REDACTED } })
    expect(JSON.stringify(logged)).not.toContain(SECRET)
  })

  test('with another SECRETS_KEY the stored keys are reported as unreadable, not used and not leaked', async () => {
    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    process.env.SECRETS_KEY = randomBytes(32).toString('base64')
    const tested = await act(operator, 'provider.test', { provider: 'openai' })
    expect(tested.status).toBe(409)
    expect(tested.body.error).toMatch(/openai.api_key cannot be decrypted/)
    expect(await request(agent(), 'GET', AGENT_ROUTE)).toMatchObject({ status: 409, body: { ok: false } })
    expect(await fieldOf('openai', 'api_key')).toMatchObject({ source: 'app', last4: 'abcd' })
  })

  test("a workspace's own carrier is refused while the install's carrier keys cannot be read: the same-account check cannot run", async () => {
    const sid = `AC${'c3'.repeat(16)}`
    await act(operator, 'provider.setKeys', { provider: 'twilio', values: { account_sid: sid, auth_token: SECRET } })
    process.env.SECRETS_KEY = randomBytes(32).toString('base64')
    const res = await act({ headers: { ...other.owner.headers, 'x-workspace-id': other.id } }, 'carrier.set', {
      carrier: 'twilio',
      values: { account_sid: `AC${'d4'.repeat(16)}`, auth_token: 'workspace-token-0123456789' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(
      'Your carrier account cannot be checked against this Linedesk right now. Ask whoever runs your Linedesk.',
    )
  })

  test('test connection: ok, a rejected key, and keys that are not set; it is not logged as a command', async () => {
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(commands)
      .where(eq(commands.actor_id, operator.userId))
    expect((await act(operator, 'provider.test', { provider: 'cartesia' })).body.data).toMatchObject({
      ok: false,
      reason: 'config',
      message: 'Not set: API key',
    })
    await act(operator, 'provider.setKeys', { provider: 'cartesia', values: { api_key: SECRET } })
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await act(operator, 'provider.test', { provider: 'cartesia' })).body.data).toEqual({
      ok: true,
      status: 'ok',
      message: 'Connected',
    })
    expect(new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('x-api-key')).toBe(
      SECRET,
    )
    await forgetTests(db) // past provider.test's 10 s cooldown for the same keys
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: `Invalid key ${SECRET}` }), { status: 401 })),
    )
    const rejected = await act(operator, 'provider.test', { provider: 'cartesia' })
    expect(rejected.body.data).toMatchObject({
      ok: false,
      reason: 'auth',
      message: expect.stringMatching(/^Cartesia rejected the key \(HTTP 401\)/),
    })
    expect(JSON.stringify(rejected.body)).not.toContain(SECRET)
    const after = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(commands)
      .where(eq(commands.actor_id, operator.userId))
    expect(after[0]!.n - before[0]!.n).toBe(1) // only setKeys
  })

  test('telephony: the provider picked in the admin area, else TELEPHONY_PROVIDER, else dev; keys from the app first', async () => {
    // Nothing set up: no carrier.
    expect((await telephonyProvider(db, {})).name).toBe('dev')
    // TELEPHONY_PROVIDER decides when set; dev means no carrier even with keys.
    expect((await telephonyProvider(db, { TELEPHONY_PROVIDER: 'dev', TELNYX_API_KEY: 'env-key' })).name).toBe('dev')
    await expect(telephonyProvider(db, { TELEPHONY_PROVIDER: 'twilio', TELNYX_API_KEY: 'env-key' })).rejects.toThrow(
      'TWILIO_ACCOUNT_SID',
    )
    await expect(telephonyProvider(db, { TELEPHONY_PROVIDER: 'telnyx' })).rejects.toThrow('TELNYX_API_KEY is not set')

    // Without TELEPHONY_PROVIDER the first carrier that is set up is used: Telnyx before Twilio.
    expect(
      (await telephonyProvider(db, { TWILIO_ACCOUNT_SID: 'ACmadeup', TWILIO_AUTH_TOKEN: 'made-up-token' })).name,
    ).toBe('twilio')
    await act(operator, 'provider.setKeys', { provider: 'telnyx', values: { api_key: SECRET } })
    expect(
      (await telephonyProvider(db, { TWILIO_ACCOUNT_SID: 'ACmadeup', TWILIO_AUTH_TOKEN: 'made-up-token' })).name,
    ).toBe('telnyx')
    expect((await providers()).active.telephony).toEqual({ provider: 'telnyx', chosen: false })
    process.env.TELEPHONY_PROVIDER = 'dev'
    expect((await providers()).active.telephony).toEqual({ provider: null, chosen: false })
    // A pick in the admin area wins over the variable.
    await act(operator, 'provider.setActive', { category: 'telephony', provider: 'telnyx' })
    expect((await telephonyProvider(db, { TELEPHONY_PROVIDER: 'dev' })).name).toBe('telnyx')
  })

  test('without a pick, STT_PROVIDER, LLM_PROVIDER and TTS_PROVIDER name the provider, as for the agent', async () => {
    await act(operator, 'provider.setKeys', { provider: 'openrouter', values: { api_key: 'or-made-up-0123456789' } })
    await act(operator, 'provider.setKeys', { provider: 'openai', values: { api_key: SECRET } })
    expect((await providers()).active.llm).toEqual({ provider: 'openai', chosen: false })
    process.env.LLM_PROVIDER = 'openrouter'
    expect((await providers()).active.llm).toEqual({ provider: 'openrouter', chosen: false })
    expect((await request(agent(), 'GET', AGENT_ROUTE)).body.llm).toEqual({
      provider: 'openrouter',
      api_key: 'or-made-up-0123456789',
      zero_data_retention: null,
    })
    // A named provider without keys gives the agent nothing rather than another provider.
    process.env.TTS_PROVIDER = 'cartesia'
    await act(operator, 'provider.setKeys', { provider: 'elevenlabs', values: { api_key: 'el-made-up-0123456789' } })
    expect((await request(agent(), 'GET', AGENT_ROUTE)).body.tts).toBeNull()
    // A value from another category is ignored.
    process.env.STT_PROVIDER = 'openai'
    expect((await providers()).active.stt).toEqual({ provider: null, chosen: false })
  })

  test('LiveKit is not a provider: no keys in the app, only a status from the environment', async () => {
    expect(
      (await act(operator, 'provider.setKeys', { provider: 'livekit', values: { api_secret: SECRET } })).status,
    ).toBe(422)
    expect((await providers()).providers.map((p: { provider: string }) => p.provider)).toEqual([
      'telnyx',
      'twilio',
      'deepgram',
      'elevenlabs_stt',
      'openai_stt',
      'assemblyai_stt',
      'openai_transcript',
      'deepgram_transcript',
      'assemblyai',
      'elevenlabs_transcript',
      'openai',
      'openrouter',
      'anthropic',
      'gemini',
      'groq',
      'mistral',
      'elevenlabs',
      'cartesia',
      'openai_realtime',
      'file',
      's3',
      'smtp',
      'resend',
      'postmark',
      'sendgrid',
      'brevo',
      'mailgun',
      'gmail',
      'google',
      'microsoft',
      'calendly',
      'calcom',
      'github',
      'oidc',
      'google_places',
      'stripe',
      'hubspot',
      'slack',
      'jobber',
      'zoho',
      'shopify',
      'google_mail',
      'turnstile',
      'cloudflare_saas',
    ])
    process.env.LIVEKIT_URL = 'ws://livekit.env.test:7880'
    process.env.LIVEKIT_API_KEY = 'APImadeup'
    process.env.LIVEKIT_API_SECRET = 'made-up-livekit-secret-0123456789'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(JSON.stringify(url.includes('SIP') ? { items: [{}] } : { rooms: [] }), { status: 200 }),
      ),
    )
    const system = await request(operator, 'GET', '/v1/admin/system')
    expect(system.body).toEqual({
      livekit: {
        url: 'ws://livekit.env.test:7880',
        server: { ok: true, message: 'Reachable, 0 rooms open' },
        sip: { ok: true, message: '1 inbound trunk configured' },
      },
    })
    expect(JSON.stringify(system.body)).not.toContain('made-up-livekit-secret')
  })
})

describe('recording storage', () => {
  const S3_SECRET = 's3-secret-made-up-0123456789'
  const s3Keys = {
    endpoint: 'https://s3.test',
    region: 'auto',
    bucket: 'calls',
    access_key_id: 'AKIA-made-up-key-id',
    secret_access_key: S3_SECRET,
    prefix: 'linedesk',
  }
  const envBefore = { ...process.env }
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'linedesk-recording-admin-'))
  })
  afterEach(async () => {
    process.env = { ...envBefore }
    vi.unstubAllGlobals()
    await clearAll()
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  const agentConfig = async () => (await request(agent(), 'GET', AGENT_ROUTE)).body
  const recordingOn = async (who: Caller = home.owner) =>
    (await act(who, 'workspace.getSettings', {})).body.data.recordingOn
  /** A finished call of `home` with a recording in `store` (null: recorded before stores were per call). */
  async function recordedCall(store: 'file' | 's3' | null) {
    const id = `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
    const key = recordingKey(home.id, id)
    await db.insert(calls).values({
      id,
      workspace_id: home.id,
      from_number: '+15035550100',
      to_number: home.number,
      status: 'completed',
      recording_key: key,
      recording_store: store,
    })
    if (store !== 's3') {
      await mkdir(join(dir, home.id), { recursive: true })
      await writeFile(join(dir, key), `audio of ${id}`)
    }
    return { id, key }
  }
  const play = (callId: string) => appRequest(`/v1/calls/${callId}/recording`, { headers: home.owner.headers })

  test('off until a store is picked or RECORDING_STORE names one; the local disk needs no keys', async () => {
    expect((await providers()).active.recording).toEqual({ provider: null, chosen: false })
    expect((await agentConfig()).recording).toBeNull()
    expect(await recordingOn()).toBe(false)

    process.env.RECORDING_STORE = 'file'
    expect((await providers()).active.recording).toEqual({ provider: 'file', chosen: false })
    expect((await agentConfig()).recording).toEqual({ provider: 'file' })
    expect(await recordingOn()).toBe(true)

    delete process.env.RECORDING_STORE
    expect((await act(operator, 'provider.setActive', { category: 'recording', provider: 'file' })).status).toBe(200)
    expect((await agentConfig()).recording).toEqual({ provider: 'file' })
    expect(await recordingOn()).toBe(true)
    expect((await act(operator, 'provider.setActive', { category: 'recording', provider: 'openai' })).status).toBe(422)
  })

  test('S3 settings: the stored value wins over S3_*, the env is the fallback; a picked S3 that is not set up records nothing', async () => {
    await act(operator, 'provider.setActive', { category: 'recording', provider: 's3' })
    expect((await agentConfig()).recording).toBeNull()

    Object.assign(process.env, {
      S3_ENDPOINT: 'https://env.s3.test',
      S3_BUCKET: 'env-bucket',
      S3_ACCESS_KEY_ID: 'env-key-id',
      S3_SECRET_ACCESS_KEY: 'env-secret-0123456789',
    })
    expect((await agentConfig()).recording).toEqual({
      provider: 's3',
      endpoint: 'https://env.s3.test',
      region: null,
      bucket: 'env-bucket',
      access_key_id: 'env-key-id',
      prefix: null,
      force_path_style: null,
    })
    expect(await fieldOf('s3', 'secret_access_key')).toMatchObject({ source: 'env', value: null, last4: null })

    expect((await act(operator, 'provider.setKeys', { provider: 's3', values: s3Keys })).status).toBe(200)
    const { secret_access_key: _secret, ...withoutSecret } = s3Keys
    expect((await agentConfig()).recording).toEqual({ provider: 's3', ...withoutSecret, force_path_style: null })
    expect(await fieldOf('s3', 'bucket')).toMatchObject({ source: 'app', value: 'calls' })
    expect(await fieldOf('s3', 'secret_access_key')).toMatchObject({ source: 'app', value: null, last4: '6789' })
  })

  test('the S3 secret stays with the API: not to the agent, members or the command log', async () => {
    const key = crypto.randomUUID()
    await act(operator, 'provider.setKeys', { provider: 's3', values: s3Keys }, key)
    await act(operator, 'provider.setActive', { category: 'recording', provider: 's3' })
    for (const who of [operator, other.owner, member]) {
      const res = await request(who, 'GET', AGENT_ROUTE)
      expect(res.status).toBe(403)
      expect(JSON.stringify(res.body)).not.toContain(S3_SECRET)
    }
    expect(JSON.stringify(await providers())).not.toContain(S3_SECRET)
    const [command] = await db.select().from(commands).where(eq(commands.id, key))
    expect(JSON.stringify(command?.input)).not.toContain(S3_SECRET)
    expect(JSON.stringify(await db.select().from(provider_settings))).not.toContain(S3_SECRET)
    expect((await agentConfig()).recording).toMatchObject({ provider: 's3', bucket: s3Keys.bucket })
    expect(JSON.stringify(await agentConfig())).not.toContain(S3_SECRET)
  })

  test('setKeys checks the switch, the endpoint and the prefix without echoing them', async () => {
    const wrong = [{ force_path_style: 'yes' }, { endpoint: `ftp://${S3_SECRET}` }, { prefix: `../${S3_SECRET}` }]
    for (const values of wrong) {
      const res = await act(operator, 'provider.setKeys', { provider: 's3', values })
      expect(res.status).toBe(422)
      expect(JSON.stringify(res.body)).not.toContain(S3_SECRET)
    }
    expect(
      (await act(operator, 'provider.setKeys', { provider: 's3', values: { force_path_style: 'false' } })).status,
    ).toBe(200)
  })

  test('test connection: puts, reads back and deletes an object; a refusal names the step, never a key', async () => {
    await act(operator, 'provider.setKeys', { provider: 's3', values: s3Keys })
    const s3 = fakeS3()
    vi.stubGlobal('fetch', s3.fetch)
    expect((await act(operator, 'provider.test', { provider: 's3' })).body.data).toEqual({
      ok: true,
      status: 'ok',
      message: 'Connected',
    })
    expect(s3.log.map(([method]) => method)).toEqual(['PUT', 'GET', 'DELETE'])
    expect(s3.log[0]![1]).toMatch(/^https:\/\/s3\.test\/calls\/linedesk\/\.linedesk-probe-/)
    expect(s3.objects.size).toBe(0)

    await forgetTests(db) // past provider.test's 10 s cooldown for the same keys
    vi.stubGlobal('fetch', fakeS3({ status: 403, code: 'SignatureDoesNotMatch' }).fetch)
    const refused = (await act(operator, 'provider.test', { provider: 's3' })).body.data
    expect(refused.ok).toBe(false)
    expect(refused.message).toBe('Keys rejected (HTTP 403)')
    expect(refused.message).not.toContain(s3Keys.access_key_id)

    await forgetTests(db) // past provider.test's 10 s cooldown for the same keys
    vi.stubGlobal('fetch', fakeS3({ status: 404, code: 'NoSuchBucket' }).fetch)
    expect((await act(operator, 'provider.test', { provider: 's3' })).body.data.message).toBe('Bucket not found')

    await forgetTests(db)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed', { cause: { message: `bad ${S3_SECRET}` } }))),
    )
    const unreachable = (await act(operator, 'provider.test', { provider: 's3' })).body.data
    expect(unreachable).toMatchObject({
      ok: false,
      reason: 'network',
      message: 'Could not reach the storage: bad [redacted]',
    })

    await act(operator, 'provider.clearKeys', { provider: 's3' })
    expect((await act(operator, 'provider.test', { provider: 's3' })).body.data.message).toBe(
      'Not set: Endpoint URL, Bucket, Access key ID, Secret access key',
    )

    process.env.RECORDINGS_DIR = join(dir, 'probe')
    const file = (await act(operator, 'provider.test', { provider: 'file' })).body.data
    expect(file).toEqual({ ok: true, status: 'ok', message: 'Connected' })
  })

  test('after switching to S3, older recordings still play from the local disk; new ones from the bucket', async () => {
    process.env.RECORDINGS_DIR = dir
    const fileCall = await recordedCall('file')
    const legacyCall = await recordedCall(null) // RECORDING_STORE is unset: the local disk
    await act(operator, 'provider.setActive', { category: 'recording', provider: 'file' })
    expect((await play(fileCall.id)).status).toBe(200)

    await act(operator, 'provider.setKeys', { provider: 's3', values: s3Keys })
    await act(operator, 'provider.setActive', { category: 'recording', provider: 's3' })
    expect((await agentConfig()).recording.provider).toBe('s3')
    for (const old of [fileCall, legacyCall]) {
      const res = await play(old.id)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(`audio of ${old.id}`)
    }
    const s3Call = await recordedCall('s3')
    const res = await play(s3Call.id)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe(`https://s3.test/calls/linedesk/${s3Call.key}`)
    expect(location.search).not.toContain(S3_SECRET)

    // Switching back leaves the S3 recording playable from the bucket.
    await act(operator, 'provider.setActive', { category: 'recording', provider: 'file' })
    expect((await play(s3Call.id)).status).toBe(302)
  })

  test('the agent says which store it recorded into; an agent that does not leaves it to RECORDING_STORE', async () => {
    const call = await recordedCall(null)
    await db.update(calls).set({ recording_key: null }).where(eq(calls.id, call.id))
    const set = await act(agent(home.id), 'call.setRecording', { callId: call.id, store: 's3' })
    expect(set.body.rows.calls[0]).toMatchObject({ recording_key: call.key, recording_store: 's3' })
    await act(agent(home.id), 'call.setRecording', { callId: call.id })
    expect((await db.select().from(calls).where(eq(calls.id, call.id)))[0]?.recording_store).toBeNull()
    expect((await act(agent(home.id), 'call.setRecording', { callId: call.id, store: 'ftp' })).status).toBe(422)
  })

  test('retention deletes each recording from the store it is in', async () => {
    process.env.RECORDINGS_DIR = dir
    const fileCall = await recordedCall('file')
    await act(operator, 'provider.setKeys', { provider: 's3', values: s3Keys })
    const s3 = fakeS3()
    vi.stubGlobal('fetch', s3.fetch)
    const s3Call = await recordedCall('s3')
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString()
    await db
      .update(calls)
      .set({ started_at: old, ended_at: old })
      .where(inArray(calls.id, [fileCall.id, s3Call.id]))
    // Only ours: recordings of test files running alongside fail here and keep their key.
    const real = recordingStoreCache(db)
    const ours = new Set([fileCall.key, s3Call.key])
    const deleted: [string | null, string][] = []
    const storeFor = async (name: 'file' | 's3' | null) => {
      const store = await real(name)
      return {
        ...store,
        delete: async (key: string) => {
          if (!ours.has(key)) throw new Error('a recording of another test file')
          deleted.push([name, key])
          await store.delete(key)
        },
      }
    }
    for (let i = 0; i < 5 && deleted.length < 2; i++) await deleteExpiredRecordings(db, storeFor)
    expect(deleted.sort()).toEqual([
      ['file', fileCall.key],
      ['s3', s3Call.key],
    ])
    expect(s3.log).toContainEqual(['DELETE', `https://s3.test/calls/linedesk/${s3Call.key}`])
    expect(await readdir(join(dir, home.id))).not.toContain(fileCall.key.split('/')[1])
    const rows = await db
      .select()
      .from(calls)
      .where(inArray(calls.id, [fileCall.id, s3Call.id]))
    expect(rows.map(r => [r.recording_key, r.recording_store])).toEqual([
      [null, null],
      [null, null],
    ])
  })
})

describe('users', () => {
  test('the list shows workspaces, roles and sign-in, and nothing to sign in with', async () => {
    const { users } = (await request(operator, 'GET', '/v1/admin/users')).body
    const row = users.find((u: { id: string }) => u.id === other.owner.userId)
    expect(row).toMatchObject({
      name: 'Test User',
      instance_admin: false,
      disabled_at: null,
      workspaces: [{ id: other.id, name: 'Brightwater Plumbing & Heating', role: 'owner' }],
    })
    expect(Date.now() - Date.parse(row.last_sign_in_at)).toBeLessThan(120_000)
    expect(Date.now() - Date.parse(row.created_at)).toBeLessThan(120_000)
    for (const at of [row.created_at, row.last_sign_in_at]) expect(new Date(at).toISOString()).toBe(at)
    expect(users.find((u: { id: string }) => u.id === operator.userId)).toMatchObject({
      instance_admin: true,
      instance_admin_by_env: false,
    })
    expect(row.avatar_url).toBeNull()
    expect(Object.keys(row).sort()).toEqual([
      // The profile picture's address (null without one): never the image itself.
      'avatar_url',
      'created_at',
      'disabled_at',
      'email',
      'id',
      'instance_admin',
      'instance_admin_by_env',
      'invitations',
      'last_sign_in_at',
      'name',
      // Name, device type and date only: never a credential id or key.
      'passkeys',
      // The terms accepted last (LIN-420): versions, source and time, never the IP address or browser.
      'terms',
      'workspaces',
    ])
  })

  test('a disabled user is signed out and cannot sign in until enabled again', async () => {
    const ws = await createWorkspace('Disabled User Workspace')
    expect((await request(ws.owner, 'GET', '/v1/me')).status).toBe(200)
    expect((await act(operator, 'user.disable', { userId: ws.owner.userId })).status).toBe(200)
    expect(await db.select().from(session).where(eq(session.userId, ws.owner.userId))).toEqual([])
    expect((await request(ws.owner, 'GET', '/v1/me')).status).toBe(401)
    const refused = await signIn(ws.owner)
    expect(refused).toMatchObject({ status: 403, body: { message: 'This account is disabled.' } })
    expect(await db.select().from(session).where(eq(session.userId, ws.owner.userId))).toEqual([])
    const { users } = (await request(operator, 'GET', '/v1/admin/users')).body
    expect(users.find((u: { id: string }) => u.id === ws.owner.userId).disabled_at).toEqual(expect.any(String))

    expect((await act(operator, 'user.enable', { userId: ws.owner.userId })).status).toBe(200)
    expect((await signIn(ws.owner)).status).toBe(200)
  })

  test('disabling an admin cancels the invitations they sent, in every workspace, one audit line each (LIN-441)', async () => {
    const first = await createWorkspace('Disabled Inviter One')
    const second = await createWorkspace('Disabled Inviter Two')
    const sender = await addMember(first.id, 'admin')
    await auth.api.addMember({ body: { userId: sender.userId, organizationId: second.id, role: 'admin' } })
    const sent = await act(sender, 'team.invite', {
      email: `second-self-${randomBytes(4).toString('hex')}@example.com`,
      role: 'admin',
    })
    expect(sent).toMatchObject({ status: 200, body: { ok: true } })
    // One sent earlier in the other workspace (the session's active workspace is the first).
    const elsewhere = `inv_${randomBytes(6).toString('hex')}`
    await db.insert(invitation).values({
      id: elsewhere,
      organizationId: second.id,
      email: `other-${randomBytes(4).toString('hex')}@example.com`,
      role: 'admin',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId: sender.userId,
    })
    const ids = [sent.body.data.invitationId as string, elsewhere]
    const ownersId = (
      await act(first.owner, 'team.invite', {
        email: `kept-${randomBytes(4).toString('hex')}@example.com`,
        role: 'member',
      })
    ).body.data.invitationId as string

    expect((await act(operator, 'user.disable', { userId: sender.userId })).status).toBe(200)
    const rows = await db
      .select()
      .from(invitation)
      .where(inArray(invitation.id, [...ids, ownersId]))
    expect(Object.fromEntries(rows.map(r => [r.id, r.status]))).toEqual({
      [ids[0]!]: 'canceled',
      [ids[1]!]: 'canceled',
      [ownersId]: 'pending',
    })
    for (const id of ids)
      expect((await request(anonymous, 'GET', `/v1/invitations/${encodeURIComponent(id)}`)).body).toEqual({
        status: 'gone',
      })
    const withdrawn = (await db.select().from(auth_events).where(eq(auth_events.user_id, sender.userId))).filter(
      e => e.event === 'invitation_withdrawn',
    )
    expect(withdrawn.map(e => e.workspace_id).sort()).toEqual([first.id, second.id].sort())
  })

  test('an invitation sent while the account is being disabled is cancelled too, and none is sent after (LIN-503)', async () => {
    const ws = await createWorkspace('Racing Inviter')
    const sender = await addMember(ws.id, 'admin')
    const id = `inv_${randomBytes(6).toString('hex')}`
    let release!: () => void
    const held = new Promise<void>(r => (release = r))
    let ready!: () => void
    const inserted = new Promise<void>(r => (ready = r))
    // team.invite's transaction, held open after its insert: the disable must wait for it, then cancel what it sent.
    const inviting = db.transaction(async tx => {
      await lockActiveSender(tx, sender.userId)
      await tx.insert(invitation).values({
        id,
        organizationId: ws.id,
        email: `race-${randomBytes(4).toString('hex')}@example.com`,
        role: 'admin',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: sender.userId,
      })
      ready()
      await held
    })
    await inserted
    const disabling = act(operator, 'user.disable', { userId: sender.userId })
    await new Promise(r => setTimeout(r, 300))
    release()
    await inviting
    expect((await disabling).status).toBe(200)
    expect((await db.select().from(invitation).where(eq(invitation.id, id)))[0]!.status).toBe('canceled')
    // After the disable, the sender's lock refuses (an invite already past sign-in when the account was disabled).
    await expect(db.transaction(tx => lockActiveSender(tx, sender.userId))).rejects.toThrow('this account is disabled')
  })

  test('every sign-in method is blocked for a disabled user: the session hook refuses it', async () => {
    // Password, email link and provider sign-ins all create a session through this hook.
    const ws = await createWorkspace('Hook Workspace')
    await act(operator, 'user.disable', { userId: ws.owner.userId })
    await expect(instanceAdminHooks.session.create.before({ userId: ws.owner.userId })).rejects.toThrow(
      'This account is disabled.',
    )
    await act(operator, 'user.enable', { userId: ws.owner.userId })
    await expect(instanceAdminHooks.session.create.before({ userId: ws.owner.userId })).resolves.toBeUndefined()
  })

  test('nobody disables themselves, and unknown users are rejected', async () => {
    expect(await act(operator, 'user.disable', { userId: operator.userId })).toMatchObject({
      status: 409,
      body: { error: 'you cannot disable your own account' },
    })
    expect(await act(operator, 'user.disable', { userId: 'user_missing' })).toMatchObject({
      status: 409,
      body: { error: 'user not found' },
    })
    expect((await request(operator, 'GET', '/v1/me')).status).toBe(200)
  })
})

describe('workspaces', () => {
  test('the list counts members, numbers, calls and minutes across workspaces', async () => {
    await db.update(calls).set({ status: 'completed', duration_sec: 150 }).where(eq(calls.id, other.call.id))
    const { workspaces } = (await request(operator, 'GET', '/v1/admin/workspaces')).body
    const row = workspaces.find((w: { id: string }) => w.id === other.id)
    expect(row).toMatchObject({
      name: 'Brightwater Plumbing & Heating',
      disabled_at: null,
      members: 2,
      phone_numbers: [other.number],
      calls_30d: 1,
      minutes_this_month: 2.5,
    })
    expect(row.last_call_at).toBe(new Date(other.call.started_at).toISOString())
    expect(new Date(row.created_at).toISOString()).toBe(row.created_at)
    expect(workspaces.some((w: { id: string }) => w.id === home.id)).toBe(true)

    const { usage, months } = (await request(operator, 'GET', '/v1/admin/usage')).body
    expect(months).toBe(6)
    expect(usage.find((u: { workspace_id: string }) => u.workspace_id === other.id)).toEqual({
      workspace_id: other.id,
      workspace_name: 'Brightwater Plumbing & Heating',
      month: new Date().toISOString().slice(0, 7),
      calls: 1,
      minutes: 2.5,
      // No billing entries: no dollars, rather than $0.00.
      charged_micros: null,
    })
  })

  test('in a disabled workspace members keep reading but cannot write or change settings', async () => {
    const ws = await createWorkspace('Read Only Workspace')
    const before = (await request(ws.owner, 'GET', '/v1/me')).body
    expect(before.workspace.disabled).toBe(false)
    expect(before.permissions).toContain('settings:write')

    await act(operator, 'workspace.disable', { workspaceId: ws.id })
    const me = (await request(ws.owner, 'GET', '/v1/me')).body
    expect(me.workspace).toMatchObject({ id: ws.id, disabled: true })
    // Reading, answering invitations to other workspaces, and their own personal keys.
    expect(
      me.permissions.every((p: string) => p.endsWith(':read') || p === 'invitation:respond' || p === 'account:own'),
    ).toBe(true)
    expect(await act(ws.owner, 'call.markDone', { callId: ws.call.id })).toMatchObject({ status: 403 })
    expect(
      await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, greeting: 'still here' }),
    ).toMatchObject({ status: 403 })
    expect(await act(ws.owner, 'phoneNumber.setup', { areaCode: '503' })).toMatchObject({ status: 403 })
    // Reads stay: a read action still runs (here it finds no such appointment type, which is not a 403).
    expect(await act(ws.owner, 'calendar.findSlots', { appointmentTypeId: 'at_missing' })).toMatchObject({
      status: 409,
    })

    await act(operator, 'workspace.enable', { workspaceId: ws.id })
    expect((await act(ws.owner, 'call.markDone', { callId: ws.call.id })).status).toBe(200)
  })

  test('calls to a number of a disabled workspace are not answered', async () => {
    const ws = await createWorkspace('Disabled Workspace')
    const start = () => act(agent(), 'call.start', { from: '+15035550100', to: ws.number })
    const callCount = async () => (await db.select().from(calls).where(eq(calls.workspace_id, ws.id))).length
    expect((await act(operator, 'workspace.disable', { workspaceId: ws.id })).status).toBe(200)
    expect(await start()).toMatchObject({
      status: 409,
      body: { ok: false, error: `the workspace of ${ws.number} is disabled` },
    })
    expect(await callCount()).toBe(1) // the fixture call, nothing new
    const { workspaces } = (await request(operator, 'GET', '/v1/admin/workspaces')).body
    expect(workspaces.find((w: { id: string }) => w.id === ws.id).disabled_at).toEqual(expect.any(String))
    // Other workspaces are not affected.
    expect((await act(agent(), 'call.start', { from: '+15035550100', to: other.number })).status).toBe(200)

    expect((await act(operator, 'workspace.enable', { workspaceId: ws.id })).status).toBe(200)
    expect((await start()).status).toBe(200)
    expect(await callCount()).toBe(2)
    expect(await act(operator, 'workspace.disable', { workspaceId: 'org_missing' })).toMatchObject({
      status: 409,
      body: { error: 'workspace not found' },
    })
  })
})

describe('overview', () => {
  test('counts calls, minutes and people, and estimates cost per provider in use', async () => {
    const before = (await request(operator, 'GET', '/v1/admin/overview')).body
    expect(before.costs.map((c: { category: string }) => c.category)).toEqual(['telephony', 'stt', 'llm', 'tts'])
    const [call] = await db
      .insert(calls)
      .values({
        id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
        workspace_id: home.id,
        from_number: '+15035550100',
        to_number: home.number,
        status: 'completed',
        duration_sec: 600,
      })
      .returning()
    const after = (await request(operator, 'GET', '/v1/admin/overview')).body
    expect(after.calls.today).toBe(before.calls.today + 1)
    expect(after.calls.last7d).toBe(before.calls.last7d + 1)
    expect(after.minutes.last7d).toBeCloseTo(before.minutes.last7d + 10, 1)
    expect(after.workspaces.total).toBeGreaterThanOrEqual(2)
    expect(after.users.total).toBeGreaterThanOrEqual(3)
    for (const cost of after.costs) {
      if (cost.provider) expect(cost.cost7d).toBeGreaterThanOrEqual(0)
      else expect(cost).toMatchObject({ provider: null, cost7d: 0, costMonth: 0 })
    }
    await db.delete(calls).where(eq(calls.id, call!.id))
  })

  test("reply delay: the agent stores each reply's parts, the overview gives p50 and p90 per pipeline and the phone share", async () => {
    const newCall = async () =>
      (
        await db
          .insert(calls)
          .values({
            id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
            workspace_id: home.id,
            from_number: '+15035550100',
            to_number: home.number,
            status: 'completed',
          })
          .returning()
      )[0]!
    const realtimeCall = await newCall()
    const cascadedCall = await newCall()
    const at = new Date().toISOString()
    const record = (callId: string, body: Record<string, unknown>) =>
      act(agent(home.id), 'call.recordTimings', { callId, ...body })
    expect(
      (
        await record(realtimeCall.id, {
          pipeline: 'realtime',
          providers: { turn: 'openai_realtime', model: 'openai_realtime' },
          replies: [
            { at, turnMs: 500, modelMs: 300, serverMs: 20, totalMs: 820 },
            { at, turnMs: 700, modelMs: 500, serverMs: 40, totalMs: 1240 },
          ],
        })
      ).status,
    ).toBe(200)
    await record(cascadedCall.id, {
      pipeline: 'cascaded',
      providers: { turn: 'deepgram', model: 'openrouter', voice: 'elevenlabs' },
      replies: [{ at, turnMs: 400, modelMs: 600, voiceMs: 200, serverMs: 100, totalMs: 1300 }],
    })
    // The call test heard the realtime call's replies over the phone: 1.03 s on average, against 1.03 s on the agent's clock plus the network.
    await record(realtimeCall.id, {
      pipeline: 'phone',
      replies: [
        { at, heardMs: 1830 },
        { at, heardMs: 2230 },
      ],
    })
    // A reply measured wrong (parts larger than its total, as realtime replies stored before #448) is left out.
    await record(realtimeCall.id, {
      pipeline: 'realtime',
      replies: [{ at, turnMs: 0, modelMs: 671, serverMs: 1, totalMs: 268 }],
    })
    // A member cannot write these; only the agent.
    expect(
      (
        await act(member, 'call.recordTimings', {
          callId: realtimeCall.id,
          pipeline: 'realtime',
          replies: [{ at, totalMs: 1 }],
        })
      ).status,
    ).toBe(403)

    const latency = (await request(operator, 'GET', '/v1/admin/latency?days=1')).body
    const realtime = latency.pipelines.find((p: { pipeline: string }) => p.pipeline === 'realtime')
    expect(realtime).toMatchObject({
      replies: 2,
      providers: { turn: 'openai_realtime', model: 'openai_realtime' },
      turn: { p50: 600, p90: 680 },
      model: { p50: 400 },
      voice: { p50: null },
      total: { p50: 1030 },
      phone: { calls: 1, p50: 1000 },
    })
    expect(latency.pipelines.find((p: { pipeline: string }) => p.pipeline === 'cascaded')).toMatchObject({
      replies: 1,
      voice: { p50: 200 },
      phone: { calls: 0, p50: null },
    })
    expect(latency.pipelines.map((p: { pipeline: string }) => p.pipeline)).not.toContain('phone')
    expect((await request(member, 'GET', '/v1/admin/latency')).status).toBe(403)
    await db.delete(calls).where(inArray(calls.id, [realtimeCall.id, cascadedCall.id]))
  })

  test('sample calls are not usage: not in calls, minutes or the workspace list', async () => {
    const before = (await request(operator, 'GET', '/v1/admin/overview')).body
    const listed = async () =>
      (
        (await request(operator, 'GET', '/v1/admin/workspaces')).body.workspaces as { id: string; calls_30d: number }[]
      ).find(w => w.id === home.id)!.calls_30d
    const listedBefore = await listed()
    const [sample] = await db
      .insert(calls)
      .values({
        id: `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
        workspace_id: home.id,
        from_number: '+15035550100',
        to_number: home.number,
        status: 'completed',
        source: 'sample',
        duration_sec: 600,
      })
      .returning()
    const after = (await request(operator, 'GET', '/v1/admin/overview')).body
    expect(after.calls).toEqual(before.calls)
    expect(after.minutes).toEqual(before.minutes)
    expect(await listed()).toBe(listedBefore)
    await db.delete(calls).where(eq(calls.id, sample!.id))
  })

  test('health names each part; the agent shows up once it has asked for its settings', async () => {
    const before = (await request(operator, 'GET', '/v1/admin/health')).body
    expect(Object.keys(before).sort()).toEqual([
      'agent',
      'api',
      'email',
      'livekit',
      'livekitConfigured',
      'readSync',
      'sip',
    ])
    // Whether LiveKit is set in .env at all: the overview's Call audio row says "Not set up" instead of "Failing".
    expect(typeof before.livekitConfigured).toBe('boolean')
    expect(before.api.ok).toBe(true)
    await request(agent(), 'GET', AGENT_ROUTE)
    expect((await request(operator, 'GET', '/v1/admin/health')).body.agent).toMatchObject({ ok: true })
  })
})

describe('instance admins', () => {
  afterEach(() => {
    process.env.INSTANCE_ADMIN_EMAILS = ''
  })

  test('the last instance admin cannot be revoked or disabled', async () => {
    const second = other.owner
    expect(await act(operator, 'instanceAdmin.revoke', { userId: operator.userId })).toMatchObject({
      status: 409,
      body: { error: 'the last instance admin cannot be revoked' },
    })
    expect((await act(operator, 'instanceAdmin.grant', { userId: second.userId })).status).toBe(200)
    expect((await request(second, 'GET', '/v1/admin/users')).status).toBe(200)

    // With two, either can go. Then the one who is left stays.
    expect((await act(second, 'instanceAdmin.revoke', { userId: operator.userId })).status).toBe(200)
    expect((await request(operator, 'GET', '/v1/admin/users')).status).toBe(403)
    expect(await act(second, 'instanceAdmin.revoke', { userId: second.userId })).toMatchObject({
      status: 409,
      body: { error: 'the last instance admin cannot be revoked' },
    })
    expect((await request(second, 'GET', '/v1/admin/users')).status).toBe(200)

    // A disabled admin does not count as one who remains.
    expect((await act(second, 'instanceAdmin.grant', { userId: operator.userId })).status).toBe(200)
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, operator.userId))
    expect((await act(second, 'instanceAdmin.revoke', { userId: second.userId })).status).toBe(409)
    await db.update(user).set({ disabledAt: null }).where(eq(user.id, operator.userId))

    expect((await act(operator, 'instanceAdmin.revoke', { userId: second.userId })).status).toBe(200)
    expect((await request(second, 'GET', '/v1/admin/users')).status).toBe(403)
  })

  test('INSTANCE_ADMIN_EMAILS applies to an existing account once its address is verified; the app cannot revoke it', async () => {
    // A password account from before the variable was set: its address is not verified.
    const ws = await createWorkspace('Env Admin Workspace', false)
    process.env.INSTANCE_ADMIN_EMAILS = ` someone@else.test, ${(await emailOf(ws.owner)).toUpperCase()} `
    // Anyone can sign up with any address, so an unverified one grants nothing.
    expect((await request(ws.owner, 'GET', '/v1/admin/users')).status).toBe(403)
    const unverified = (await request(operator, 'GET', '/v1/admin/users')).body.users.find(
      (u: { id: string }) => u.id === ws.owner.userId,
    )
    expect(unverified).toMatchObject({ instance_admin: false, instance_admin_by_env: false })

    await db.update(user).set({ emailVerified: true }).where(eq(user.id, ws.owner.userId))
    const list = await request(ws.owner, 'GET', '/v1/admin/users')
    expect(list.status).toBe(200)
    expect(list.body.users.find((u: { id: string }) => u.id === ws.owner.userId)).toMatchObject({
      instance_admin: true,
      instance_admin_by_env: true,
    })
    expect((await request(ws.owner, 'GET', '/v1/me')).body.permissions).toContain('instance:admin')
    const revoke = await act(operator, 'instanceAdmin.revoke', { userId: ws.owner.userId })
    expect(revoke.status).toBe(409)
    expect(revoke.body.error).toMatch(/through INSTANCE_ADMIN_EMAILS/)

    process.env.INSTANCE_ADMIN_EMAILS = ''
    expect((await request(ws.owner, 'GET', '/v1/admin/users')).status).toBe(403)
  })

  test('nobody can sign up by password for a listed address, so nobody can take it over later', async () => {
    const email = `operator-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
    process.env.INSTANCE_ADMIN_EMAILS = email.toUpperCase()
    const signUpAs = (address: string) =>
      request(
        anonymous,
        'POST',
        '/api/auth/sign-up/email',
        { name: 'Not The Operator', email: address, password: 'test-password-1234' },
        { origin: 'http://localhost:5173', [FROM]: randomIp() },
      )
    const refused = await signUpAs(email)
    expect(refused.status).toBe(400)
    expect(await db.select().from(user).where(eq(user.email, email))).toEqual([])
    // Password sign-up is off altogether; the reserved-address check still holds on its own.
    expect((await signUpAs(`someone-${crypto.randomUUID().slice(0, 8)}@linedesk.test`)).status).toBe(400)
    await expect(refuseUnverifiedAdminAddress(db, { email, emailVerified: false })).rejects.toMatchObject({
      body: { message: expect.stringMatching(/reserved for an administrator/) },
    })
    // A verified address (email code, sign-in provider) may be created.
    await expect(refuseUnverifiedAdminAddress(db, { email, emailVerified: true })).resolves.toBeUndefined()
  })

  test('the first user of an install becomes instance admin only when INSTANCE_ADMIN_EMAILS lists their proven address (security L2)', async () => {
    class Rollback extends Error {}
    const firstOf = async (created: { id: string; email: string; emailVerified: boolean }) => {
      let admin = false
      await db
        .transaction(async tx => {
          // An empty user table for this transaction only: the temporary table hides the real one.
          await tx.execute(sql`create temp table "user" (like public."user" including defaults) on commit drop`)
          await tx.insert(user).values({ id: created.id, name: created.id, email: created.email })
          await grantFirstUser(tx, created)
          await tx.insert(user).values({ id: 'second', name: 'second', email: 'second@linedesk.test' })
          await grantFirstUser(tx, { id: 'second', email: 'second@linedesk.test', emailVerified: true })
          const rows = await tx.select({ id: user.id, instanceAdmin: user.instanceAdmin }).from(user)
          admin = rows.find(r => r.id === created.id)!.instanceAdmin
          expect(rows.find(r => r.id === 'second')!.instanceAdmin).toBe(false)
          throw new Rollback()
        })
        .catch(e => {
          if (!(e instanceof Rollback)) throw e
        })
      return admin
    }
    // Nobody listed: whoever reaches a fresh install first gets no admin.
    expect(await firstOf({ id: 'first', email: 'first@linedesk.test', emailVerified: true })).toBe(false)
    process.env.INSTANCE_ADMIN_EMAILS = 'operator@linedesk.test'
    expect(await firstOf({ id: 'first', email: 'someone@linedesk.test', emailVerified: true })).toBe(false)
    expect(await firstOf({ id: 'first', email: 'operator@linedesk.test', emailVerified: false })).toBe(false)
    expect(await firstOf({ id: 'first', email: 'Operator@linedesk.test', emailVerified: true })).toBe(true)
  })

  test('an empty install: only the listed address may create the first account (security L2)', async () => {
    class RollbackOnly extends Error {}
    await db
      .transaction(async tx => {
        await tx.execute(sql`create temp table "user" (like public."user" including defaults) on commit drop`)
        expect(await mayCreateUser(tx, 'stranger@linedesk.test', true)).toBe(false)
        process.env.INSTANCE_ADMIN_EMAILS = 'operator@linedesk.test'
        expect(await mayCreateUser(tx, 'operator@linedesk.test', true)).toBe(true)
        expect(await mayCreateUser(tx, 'operator@linedesk.test', false)).toBe(false)
        throw new RollbackOnly()
      })
      .catch(e => {
        if (!(e instanceof RollbackOnly)) throw e
      })
  })

  test('disabling or revoking an admin ends the impersonations they started at once (security L5)', async () => {
    const second = await signUp()
    await setAdmin(second, true)
    const impersonated = await signUp()
    const [started] = await db.select().from(session).where(eq(session.userId, impersonated.userId))
    await db.update(session).set({ impersonatedBy: second.userId }).where(eq(session.id, started!.id))
    expect((await act(operator, 'instanceAdmin.revoke', { userId: second.userId })).status).toBe(200)
    expect(await db.select().from(session).where(eq(session.id, started!.id))).toEqual([])
    // And disabling (as admin again, a fresh impersonation).
    await setAdmin(second, true)
    const again = await signIn(impersonated)
    expect(again.status).toBe(200)
    await db.update(session).set({ impersonatedBy: second.userId }).where(eq(session.userId, impersonated.userId))
    expect((await act(operator, 'user.disable', { userId: second.userId })).status).toBe(200)
    expect(await db.select().from(session).where(eq(session.userId, impersonated.userId))).toEqual([])
    await act(operator, 'user.enable', { userId: second.userId })
    await setAdmin(second, false)
  })

  test('the OIDC provider is held to the proven-email rule like Google (security L1)', () => {
    expect(mapOidcProfile({ email: 'a@x.test', email_verified: true })).toEqual({ emailVerified: true })
    expect(mapOidcProfile({ email: 'a@x.test', email_verified: 'true' })).toEqual({ emailVerified: true })
    expect(mapOidcProfile({ email: 'a@x.test' })).toEqual({ email: null, emailVerified: false })
    expect(mapOidcProfile({ email: 'a@x.test', email_verified: false })).toEqual({ email: null, emailVerified: false })
    // Opted in with OIDC_TRUST_EMAIL_DOMAINS (review B2): only those exact domains.
    const env = { OIDC_TRUST_EMAIL_DOMAINS: ' Corp.test, other.test ' }
    expect(mapOidcProfile({ email: 'a@corp.test' }, env)).toEqual({ emailVerified: true })
    expect(mapOidcProfile({ email: 'A@CORP.TEST' }, env)).toEqual({ emailVerified: true })
    expect(mapOidcProfile({ email: 'a@sub.corp.test' }, env)).toEqual({ email: null, emailVerified: false })
    expect(mapOidcProfile({ email: 'a@corp.test.evil.test' }, env)).toEqual({ email: null, emailVerified: false })
    expect(mapOidcProfile({ email: 'a@x.test' }, env)).toEqual({ email: null, emailVerified: false })
    expect(mapOidcProfile({ email: 'a@corp.test' }, {})).toEqual({ email: null, emailVerified: false })
    // A provider that says the address is not verified is believed, also on a listed domain.
    expect(mapOidcProfile({ email: 'a@corp.test', email_verified: false }, env)).toEqual({
      email: null,
      emailVerified: false,
    })
  })

  const passwordTry = (email: string, ip: string, returned?: unknown) =>
    ({
      path: '/sign-in/email',
      body: { email, password: 'x' },
      headers: new Headers({ [CLIENT_IP_HEADER]: ip }),
      context: { returned },
    }) as never
  const wrongPassword = new APIError('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD' })

  test('ten wrong passwords from one network (an IPv6 /64) pause password sign-in for that address there only (security L4, review B1/B3)', async () => {
    const email = `net-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
    const net = `2001:db8:${Math.floor(Math.random() * 65536).toString(16)}:7`
    for (let i = 1; i <= 10; i++) {
      await limitSignIns(passwordTry(email, `${net}::${i}`))
      await countSignInFailures(passwordTry(email, `${net}::${i}`, wrongPassword))
    }
    await expect(limitSignIns(passwordTry(email, `${net}::99`))).rejects.toMatchObject({ statusCode: 429 })
    // The owner from their own network still gets in, and a success does not count.
    await expect(limitSignIns(passwordTry(email, '198.51.100.30'))).resolves.toBeUndefined()
    await countSignInFailures(passwordTry(email, '198.51.100.30', { token: 'ok' }))
    await expect(limitSignIns(passwordTry(email, '198.51.100.30'))).resolves.toBeUndefined()
  })

  test('a hundred wrong passwords for an address from many networks pause it everywhere (security L4, review B3)', async () => {
    const person = await signUp()
    const email = await emailOf(person)
    const tryPassword = (password: string) =>
      request(
        anonymous,
        'POST',
        '/api/auth/sign-in/email',
        { email, password },
        { origin: 'http://localhost:5173', [FROM]: randomIp() },
      )
    for (let i = 0; i < 10; i++) expect((await tryPassword(`wrong-${i}-password`)).status).toBe(401)
    // Ten from as many networks do not pause it ...
    expect((await tryPassword('test-password-1234')).status).toBe(200)
    // ... a hundred do (the rest counted directly, a hundred sign-ins over HTTP are slow).
    for (let i = 10; i < 100; i++) await countSignInFailures(passwordTry(email, randomIp(), wrongPassword))
    expect((await tryPassword('test-password-1234')).status).toBe(429)
  })

  test('user:create --admin without email delivery: a one-time password signs the new admin in (review B4)', async () => {
    const email = `First-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
    const created = await createAdminWithPassword({ email, name: 'First Admin' })
    expect(created.enrolmentCode).toBeTruthy()
    const [row] = await db.select().from(user).where(eq(user.id, created.userId))
    expect(row).toMatchObject({ email: email.toLowerCase(), emailVerified: true, instanceAdmin: true })
    const signIn = (password: string) =>
      request(
        anonymous,
        'POST',
        '/api/auth/sign-in/email',
        { email: email.toLowerCase(), password },
        { origin: 'http://localhost:5173', [FROM]: randomIp() },
      )
    expect((await signIn(created.password)).status).toBe(200)
    expect((await signIn('not-the-password-1')).status).toBe(401)
    await expect(createAdminWithPassword({ email, name: 'Again' })).rejects.toThrow('already has an account')
  })
})

describe('user.resetPasskeys: the recovery path that needs none of their passkeys', () => {
  afterEach(() => vi.restoreAllMocks())
  const passkeyRow = (userId: string) => ({
    id: `pk_${crypto.randomUUID().slice(0, 12)}`,
    userId,
    publicKey: 'cHVibGlj',
    credentialID: `cred-${crypto.randomUUID()}`,
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
  })

  test('removes every passkey of a member and every session (a passkey session too), emails them, is audited; no code for a non-admin', async () => {
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const someone = await addMember(other.id, 'member')
    await db.insert(passkey).values([passkeyRow(someone.userId), passkeyRow(someone.userId)])
    // Their session as if started by a passkey someone else added: it must not outlive the reset.
    await db.update(session).set({ passkeyVerifiedAt: new Date() }).where(eq(session.userId, someone.userId))
    expect((await request(someone, 'GET', '/v1/me')).status).toBe(200)
    const res = await act(operator, 'user.resetPasskeys', { userId: someone.userId })
    expect(await db.select().from(session).where(eq(session.userId, someone.userId))).toEqual([])
    expect((await request(someone, 'GET', '/v1/me')).status).toBe(401)
    expect(res).toMatchObject({ status: 200, body: { data: { removed: 2 } } })
    expect(res.body.data.enrolmentCode).toBeUndefined()
    expect(await db.select().from(passkey).where(eq(passkey.userId, someone.userId))).toEqual([])
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: await emailOf(someone),
        subject: 'The passkeys of your Linedesk account were removed',
      }),
    )
    const audit = (await request(operator, 'GET', '/v1/admin/audit?kind=admin')).body.entries as { what: string }[]
    expect(audit.some(e => e.what === 'user.resetPasskeys')).toBe(true)
  })

  test('for an instance admin it returns a new enrolment code and always emails them, also without passkeys; not for workspace owners', async () => {
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const second = await signUp()
    await setAdmin(second, true)
    await db.insert(passkey).values(passkeyRow(second.userId))
    const res = await act(operator, 'user.resetPasskeys', { userId: second.userId })
    expect(res.body.data).toMatchObject({ removed: 1, enrolmentCode: expect.any(String) })
    const code: string = res.body.data.enrolmentCode
    expect(
      JSON.stringify(await db.select().from(commands).where(eq(commands.action, 'user.resetPasskeys'))),
    ).not.toContain(code)
    send.mockClear()
    expect((await act(operator, 'user.resetPasskeys', { userId: second.userId })).body.data).toMatchObject({
      removed: 0,
      enrolmentCode: expect.any(String),
    })
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: await emailOf(second),
        subject: 'A passkey enrolment code was issued for your Linedesk account',
      }),
    )
    await setAdmin(second, false)
    expect((await act(other.owner, 'user.resetPasskeys', { userId: member.userId })).status).toBe(403)
  })

  test('an admin cannot reset their own passkeys (b): recovery is another admin or the server', async () => {
    const self = await signUp()
    await setAdmin(self, true)
    await db.insert(passkey).values(passkeyRow(self.userId))
    expect(await act(self, 'user.resetPasskeys', { userId: self.userId })).toMatchObject({
      status: 403,
      body: { code: 'forbidden' },
    })
    expect((await db.select().from(passkey).where(eq(passkey.userId, self.userId))).length).toBe(1)
    // The operator on the server (the CLI's actor) still can.
    const cli: Actor = {
      actorId: 'cli',
      role: 'member',
      workspaceId: null,
      permissions: ['instance:admin'],
      passkeyConfirmed: true,
    }
    expect((await runAction('user.resetPasskeys', { userId: self.userId }, cli)).status).toBe(200)
    await setAdmin(self, false)
  })

  test('the reset says how many sessions and AI agent setup links it ended, also with no passkey to remove', async () => {
    vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const second = await signUp()
    await setAdmin(second, true)
    const res = await act(operator, 'user.resetPasskeys', { userId: second.userId })
    expect(res.body.data).toMatchObject({ removed: 0, sessionsEnded: 1, setupLinksEnded: 0 })
    expect((await request(second, 'GET', '/v1/me')).status).toBe(401)
    await setAdmin(second, false)
  })

  test('user.issuePasskeyEnrolment: only the code for an admin without a passkey, nothing ends; audited and alerted', async () => {
    const mails: Email[] = []
    vi.spyOn(emailSender, 'send').mockImplementation(async e => void mails.push(e))
    const second = await signUp()
    await setAdmin(second, true)
    const sessionsBefore = await db.select().from(session).where(eq(session.userId, second.userId))
    const res = await act(operator, 'user.issuePasskeyEnrolment', { userId: second.userId })
    expect(res).toMatchObject({
      status: 200,
      body: { data: { userId: second.userId, enrolmentCode: expect.any(String) } },
    })
    const code: string = res.body.data.enrolmentCode
    // Still signed in, every session kept; the code is never in the command log.
    expect(await db.select().from(session).where(eq(session.userId, second.userId))).toEqual(sessionsBefore)
    expect((await request(second, 'GET', '/v1/me')).status).toBe(200)
    expect(
      JSON.stringify(await db.select().from(commands).where(eq(commands.action, 'user.issuePasskeyEnrolment'))),
    ).not.toContain(code)
    const audit = (await request(operator, 'GET', '/v1/admin/audit?kind=admin')).body.entries as { what: string }[]
    expect(audit.some(e => e.what === 'user.issuePasskeyEnrolment')).toBe(true)
    const secondEmail = await emailOf(second)
    await vi.waitFor(() => {
      expect(mails.some(m => m.to === secondEmail && /enrolment code was issued/.test(m.subject))).toBe(true)
      expect(mails.some(m => /Passkey enrolment code issued/.test(m.subject))).toBe(true)
    })
    expect(mails.map(m => m.text).join('\n')).not.toContain(code)
    // Their own notice says who issued it and that nothing ended; never "signed you out".
    const notice = mails.find(m => m.to === secondEmail && /enrolment code was issued/.test(m.subject))!
    expect(notice.text).toContain(`${await emailOf(operator)} issued a one-time code for the first passkey`)
    expect(notice.text).toContain('you are still signed in')
    expect(notice.text).not.toMatch(/signed you out|Sign in again/)

    // With a passkey it is the reset's job; not for a non-admin; never on your own account; never for a workspace owner.
    await db.insert(passkey).values(passkeyRow(second.userId))
    expect(await act(operator, 'user.issuePasskeyEnrolment', { userId: second.userId })).toMatchObject({
      status: 409,
      body: { error: expect.stringMatching(/has a passkey already.*signs them out everywhere/) },
    })
    expect((await db.select().from(passkey).where(eq(passkey.userId, second.userId))).length).toBe(1)
    const plain = await signUp()
    expect((await act(operator, 'user.issuePasskeyEnrolment', { userId: plain.userId })).body.error).toMatch(
      /not an instance admin/,
    )
    expect(await act(operator, 'user.issuePasskeyEnrolment', { userId: operator.userId })).toMatchObject({
      status: 403,
      body: { code: 'forbidden' },
    })
    expect((await act(other.owner, 'user.issuePasskeyEnrolment', { userId: second.userId })).status).toBe(403)
    // Not for a disabled admin.
    await db.delete(passkey).where(eq(passkey.userId, second.userId))
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, second.userId))
    expect((await act(operator, 'user.issuePasskeyEnrolment', { userId: second.userId })).body.error).toMatch(
      /is disabled/,
    )
    await db.update(user).set({ disabledAt: null }).where(eq(user.id, second.userId))
    await setAdmin(second, false)
  })

  test('the first-passkey code is written only while no passkey exists, in one statement (race)', async () => {
    const someone = await signUp()
    const before = (await db.select().from(user).where(eq(user.id, someone.userId)))[0]!
    // A passkey that landed between any earlier check and the write: the write itself refuses.
    await db.insert(passkey).values(passkeyRow(someone.userId))
    expect(await issueFirstPasskeyEnrolment(db, someone.userId)).toBeNull()
    const after = (await db.select().from(user).where(eq(user.id, someone.userId)))[0]!
    expect(after.passkeyEnrolmentHash).toBe(before.passkeyEnrolmentHash)
    // instanceAdmin.grant uses the same write: made admin, but no code next to their passkey.
    const granted = await act(operator, 'instanceAdmin.grant', { userId: someone.userId })
    expect(granted.status).toBe(200)
    expect(granted.body.data.enrolmentCode).toBeUndefined()
    await db.delete(passkey).where(eq(passkey.userId, someone.userId))
    expect(await issueFirstPasskeyEnrolment(db, someone.userId)).toMatchObject({ enrolmentCode: expect.any(String) })
    await setAdmin(someone, false)
  })

  test('codes are never handed to a setup key, an API key or an impersonation, even passkey-confirmed', async () => {
    const target = await signUp()
    await setAdmin(target, true)
    const base: Actor = {
      actorId: operator.userId,
      role: 'owner',
      workspaceId: null,
      permissions: ['instance:admin'],
      passkeyConfirmed: true,
    }
    const impersonation = { by: operator.userId, sessionId: 'sess', expiresAt: new Date(Date.now() + 60_000) }
    for (const extra of [{ setupKeyId: 'sk_x' }, { apiKeyId: 'key_x' }, { impersonation }])
      for (const name of ['user.issuePasskeyEnrolment', 'user.resetPasskeys', 'instanceAdmin.grant'])
        expect((await runAction(name, { userId: target.userId }, { ...base, ...extra })).status, name).toBe(403)
    expect((await db.select().from(user).where(eq(user.id, target.userId)))[0]!.passkeyEnrolmentHash).toBeNull()
    await setAdmin(target, false)
  })

  test('the users list shows their passkeys with dates, for the grant dialog', async () => {
    const someone = await signUp()
    await db.insert(passkey).values({ ...passkeyRow(someone.userId), name: 'Work laptop', createdAt: new Date() })
    const { users } = (await request(operator, 'GET', '/v1/admin/users')).body
    expect(users.find((u: { id: string }) => u.id === someone.userId).passkeys).toEqual([
      { name: 'Work laptop', device_type: 'multiDevice', created_at: expect.any(String) },
    ])
  })

  test('granting instance admin to someone without a passkey returns their enrolment code', async () => {
    const someone = await signUp()
    const res = await act(operator, 'instanceAdmin.grant', { userId: someone.userId })
    expect(res.body.data).toMatchObject({ instance_admin: true, enrolmentCode: expect.any(String) })
    await setAdmin(someone, false)
  })
})

describe('user.invite (Add user)', () => {
  const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
  const accountOf = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0]
  const membershipOf = async (userId: string, workspaceId: string) =>
    (
      await db
        .select()
        .from(memberTable)
        .where(and(eq(memberTable.userId, userId), eq(memberTable.organizationId, workspaceId)))
    )[0]
  const invitationsTo = (email: string) => db.select().from(invitation).where(eq(invitation.email, email))
  let shop: Workspace // where people are added; its own, so the invitation rate limit of `other` is not used up
  beforeAll(async () => {
    shop = await createWorkspace('Harbor Lane Electric')
  })
  afterEach(() => {
    process.env.EMAIL_TO_LOG = 'true'
    vi.restoreAllMocks()
  })
  const spySend = (impl: () => Promise<void> = async () => {}) => vi.spyOn(emailSender, 'send').mockImplementation(impl)
  const mailsTo = (send: ReturnType<typeof spySend>, email: string) =>
    send.mock.calls.map(([m]) => m).filter(m => m.to === email && !/^New server admin/.test(m.subject))

  test('a new address: account (unverified) and an invitation to the workspace with the role, in one email that names the workspace; there is no open sign-up', async () => {
    const send = spySend()
    const email = address('new')
    const res = await act(operator, 'user.invite', {
      email: email.toUpperCase(),
      name: 'Rosa',
      workspaceId: shop.id,
      role: 'admin',
    })
    expect(res).toMatchObject({
      status: 200,
      body: {
        data: {
          email,
          existing: false,
          delivery: 'log',
          workspace: { id: shop.id, name: 'Harbor Lane Electric', role: 'admin', joined: 'invited' },
        },
      },
    })
    const account = (await accountOf(email))!
    expect(account).toMatchObject({ name: 'Rosa', emailVerified: false, instanceAdmin: false })
    // No membership until the address is confirmed: the invitation waits for it.
    expect(await membershipOf(account.id, shop.id)).toBeUndefined()
    const [invite] = await invitationsTo(email)
    expect(invite).toMatchObject({
      organizationId: shop.id,
      role: 'admin',
      status: 'pending',
      inviterId: operator.userId,
    })
    const mails = mailsTo(send, email)
    expect(mails).toHaveLength(1)
    expect(mails[0]!.subject).toBe('You were added to Harbor Lane Electric on localhost:5173')
    expect(mails[0]!.text).toContain('added you to Harbor Lane Electric')
    expect(mails[0]!.text).toContain('as an admin')
    expect(mails[0]!.text).toContain(`/?invite=${encodeURIComponent(invite!.id)}`)
    expect(mails[0]!.text).not.toContain('Your Linedesk account is ready')
    // The workspace's owner is told: someone they did not invite will join.
    const ownerMail = mailsTo(send, await emailOf(shop.owner))
    expect(ownerMail).toHaveLength(1)
    expect(ownerMail[0]!.subject).toMatch(/added Rosa to Harbor Lane Electric$/)
    expect(ownerMail[0]!.text).toContain('They join once they confirm their email address.')
  })

  test('once the address is confirmed, the invitation joins them with the role', async () => {
    spySend()
    const email = address('joins')
    await act(operator, 'user.invite', { email, name: 'Joe', workspaceId: shop.id, role: 'member' })
    const account = (await accountOf(email))!
    const [invite] = await invitationsTo(email)
    const invitee: Actor = {
      actorId: account.id,
      role: 'member',
      workspaceId: null,
      permissions: ['invitation:respond'],
    }
    const accept = () => runAction('invitation.accept', { invitationId: invite!.id }, invitee)
    expect((await accept()).body).toMatchObject({ ok: false, error: 'confirm your email address first' })
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, account.id))
    expect((await accept()).status).toBe(200)
    expect(await membershipOf(account.id, shop.id)).toMatchObject({ role: 'member' })
  })

  /** Signs in with an email code the way the sign-in page does; null when no code was sent. */
  async function codeSignIn(send: ReturnType<typeof spySend>, email: string): Promise<User | null> {
    const headers = { origin: 'http://localhost:5173', [FROM]: randomIp() }
    // Only a code sent for this request: the email goes out after the response, so an earlier code may still be the last one.
    const before = send.mock.calls.length
    const asked = await request(
      anonymous,
      'POST',
      '/api/auth/email-otp/send-verification-otp',
      { email, type: 'sign-in' },
      headers,
    )
    expect(asked.status).toBe(200)
    const code = () =>
      send.mock.calls
        .slice(before)
        .map(([m]) => m)
        .findLast(m => m.to === email && /^\d{6} /.test(m.subject))
    await vi.waitFor(() => expect(code()).toBeDefined())
    const res = await appRequest('/api/auth/sign-in/email-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email, otp: code()!.subject.slice(0, 6) }),
    })
    expect(res.status).toBe(200)
    const { user: signedIn } = (await res.json()) as { user: { id: string } }
    const cookie = res.headers
      .getSetCookie()
      .map(c => c.split(';')[0])
      .join('; ')
    return { userId: signedIn.id, headers: { cookie, origin: 'http://localhost:5173' } }
  }

  test('an account made with the invitation joins at the first sign-in, no Join click, once; it is in the audit log', async () => {
    const send = spySend()
    const email = address('autojoin')
    await act(operator, 'user.invite', { email, name: 'Ava', workspaceId: shop.id, role: 'admin' })
    const [invite] = await invitationsTo(email)
    expect(invite).toMatchObject({ joinOnSignIn: true, status: 'pending' })
    const ava = (await codeSignIn(send, email))!
    expect(await membershipOf(ava.userId, shop.id)).toMatchObject({ role: 'admin' })
    expect((await invitationsTo(email))[0]).toMatchObject({ status: 'accepted' })
    expect((await request(ava, 'GET', '/v1/me')).body).toMatchObject({ workspace: { id: shop.id } })
    const events = await db
      .select()
      .from(auth_events)
      .where(and(eq(auth_events.user_id, ava.userId), eq(auth_events.event, 'invitation_accepted')))
    expect(events).toEqual([expect.objectContaining({ workspace_id: shop.id, method: 'admin_created', email })])
    // Single use: after leaving (account kept), the next sign-in does not bring them back.
    expect((await act(ava, 'team.leave', { deleteAccount: false })).status).toBe(200)
    await codeSignIn(send, email)
    expect(await membershipOf(ava.userId, shop.id)).toBeUndefined()
  })

  test('the workspace owner made by Create workspace joins at the first sign-in too', async () => {
    const send = spySend()
    const email = address('newowner')
    const made = await act(operator, 'workspace.create', {
      name: 'Auto Join Owner Co',
      owner: { email, name: 'Olive' },
    })
    expect(made.status).toBe(200)
    const olive = (await codeSignIn(send, email))!
    expect(await membershipOf(olive.userId, made.body.data.workspace.id)).toMatchObject({ role: 'owner' })
  })

  test('no auto-join: an invitation to an existing account, an expired one, or one for another address keeps the Join step', async () => {
    const send = spySend()
    // An account that existed before: the invitation waits for Join, also after a sign-in proves the address.
    const existing = await signUp()
    const existingEmail = await emailOf(existing)
    await act(operator, 'user.invite', { email: existingEmail, name: 'Una', workspaceId: shop.id })
    expect((await invitationsTo(existingEmail))[0]).toMatchObject({ joinOnSignIn: false })
    await codeSignIn(send, existingEmail)
    expect(await membershipOf(existing.userId, shop.id)).toBeUndefined()
    expect((await invitationsTo(existingEmail))[0]).toMatchObject({ status: 'pending' })

    // Expired: never joins.
    const late = address('expired')
    await act(operator, 'user.invite', { email: late, name: 'Lee', workspaceId: shop.id })
    await db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitation.email, late))
    const lee = (await codeSignIn(send, late))!
    expect(await membershipOf(lee.userId, shop.id)).toBeUndefined()

    // The account's address changed before the first sign-in: the invitation names the old one and is not joined.
    const old = address('moved')
    await act(operator, 'user.invite', { email: old, name: 'Mo', workspaceId: shop.id })
    const moved = address('moved-new')
    await db.update(user).set({ email: moved }).where(eq(user.email, old))
    const mo = (await codeSignIn(send, moved))!
    expect(await membershipOf(mo.userId, shop.id)).toBeUndefined()
    expect((await invitationsTo(old))[0]).toMatchObject({ status: 'pending' })
  })

  test('an account with a confirmed address is added at once with the role, no new account; they and the owners get a notice', async () => {
    const send = spySend()
    const someone = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, someone.userId))
    const email = await emailOf(someone)
    // One owner per workspace: Harbor Lane Electric has one, so a second is refused and the admin role works.
    expect(
      (await act(operator, 'user.invite', { email, name: 'Ignored', workspaceId: shop.id, role: 'owner' })).body.error,
    ).toMatch(/has an owner already/)
    const res = await act(operator, 'user.invite', {
      email: email.toUpperCase(),
      name: 'Ignored',
      workspaceId: shop.id,
      role: 'admin',
    })
    expect(res).toMatchObject({
      status: 200,
      body: {
        data: { userId: someone.userId, existing: true, workspace: { id: shop.id, role: 'admin', joined: 'added' } },
      },
    })
    expect(res.body.data.delivery).toBeUndefined()
    expect(await membershipOf(someone.userId, shop.id)).toMatchObject({ role: 'admin' })
    expect((await db.select().from(user).where(eq(user.email, email))).length).toBe(1)
    // No invitation to accept: a short notice to them, and the workspace's owner hears of it (not the acting admin).
    const toThem = mailsTo(send, email)
    expect(toThem).toHaveLength(1)
    expect(toThem[0]!.subject).toBe('You were added to Harbor Lane Electric on localhost:5173')
    expect(toThem[0]!.text).toContain('added you to Harbor Lane Electric on localhost:5173 as an admin')
    const ownerMail = mailsTo(send, await emailOf(shop.owner))
    expect(ownerMail).toHaveLength(1)
    expect(ownerMail[0]!.text).toMatch(/added Test User to Harbor Lane Electric as an admin\./)
    expect(mailsTo(send, await emailOf(operator))).toHaveLength(0)
    // A second time: they are a member already.
    expect(await act(operator, 'user.invite', { email, name: 'Again', workspaceId: shop.id })).toMatchObject({
      status: 409,
      body: { error: `${email} is already a member of Harbor Lane Electric` },
    })
  })

  test('an account whose address is not confirmed is invited, not added; a second time says it is invited', async () => {
    const send = spySend()
    const someone = await signUp() // a password sign-up: unconfirmed
    const email = await emailOf(someone)
    const res = await act(operator, 'user.invite', { email, name: 'Una', workspaceId: shop.id })
    expect(res.body.data).toMatchObject({ existing: true, workspace: { role: 'member', joined: 'invited' } })
    expect(await membershipOf(someone.userId, shop.id)).toBeUndefined()
    expect(await invitationsTo(email)).toHaveLength(1)
    expect(mailsTo(send, email)).toHaveLength(1)
    expect(await act(operator, 'user.invite', { email, name: 'Una', workspaceId: shop.id })).toMatchObject({
      status: 409,
      body: { error: `${email} is already invited to Harbor Lane Electric: resend the invitation on their page` },
    })
  })

  test('an instance admin may have no workspace; anyone else needs one, and nothing is made without it', async () => {
    spySend()
    const admin = address('admin-alone')
    expect(
      await act(operator, 'user.invite', { email: admin, name: 'Ada', admin: true, workspaceId: null }),
    ).toMatchObject({
      status: 200,
      body: { data: { existing: false, workspace: null } },
    })
    expect(await accountOf(admin)).toMatchObject({ instanceAdmin: true })
    await db.update(user).set({ instanceAdmin: false }).where(eq(user.email, admin))
    const plain = address('alone')
    for (const input of [{}, { workspaceId: null }])
      expect(await act(operator, 'user.invite', { email: plain, name: 'Al', ...input })).toMatchObject({
        status: 409,
        body: { error: 'choose a workspace: only an instance admin can be added without one' },
      })
    expect(await act(operator, 'user.invite', { email: plain, name: 'Al', admin: true, role: 'owner' })).toMatchObject({
      status: 409,
      body: { error: 'a role needs a workspace' },
    })
    expect(await accountOf(plain)).toBeUndefined()
  })

  test('a missing or disabled workspace and an unknown role are refused, and nothing is made', async () => {
    spySend()
    const email = address('refused')
    expect((await act(operator, 'user.invite', { email, name: 'R', workspaceId: 'nope' })).body.error).toBe(
      'workspace not found',
    )
    const off = await createWorkspace('Closed For Winter Roofing')
    expect((await act(operator, 'workspace.disable', { workspaceId: off.id })).status).toBe(200)
    expect((await act(operator, 'user.invite', { email, name: 'R', workspaceId: off.id })).body.error).toBe(
      'Closed For Winter Roofing is disabled: enable it first',
    )
    expect((await act(operator, 'user.invite', { email, name: 'R', workspaceId: shop.id, role: 'boss' })).status).toBe(
      422,
    )
    expect(await accountOf(email)).toBeUndefined()
    expect(await invitationsTo(email)).toHaveLength(0)
  })

  test('an existing account cannot be made an instance admin here, and a disabled one is not added', async () => {
    spySend()
    const someone = await signUp()
    const email = await emailOf(someone)
    expect((await act(operator, 'user.invite', { email, name: 'S', admin: true })).body.error).toBe(
      `${email} already has an account: make them an instance admin on their page`,
    )
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, someone.userId))
    expect((await act(operator, 'user.invite', { email, name: 'S', workspaceId: shop.id })).body.error).toBe(
      `${email} is disabled: enable the account first`,
    )
    expect(await membershipOf(someone.userId, shop.id)).toBeUndefined()
  })

  test('a new instance admin comes with a one-time passkey enrolment code for the inviting admin, not in the log', async () => {
    spySend()
    const email = address('new-admin')
    const res = await act(operator, 'user.invite', { email, name: 'Ann', admin: true, workspaceId: shop.id })
    const code: string = res.body.data.enrolmentCode
    expect(code).toEqual(expect.any(String))
    expect(res.body.data.workspace).toMatchObject({ id: shop.id, joined: 'invited' })
    expect((await accountOf(email))!.passkeyEnrolmentHash).toEqual(expect.any(String))
    const [logged] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'user.invite'), sql`${commands.input}->>'email' = ${email}`))
    expect(JSON.stringify(logged)).not.toContain(code)
    // A plain user gets none.
    expect(
      (await act(operator, 'user.invite', { email: address('plain'), name: 'Bo', workspaceId: shop.id })).body.data
        .enrolmentCode,
    ).toBeUndefined()
    await db.update(user).set({ instanceAdmin: false }).where(eq(user.email, email))
  })

  test('without a workspace, a new admin gets the sign-in email: no code or link', async () => {
    const send = spySend()
    const email = address('invitee')
    await act(operator, 'user.invite', { email, name: 'Mike Brennan', admin: true })
    expect(await accountOf(email)).toMatchObject({ name: 'Mike Brennan', emailVerified: false, instanceAdmin: true })
    // One email to them; the other admins hear of the new admin separately (admin-alerts.ts).
    const toThem = mailsTo(send, email)
    expect(toThem).toHaveLength(1)
    expect(toThem[0]).toMatchObject({ subject: 'Your Linedesk account is ready' })
    expect(send.mock.calls.some(([m]) => /^New server admin/.test(m.subject))).toBe(true)
    expect(toThem[0]!.text).toContain('Enter this email address')
    // No sign-in code or link. The address itself is left out: its random part can hold six digits in a row.
    expect(toThem[0]!.text.replaceAll(email, '')).not.toMatch(/\d{6}|token=/)
    await db.update(user).set({ instanceAdmin: false }).where(eq(user.email, email))
  })

  test('a server admin without a workspace is in the audit log under no workspace, naming whom it added', async () => {
    spySend()
    const email = address('audited-admin')
    const res = await act(operator, 'user.invite', { email, name: 'Ad', admin: true })
    expect(res.status).toBe(200)
    const { entries } = (await request(operator, 'GET', '/v1/admin/audit?kind=admin&limit=50')).body
    expect(
      entries.find(
        (e: { what: string; subject: { email: string } | null }) =>
          e.what === 'user.invite' && e.subject?.email === email,
      ),
    ).toMatchObject({ workspace: null, subject: { email } })
    await db.update(user).set({ instanceAdmin: false }).where(eq(user.email, email))
  })

  test('it is in the audit log under the workspace, naming whom it added', async () => {
    spySend()
    const email = address('audited')
    expect(
      (await act(operator, 'user.invite', { email, name: 'Au', workspaceId: shop.id, role: 'admin' })).status,
    ).toBe(200)
    const { entries } = (await request(operator, 'GET', `/v1/admin/audit?kind=admin&workspace=${shop.id}`)).body
    expect(
      entries.find(
        (e: { what: string; subject: { email: string } | null }) =>
          e.what === 'user.invite' && e.subject?.email === email,
      ),
    ).toMatchObject({
      kind: 'admin',
      workspace: { id: shop.id },
      input: { email, workspaceId: shop.id, role: 'admin' },
    })
  })

  test('an add does not use up the sign-in code limit of that address', async () => {
    const send = spySend()
    const email = address('limit')
    for (let i = 0; i < 6; i++)
      await request(
        anonymous,
        'POST',
        '/api/auth/email-otp/send-verification-otp',
        { email, type: 'sign-in' },
        { origin: 'http://localhost:5173', [FROM]: randomIp() },
      )
    send.mockClear()
    expect((await act(operator, 'user.invite', { email, name: 'After Many Codes', workspaceId: shop.id })).status).toBe(
      200,
    )
    // Their invitation; the shop's owner gets the notice that they were added.
    expect(send.mock.calls.map(([m]) => m).filter(m => m.to === email)).toHaveLength(1)
  })

  test('without email it is refused and nothing is created', async () => {
    delete process.env.EMAIL_TO_LOG
    const email = address('noemail')
    const res = await act(operator, 'user.invite', { email, name: 'No Email', workspaceId: shop.id })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/^Email is not set up/)
    expect(await accountOf(email)).toBeUndefined()
  })

  test('when the email cannot be sent nothing is left (account, invitation) and the command is logged as rejected', async () => {
    spySend(async () => {
      throw new Error('SMTP said no')
    })
    const email = address('bounce')
    const key = crypto.randomUUID()
    const res = await act(operator, 'user.invite', { email, name: 'Bounce', workspaceId: shop.id }, key)
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/could not send the invitation email/)
    expect(await accountOf(email)).toBeUndefined()
    expect(await invitationsTo(email)).toHaveLength(0)
    expect((await db.select().from(commands).where(eq(commands.id, key)))[0]).toMatchObject({ rejected: true })
    // The admin without a workspace: the sign-in email.
    const alone = address('bounce-admin')
    expect((await act(operator, 'user.invite', { email: alone, name: 'Bounce', admin: true })).body.error).toMatch(
      /the account was not created: the welcome email could not be sent \(SMTP said no\)/,
    )
    expect(await accountOf(alone)).toBeUndefined()
  })

  test('a workspace owner who is not an instance admin cannot add users', async () => {
    expect(
      await act(other.owner, 'user.invite', { email: address('x'), name: 'X', workspaceId: other.id }),
    ).toMatchObject({
      status: 403,
      body: { error: 'missing permission instance:admin' },
    })
  })
})

describe('impersonation', () => {
  const SESSION = 'better-auth.session_token'
  const ADMIN_SESSION = 'better-auth.admin_session'
  const DONT_REMEMBER = 'better-auth.dont_remember'
  let target: User // a member of `other`, signed in with a password
  afterEach(() => {
    process.env.INSTANCE_ADMIN_EMAILS = ''
  })
  beforeAll(async () => {
    target = await addMember(other.id, 'member')
  })

  const cookiesOf = (caller: Caller) =>
    new Map(
      (caller.headers.cookie ?? '')
        .split('; ')
        .filter(Boolean)
        .map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
    )
  const callerWith = (caller: Caller, jar: Map<string, string>): Caller => ({
    headers: { ...caller.headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
  })
  /** The caller as the browser would be after the response: its Set-Cookie headers applied. */
  function afterResponse(caller: Caller, res: Response): Caller {
    const jar = cookiesOf(caller)
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';')
      const name = pair.slice(0, pair.indexOf('='))
      if (/max-age=0\b/i.test(line) || pair.endsWith('=')) jar.delete(name)
      else jar.set(name, pair.slice(pair.indexOf('=') + 1))
    }
    return callerWith(caller, jar)
  }
  const withCookie = (caller: Caller, name: string, value: string | null): Caller => {
    const jar = cookiesOf(caller)
    if (value === null) jar.delete(name)
    else jar.set(name, value)
    return callerWith(caller, jar)
  }
  const post = (who: Caller, path: string, body: unknown = {}) =>
    appRequest(path, {
      method: 'POST',
      headers: { ...who.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  /** A reason is required; `extra` adds or overrides fields of the input (workspaceId, another reason). */
  async function start(who: Caller, userId: string, extra: Record<string, unknown> = {}) {
    const res = await post(who, '/v1/impersonation/start', { userId, reason: 'Support ticket 1042', ...extra })
    return { status: res.status, body: await res.json(), as: afterResponse(who, res) }
  }
  async function stop(who: Caller) {
    const res = await post(who, '/v1/impersonation/stop')
    return { status: res.status, body: await res.json(), as: afterResponse(who, res) }
  }
  const sessionsOf = (userId: string) => db.select().from(session).where(eq(session.userId, userId))
  const impersonations = async () => (await sessionsOf(target.userId)).filter(s => s.impersonatedBy)
  const getSession = async (who: Caller) =>
    (await request(who, 'GET', '/api/auth/get-session')).body as {
      user: { id: string }
      session: { impersonatedBy?: string }
    } | null

  test('a workspace owner or member who is no instance admin cannot start it, and no session is made', async () => {
    for (const who of [other.owner, member]) {
      expect(await start(who, target.userId)).toMatchObject({
        status: 403,
        body: { error: 'missing permission instance:admin' },
      })
    }
    expect(await impersonations()).toEqual([])
  })

  test('the generic action route refuses both actions: they only run through their own routes', async () => {
    expect((await act(operator, 'user.impersonate', { userId: target.userId })).status).toBe(400)
    expect((await act(operator, 'impersonation.stop', {})).status).toBe(400)
    expect(await impersonations()).toEqual([])
  })

  test('refused for yourself, another instance admin (also by INSTANCE_ADMIN_EMAILS), a disabled and an unknown user', async () => {
    // Another instance admin is a rule about who asks (403); the others are about the user (409).
    const reason = async (userId: string, status = 409) => {
      const res = await start(operator, userId)
      expect(res.status).toBe(status)
      expect(res.as.headers.cookie).toBe(operator.headers.cookie) // no cookie changed
      return res.body.error as string
    }
    expect(await reason(operator.userId)).toMatch(/yourself/)
    const admin = await signUp()
    await setAdmin(admin, true)
    expect(await reason(admin.userId, 403)).toMatch(/another instance admin/)
    await setAdmin(admin, false)
    const envAdmin = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, envAdmin.userId))
    process.env.INSTANCE_ADMIN_EMAILS = await emailOf(envAdmin)
    expect(await reason(envAdmin.userId, 403)).toMatch(/another instance admin/)
    const disabled = await signUp()
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, disabled.userId))
    expect(await reason(disabled.userId)).toMatch(/disabled/)
    expect(await reason('no-such-user')).toMatch(/not found/)
    expect(await db.select().from(session).where(eq(session.impersonatedBy, operator.userId))).toEqual([])
  })

  test('starts a Better Auth session for the user: impersonated_by, one hour, their first workspace; the cookie is accepted', async () => {
    const before = Date.now()
    const { status, body, as } = await start(operator, target.userId)
    expect(status).toBe(200)
    const [started] = await impersonations()
    expect(started).toMatchObject({
      id: body.data.sessionId,
      impersonatedBy: operator.userId,
      activeOrganizationId: other.id,
    })
    const lifetime = started!.expiresAt.getTime() - before
    expect(lifetime).toBeGreaterThan(59 * 60_000)
    expect(lifetime).toBeLessThanOrEqual(60 * 60_000 + 5_000)
    // An admin signing in as the user is not the user's last sign-in.
    expect(
      (await db.select().from(user).where(eq(user.id, target.userId)))[0]!.lastSignInAt?.getTime() ?? 0,
    ).toBeLessThan(before)
    expect(await getSession(as)).toMatchObject({
      user: { id: target.userId },
      session: { impersonatedBy: operator.userId },
    })
    expect(cookiesOf(as).get(ADMIN_SESSION)).toBeTruthy()
    await stop(as)
  })

  test("while impersonating: the user's permissions, never instance:admin, no admin routes, no starting another", async () => {
    const { as } = await start(operator, target.userId)
    const me = (await request(as, 'GET', '/v1/me')).body
    expect(me).toMatchObject({ actorId: target.userId, role: 'member', workspace: { id: other.id } })
    expect(me.permissions).toEqual(expect.arrayContaining(['call:read', 'call:write', 'impersonation:stop']))
    expect(me.permissions).not.toContain('instance:admin')
    expect(me.impersonation).toMatchObject({ by: { id: operator.userId, email: await emailOf(operator) } })
    expect(Date.parse(me.impersonation.expiresAt)).toBeGreaterThan(Date.now() + 59 * 60_000)
    for (const path of adminRoutes) expect((await request(as, 'GET', path)).status, path).toBe(403)
    expect((await start(as, member.userId)).status).toBe(403)
    const memberSessions = await db.select().from(session).where(eq(session.userId, member.userId))
    expect(memberSessions.every(s => !s.impersonatedBy)).toBe(true)
    expect((await request(operator, 'GET', '/v1/me')).body.impersonation).toBeNull()
    await stop(as)
  })

  test('what an impersonated session may run is pinned: a new read-only action or allowed write needs a look here', () => {
    const allowed = [...actions.values()]
      .filter(def => mayRunWhileImpersonating(def))
      .map(def => def.name)
      .sort()
    expect(allowed).toEqual([
      // Read-only and instance:admin: the guard lets it through, but an impersonation never has instance:admin.
      'afterCallTranscript.get',
      // API keys stay possible while signed in as the user (support needs them; decision 2026-11-15), marked as the admin's.
      'apiKey.create',
      'apiKey.list',
      'apiKey.revoke',
      // The calls sent to a connected app (HubSpot), a read like webhook.deliveries; connecting stays refused.
      'app.pushes',
      'assistant.version',
      'assistant.versions',
      // Read-only and instance:admin, as above (Server admin › Billing too).
      'billing.adminBill',
      'billing.adminBills',
      'billing.adminEvents',
      'billing.adminReview',
      'billing.adminSummary',
      'billing.adminTaxAddressMissing',
      // The bill owner's banner data (PR 11), so support sees what the owner sees; port-out PINs stay refused.
      'billing.state',
      // A workspace admin's usage of this workspace (billing tour G3): read-only figures support may see too; no
      // payment control and no invoice link (security review of #1098).
      'billing.workspaceUsage',
      'billingEnabled.get',
      'billingRules.get',
      'calendar.findSlots',
      'calendar.listCalendars',
      'calendarTools.get',
      'call.clearReminder',
      'call.findForTest',
      'call.getEvaluation',
      'call.listEvaluations',
      'call.listNumbers',
      'call.markDone',
      'call.markNotDone',
      'call.markRead',
      'call.markUnread',
      'call.remind',
      // Read-only and instance:admin, like setupEmails.get: an impersonation never has instance:admin.
      'callQuality.get',
      'carrier.get',
      'carrier.transferTrunk',
      // Call emails (LIN-470): the section's reads.
      'emailRouting.available',
      'emailRouting.get',
      // The questions of How <assistant> did, a read; marking an evaluation done or open stays refused.
      'evaluation.listQuestions',
      // Read-only and instance:admin (Server admin › Onboarding › Setup reports), as above.
      'feedback.setupReports',
      // Read-only and instance:admin, like setupEmails.get: an impersonation never has instance:admin.
      'founderEmail.get',
      // Read-only and instance:admin: the guard lets it through, but an impersonation never has instance:admin.
      'germanNumbers.get',
      'germanNumbers.group',
      'holidays.lookup',
      'impersonation.setEdits',
      'impersonation.stop',
      'insights.get',
      // The Zapier subscriptions in Settings › Developers, a read like apiKey.list; no hook URLs in it. Remove stays refused.
      'integration.list',
      'invitation.listMine',
      'member.list',
      'notifications.get',
      // The go-live checklist's facts, so the inbox looks as the user sees it. Closing or reopening it stays refused.
      'onboarding.goLiveChecklist',
      // Which countries transfers may call, so the Transfers settings show what the user sees.
      'outbound.countries',
      // Read-only and instance:admin: the guard lets it through, but an impersonation never has instance:admin.
      'outboundCountries.get',
      // Read-only and instance:admin, as above (Server admin › Partners).
      'partner.adminList',
      // Read-only and `partner`, which an impersonation never has (context.ts): the partner area stays the partner's.
      'partner.get',
      // Read-only and `partner`, which an impersonation never has (context.ts): aggregates of the partner's clients.
      'partner.listClients',
      // Read-only and `partner`, as above: a partner's brand stays the partner's (partner-brand.ts).
      'partnerBrand.get',
      // Read-only and instance:admin, as above (Server admin › Partners › Protected names).
      'partnerBrand.protectedNames',
      'partnerBrand.reviews',
      // Read-only and `partner`, as above: the partner's own address and its records (partner-domain.ts).
      'partnerDomain.get',
      // Read-only and account:own, which an impersonation never has.
      'partnerInvitation.view',
      // Read-only and `partner`, as above: the partner's own AI keys, never a key (partner-keys.ts).
      'partnerKeys.get',
      // Read-only and `partner`, as above: the partner's sender address and its records (partner-sender.ts).
      'partnerSender.get',
      // Read-only and account:own, which an impersonation never has; the handler refuses an impersonation as well.
      'personalKey.list',
      'phoneNumber.forwardingCheck',
      // One free read of the carrier account, to pick a number; buys nothing.
      'phoneNumber.listCarrierNumbers',
      // Free searches at the carrier for nearby area codes with a free number; buys nothing.
      'phoneNumber.searchNearby',
      'provider.confirmEmail',
      'provider.test',
      'provider.tryOut',
      // The workspace's rows as the inbox syncs them (LIN-339), a read the user's session already has.
      'records.list',
      // Read-only and instance:admin: the guard lets it through, but an impersonation never has instance:admin.
      'setupEmails.get',
      // Read-only and instance:admin, as above.
      'signup.getSelfServe',
      // Read-only and instance:admin, as above.
      'signupAccess.get',
      // Read-only and instance:admin, like setupEmails.get: an impersonation never has instance:admin.
      'systemPrompt.get',
      // A teammate's profile and notifications as the Edit dialog shows them; changing them stays refused.
      'team.getMember',
      'team.list',
      'voice.catalog',
      'voice.options',
      'voiceCloning.get',
      'webhook.deliveries',
      'workspace.getSettings',
      // Read-only and instance:admin, as above.
      'zapierApp.get',
    ])
  })

  test('with edits allowed, only the assistant and workspace settings join them: pinned too (LIN-700)', () => {
    const extra = [...actions.values()]
      .filter(def => mayRunWhileImpersonating(def, { edits: true }) && !mayRunWhileImpersonating(def))
      .map(def => def.name)
      .sort()
    expect(extra).toEqual([
      'appointmentType.delete',
      'appointmentType.upsert',
      'assistant.update',
      'businessHours.set',
      'closedDays.set',
      'holidays.set',
      'knowledgeQuestion.answer',
      'knowledgeQuestion.dismiss',
      'onboarding.dismissGoLiveChecklist',
      'onboarding.reopenGoLiveChecklist',
      'onboarding.restoreGoLiveStep',
      'onboarding.setStep',
      'onboarding.skipGoLiveStep',
      'workspace.rename',
      'workspace.updateSettings',
    ])
  })

  test('Allow edits: per impersonation session, settings only, never transfers, call emails, team or webhooks (LIN-700)', async () => {
    const targetMember = and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, target.userId))
    // One owner per workspace: `other`'s owner steps aside for the test and gets it back after.
    const otherOwner = and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, other.owner.userId))
    await db.update(memberTable).set({ role: 'admin' }).where(otherOwner)
    await db.update(memberTable).set({ role: 'owner' }).where(targetMember)
    const [before] = await db.select().from(assistants).where(eq(assistants.id, other.assistant.id))
    const refusedText = { status: 403, body: { error: 'Not possible while signed in as another user.' } }
    try {
      // Only an impersonated session has it: not the user, not the admin in their own session.
      for (const who of [target, operator]) {
        expect(await act(who, 'impersonation.setEdits', { on: true })).toMatchObject({
          status: 403,
          body: { error: 'missing permission impersonation:stop' },
        })
      }
      const { as } = await start(operator, target.userId)
      const rename = (name: string, key?: string) =>
        act(as, 'assistant.update', { assistantId: other.assistant.id, name }, key)
      // Read-only by default.
      expect((await request(as, 'GET', '/v1/me')).body.impersonation).toMatchObject({ edits: false })
      expect(await rename('Edited by support')).toMatchObject(refusedText)

      const switched = crypto.randomUUID()
      expect(await act(as, 'impersonation.setEdits', { on: true }, switched)).toMatchObject({
        status: 200,
        body: { data: { on: true } },
      })
      expect((await request(as, 'GET', '/v1/me')).body.impersonation).toMatchObject({ edits: true })
      // The switch is in the audit trail, done as the user by the admin.
      expect((await db.select().from(commands).where(eq(commands.id, switched)))[0]).toMatchObject({
        action: 'impersonation.setEdits',
        actor_id: target.userId,
        impersonated_by: operator.userId,
      })

      // With edits on: the assistant's settings change, and the command names the admin.
      const key = crypto.randomUUID()
      expect((await rename('Edited by support', key)).status).toBe(200)
      expect((await db.select().from(assistants).where(eq(assistants.id, other.assistant.id)))[0]!.name).toBe(
        'Edited by support',
      )
      expect((await db.select().from(commands).where(eq(commands.id, key)))[0]).toMatchObject({
        action: 'assistant.update',
        actor_id: target.userId,
        impersonated_by: operator.userId,
      })
      expect((await act(as, 'workspace.updateSettings', { businessHoursOn: true })).status).toBe(200)

      // Transfer contacts and call email rules stay refused, also next to an allowed field; recordings are not deleted.
      const refused: [string, unknown][] = [
        ['assistant.update', { assistantId: other.assistant.id, transfers: [] }],
        [
          'assistant.update',
          { assistantId: other.assistant.id, name: 'Sneaky', email_rules: { always: [], rules: [] } },
        ],
        ['workspace.updateSettings', { recordingRetentionDays: 0 }],
        // Recording and its notice stay the owner's: callers are never recorded without being told.
        ['workspace.updateSettings', { recordingNoticeOn: false }],
        ['workspace.updateSettings', { recordingNotice: 'Hi.' }],
        ['assistant.update', { assistantId: other.assistant.id, record_calls: true }],
        // Never on the list, edits or not.
        ['team.invite', { email: 'admin-backdoor@linedesk.test', role: 'owner' }],
        [
          'webhook.create',
          { assistantId: other.assistant.id, hooks: ['call_end'], url: 'https://collector.example.com/hook' },
        ],
        ['carrier.set', {}],
        ['phoneNumber.release', { phoneNumberId: 'any' }],
        ['calendar.connectStart', { provider: 'google' }],
        ['workspace.deleteOwn', { name: 'any' }],
        ['assistant.delete', { assistantId: other.assistant.id }],
        ['assistant.restoreVersion', { assistantId: other.assistant.id, version: 1 }],
      ]
      for (const [name, input] of refused) expect(await act(as, name, input), name).toMatchObject(refusedText)
      expect(await db.select().from(invitation).where(eq(invitation.email, 'admin-backdoor@linedesk.test'))).toEqual([])
      expect((await db.select().from(assistants).where(eq(assistants.id, other.assistant.id)))[0]!.name).toBe(
        'Edited by support',
      )

      // Per session: another impersonation of the same user starts read-only, while the first keeps its edits.
      const second = await start(operator, target.userId)
      expect((await request(second.as, 'GET', '/v1/me')).body.impersonation).toMatchObject({ edits: false })
      expect(
        await act(second.as, 'assistant.update', { assistantId: other.assistant.id, name: 'Second' }),
      ).toMatchObject(refusedText)
      expect((await rename('Edited again')).status).toBe(200)
      await stop(second.as)

      // Back to read-only.
      expect((await act(as, 'impersonation.setEdits', { on: false })).status).toBe(200)
      expect((await request(as, 'GET', '/v1/me')).body.impersonation).toMatchObject({ edits: false })
      expect(await rename('Not any more')).toMatchObject(refusedText)
      await stop(as)
    } finally {
      await db.update(assistants).set({ name: before!.name }).where(eq(assistants.id, other.assistant.id))
      await db.update(memberTable).set({ role: 'member' }).where(targetMember)
      await db.update(memberTable).set({ role: 'owner' }).where(otherOwner)
    }
  })

  test('setupEmails.get passes the impersonation guard (an on/off flag, nothing sensitive), yet needs instance:admin', async () => {
    const def = actions.get('setupEmails.get')!
    expect(def.readOnly).toBe(true)
    expect(mayRunWhileImpersonating(def)).toBe(true)
    // An impersonation never has instance:admin, so it is the permission that refuses it, not the guard.
    const { as } = await start(operator, target.userId)
    expect(await act(as, 'setupEmails.get', {})).toMatchObject({
      status: 403,
      body: { error: 'missing permission instance:admin' },
    })
    expect((await act(operator, 'setupEmails.get', {})).status).toBe(200)
    await stop(as)
  })

  test('as an owner, only reads and inbox triage run; every other write is refused centrally (security M3)', async () => {
    const targetMember = and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, target.userId))
    // One owner per workspace: `other`'s owner steps aside for the test and gets it back after.
    const otherOwner = and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, other.owner.userId))
    await db.update(memberTable).set({ role: 'admin' }).where(otherOwner)
    await db.update(memberTable).set({ role: 'owner' }).where(targetMember)
    try {
      const { as } = await start(operator, target.userId)
      const refused: [string, unknown][] = [
        ['team.invite', { email: 'admin-backdoor@linedesk.test', role: 'owner' }],
        ['team.removeMember', { memberId: 'any' }],
        ['team.resendInvite', { invitationId: 'any' }],
        [
          'webhook.create',
          { assistantId: other.assistant.id, hooks: ['call_end'], url: 'https://collector.example.com/hook' },
        ],
        ['webhook.update', { endpointId: other.webhookEndpoint.id, url: 'https://collector.example.com/hook' }],
        // Deleting the workspace, connecting a calendar: never as the user.
        ['workspace.deleteOwn', { name: 'any' }],
        ['calendar.connectStart', { provider: 'google' }],
        ['carrier.set', {}],
        ['phoneNumber.release', { phoneNumberId: 'any' }],
        ['assistant.update', { id: other.assistant.id, patch: { name: 'Taken over' } }],
        ['contact.delete', { contactId: other.contact.id }],
        ['webhook.test', { endpointId: other.webhookEndpoint.id, hook: 'call_end' }],
        // Support, not taking customer data out: no bulk export of the calls.
        ['call.export', { from: '2026-01-01', to: '2026-01-31' }],
      ]
      for (const [name, input] of refused) {
        expect(await act(as, name, input), name).toMatchObject({
          status: 403,
          body: { error: 'Not possible while signed in as another user.' },
        })
      }
      expect(await db.select().from(invitation).where(eq(invitation.email, 'admin-backdoor@linedesk.test'))).toEqual([])
      // Reading and triaging the inbox work.
      expect((await act(as, 'team.list', {})).status).toBe(200)
      expect((await act(as, 'call.markRead', { callId: other.call.id })).status).toBe(200)
      expect((await act(as, 'call.markDone', { callId: other.call.id })).status).toBe(200)
      await stop(as)
    } finally {
      await db.update(memberTable).set({ role: 'member' }).where(targetMember)
      await db.update(memberTable).set({ role: 'owner' }).where(otherOwner)
    }
  })

  test('no role changes while impersonating, even as an owner', async () => {
    const targetMember = and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, target.userId))
    // One owner per workspace: `other`'s owner steps aside for the test and gets it back after.
    const otherOwner = and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, other.owner.userId))
    await db.update(memberTable).set({ role: 'admin' }).where(otherOwner)
    await db.update(memberTable).set({ role: 'owner' }).where(targetMember)
    try {
      const { as } = await start(operator, target.userId)
      const [someone] = await db
        .select()
        .from(memberTable)
        .where(and(eq(memberTable.organizationId, other.id), sql`${memberTable.userId} <> ${target.userId}`))
      const res = await act(as, 'team.setRole', { memberId: someone!.id, role: 'owner' })
      expect(res.status).not.toBe(200)
      expect(JSON.stringify(res.body)).toContain('Not possible while signed in as another user.')
      expect((await db.select().from(memberTable).where(eq(memberTable.id, someone!.id)))[0]!.role).toBe(someone!.role)
      await stop(as)
    } finally {
      await db.update(memberTable).set({ role: 'member' }).where(targetMember)
      await db.update(memberTable).set({ role: 'owner' }).where(otherOwner)
    }
  })

  test("nothing that changes the account's credentials or security works while impersonating", async () => {
    const { as } = await start(operator, target.userId)
    const authCall = (path: string, body?: unknown) =>
      request(as, body === undefined ? 'GET' : 'POST', `/api/auth${path}`, body)
    const refused = [
      await authCall('/change-password', {
        currentPassword: 'test-password-1234',
        newPassword: 'another-password-5678',
      }),
      await authCall('/change-email', { newEmail: 'taken-over@linedesk.test' }),
      await authCall('/delete-user', {}),
      await authCall('/revoke-other-sessions', {}),
      await authCall('/revoke-sessions', {}),
      await authCall('/list-sessions'),
      await authCall('/list-accounts'),
      await authCall('/unlink-account', { providerId: 'credential' }),
      // No testing guesses at their password, no changing their profile.
      await authCall('/verify-password', { password: 'test-password-1234' }),
      await authCall('/update-user', { name: 'Taken over' }),
      // Passkeys: no adding, renaming, removing or listing them as the user.
      await authCall('/passkey/generate-register-options'),
      await authCall('/passkey/verify-registration', { response: {} }),
      await authCall('/passkey/update-passkey', { id: 'any', name: 'Taken over' }),
      await authCall('/passkey/delete-passkey', { id: 'any' }),
      await authCall('/passkey/list-user-passkeys'),
    ]
    for (const res of refused) {
      expect(res).toMatchObject({ status: 403, body: { message: 'Not possible while signed in as another user.' } })
    }
    expect((await request(as, 'POST', '/v1/account/password', { newPassword: 'another-password-5678' })).status).toBe(
      403,
    )
    // No workspace made as the user either: it would outlast the hour.
    expect(await request(as, 'POST', '/v1/workspaces', { name: 'Made while impersonating' })).toMatchObject({
      status: 403,
      body: { error: 'Not possible while signed in as another user.' },
    })
    // No joining a workspace as the user: not through Better Auth's endpoint, not through the registry.
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, target.userId))
    const [invite] = await db
      .insert(invitation)
      .values({
        id: `inv_${crypto.randomUUID()}`,
        organizationId: home.id,
        email: await emailOf(target),
        role: 'admin',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: operator.userId,
      })
      .returning()
    expect(await authCall('/organization/accept-invitation', { invitationId: invite!.id })).toMatchObject({
      status: 403,
      body: { message: 'Not possible while signed in as another user.' },
    })
    // Refused centrally now (run-action), before the handler's own refusal.
    expect(await act(as, 'invitation.accept', { invitationId: invite!.id })).toMatchObject({
      status: 403,
      body: { error: 'Not possible while signed in as another user.' },
    })
    expect(await act(as, 'invitation.decline', { invitationId: invite!.id })).toMatchObject({ status: 403 })
    expect((await db.select().from(invitation).where(eq(invitation.id, invite!.id)))[0]?.status).toBe('pending')
    expect(
      (await db.select().from(memberTable).where(eq(memberTable.userId, target.userId))).map(m => m.organizationId),
    ).toEqual([other.id])
    await db.delete(invitation).where(eq(invitation.id, invite!.id))
    // Still the same account, email and password.
    expect((await db.select().from(user).where(eq(user.id, target.userId)))[0]!.email).toBe(await emailOf(target))
    expect((await signIn(target)).status).toBe(200)
    await stop(as)
  })

  test('normal actions run as the user and the command log names the admin; it cannot outlast its hour', async () => {
    const { as } = await start(operator, target.userId)
    const key = crypto.randomUUID()
    expect((await act(as, 'call.markRead', { callId: other.call.id }, key)).status).toBe(200)
    // A tab names the user's workspace: works. The admin's own workspace is not the user's: refused.
    const inTab = (workspaceId: string) =>
      request(as, 'POST', '/v1/actions/call.markUnread', { callId: other.call.id }, { 'x-workspace-id': workspaceId })
    expect((await inTab(other.id)).status).toBe(200)
    expect(await inTab(home.id)).toMatchObject({ status: 403, body: { code: 'workspace_access_lost' } })
    expect((await db.select().from(commands).where(eq(commands.id, key)))[0]).toMatchObject({
      actor_id: target.userId,
      impersonated_by: operator.userId,
      workspace_id: other.id,
    })
    // Without the "not remembered" cookie Better Auth would extend a used session to 30 days: it keeps its expiry.
    const [started] = await impersonations()
    expect((await getSession(withCookie(as, DONT_REMEMBER, null)))?.user.id).toBe(target.userId)
    expect((await impersonations())[0]!.expiresAt).toEqual(started!.expiresAt)
    // An hour after it started, the session is refused whatever its expiry says.
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 61 * 60_000), expiresAt: new Date(Date.now() + 7 * 864e5) })
      .where(eq(session.id, started!.id))
    expect((await request(as, 'GET', '/v1/me')).status).toBe(401)
    await db.delete(session).where(eq(session.id, started!.id))
  })

  test('stop: deletes the impersonation session and signs the admin back in to their own session; both commands are logged', async () => {
    const { as, body } = await start(operator, target.userId)
    const back = await stop(as)
    expect(back).toMatchObject({ status: 200, body: { ok: true, resumed: true } })
    expect(await db.select().from(session).where(eq(session.id, body.data.sessionId))).toEqual([])
    expect(cookiesOf(back.as).has(ADMIN_SESSION)).toBe(false)
    expect(cookiesOf(back.as).get(SESSION)).toBe(cookiesOf(operator).get(SESSION))
    const me = (await request(back.as, 'GET', '/v1/me')).body
    expect(me).toMatchObject({ actorId: operator.userId, impersonation: null })
    expect(me.permissions).toContain('instance:admin')
    const log = await db
      .select()
      .from(commands)
      .where(sql`${commands.action} in ('user.impersonate', 'impersonation.stop') and ${commands.rejected} = false`)
    const started = log.find(
      c =>
        c.action === 'user.impersonate' &&
        (c.result as { data: { sessionId: string } }).data.sessionId === body.data.sessionId,
    )
    expect(started).toMatchObject({
      actor_id: operator.userId,
      impersonated_by: null,
      input: { userId: target.userId },
    })
    expect(log.filter(c => c.action === 'impersonation.stop').at(-1)).toMatchObject({
      actor_id: target.userId,
      impersonated_by: operator.userId,
    })
    // No session token ever lands in the command log.
    for (const row of log) expect(JSON.stringify(row)).not.toMatch(/token/i)
  })

  test('stop with a tampered, foreign or missing admin cookie only signs out; the admin session is left alone', async () => {
    const foreign = (await sessionsOf(other.owner.userId))[0]!
    const cases: ((as: Caller) => Caller)[] = [
      as => withCookie(as, ADMIN_SESSION, `${cookiesOf(as).get(ADMIN_SESSION)!.slice(0, -9)}AAAAAA%3D`),
      as => withCookie(as, ADMIN_SESSION, encodeURIComponent(`${foreign.token}:.forged`)),
      as => withCookie(as, ADMIN_SESSION, null),
    ]
    for (const tamper of cases) {
      const { as, body } = await start(operator, target.userId)
      const back = await stop(tamper(as))
      expect(back).toMatchObject({ status: 200, body: { resumed: false } })
      expect(cookiesOf(back.as).has(SESSION)).toBe(false)
      expect(await getSession(back.as)).toBeNull()
      expect(await db.select().from(session).where(eq(session.id, body.data.sessionId))).toEqual([])
    }
    expect((await request(operator, 'GET', '/v1/me')).body.permissions).toContain('instance:admin')
  })

  test('stop is refused for a session that is no impersonation', async () => {
    expect((await stop(operator)).status).toBe(403)
    expect((await stop(target)).status).toBe(403)
  })

  test('a reason is required: missing, blank or too short is refused and no session is made', async () => {
    for (const reason of [undefined, '', '   ', 'ok']) {
      const res = await post(operator, '/v1/impersonation/start', { userId: target.userId, reason })
      expect(res.status, String(reason)).toBe(422)
      expect(afterResponse(operator, res).headers.cookie).toBe(operator.headers.cookie)
    }
    expect((await start(operator, target.userId, { reason: 'x'.repeat(301) })).status).toBe(422)
    expect(await impersonations()).toEqual([])
  })

  test('workspaceId opens the session in that workspace of the user; one they are not a member of is refused', async () => {
    const both = await addMember(other.id, 'member')
    expect(
      (await act(operator, 'membership.add', { userId: both.userId, workspaceId: home.id, role: 'member' })).status,
    ).toBe(200)
    const { status, body, as } = await start(operator, both.userId, { workspaceId: home.id })
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ workspaceId: home.id, subject: { workspaceId: home.id } })
    const [started] = (await sessionsOf(both.userId)).filter(s => s.impersonatedBy)
    expect(started).toMatchObject({ activeOrganizationId: home.id })
    expect((await request(as, 'GET', '/v1/me')).body).toMatchObject({ workspace: { id: home.id } })
    await stop(as)
    // Not a member of `home`: refused, no session, no cookie.
    const refused = await start(operator, target.userId, { workspaceId: home.id })
    expect(refused).toMatchObject({ status: 409, body: { error: 'this user is not a member of that workspace' } })
    expect(refused.as.headers.cookie).toBe(operator.headers.cookie)
    expect(await impersonations()).toEqual([])
  })

  test('the start keeps the reason and whom it was in the audit log, filed under the workspace', async () => {
    const { as } = await start(operator, target.userId, { reason: 'Ticket 77: calls missing' })
    await stop(as)
    const { entries } = (await request(operator, 'GET', '/v1/admin/audit?kind=impersonation&limit=20')).body
    const entry = entries.find(
      (e: { what: string; at: string }) => e.what === 'user.impersonate' && Date.now() - Date.parse(e.at) < 60_000,
    )
    expect(entry).toMatchObject({
      actor: { id: operator.userId },
      input: { userId: target.userId, reason: 'Ticket 77: calls missing' },
      subject: { email: await emailOf(target) },
      workspace: { id: other.id },
    })
  })

  test('API keys stay possible while signed in as the user: the key and the command name the admin, the list marks it', async () => {
    const targetMember = and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, target.userId))
    const otherOwner = and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, other.owner.userId))
    await db.update(memberTable).set({ role: 'admin' }).where(otherOwner)
    await db.update(memberTable).set({ role: 'owner' }).where(targetMember)
    try {
      const { as } = await start(operator, target.userId)
      const key = crypto.randomUUID()
      const made = await act(as, 'apiKey.create', { name: 'Support made', role: 'member' }, key)
      expect(made.status).toBe(200)
      const [row] = await db.select().from(api_keys).where(eq(api_keys.id, made.body.data.apiKeyId))
      expect(row).toMatchObject({ created_by: target.userId, created_by_impersonator: operator.userId })
      expect((await db.select().from(commands).where(eq(commands.id, key)))[0]).toMatchObject({
        actor_id: target.userId,
        impersonated_by: operator.userId,
      })
      const listed = (await act(as, 'apiKey.list', {})).body.data.keys
      expect(listed.find((k: { id: string }) => k.id === row!.id)).toMatchObject({ created_during_support: true })
      expect(JSON.stringify(listed)).not.toContain(operator.userId)
      expect((await act(as, 'apiKey.revoke', { apiKeyId: row!.id })).status).toBe(200)
      await stop(as)
      // The user's own keys are not marked.
      const own = await act(target, 'apiKey.create', { name: 'Mine', role: 'member' })
      const mine = (await act(target, 'apiKey.list', {})).body.data.keys
      expect(mine.find((k: { id: string }) => k.id === own.body.data.apiKeyId)).toMatchObject({
        created_during_support: false,
      })
      // An API key still never manages keys.
      expect(
        (
          await request(
            { headers: { authorization: `Bearer ${own.body.data.key}` } },
            'POST',
            '/v1/actions/apiKey.list',
            {},
          )
        ).status,
      ).toBe(403)
    } finally {
      await db.update(memberTable).set({ role: 'member' }).where(targetMember)
      await db.update(memberTable).set({ role: 'owner' }).where(otherOwner)
    }
  })

  describe('API keys made during support access', () => {
    const bearer = (key: string): Caller => ({ headers: { authorization: `Bearer ${key}` } })
    const targetMember = () => and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, target.userId))
    const otherOwner = () => and(eq(memberTable.organizationId, other.id), eq(memberTable.userId, other.owner.userId))
    // The user is the workspace's owner here, so an admin key would work for them.
    beforeEach(async () => {
      await db.update(memberTable).set({ role: 'admin' }).where(otherOwner())
      await db.update(memberTable).set({ role: 'owner' }).where(targetMember())
    })
    afterEach(async () => {
      await db.update(memberTable).set({ role: 'member' }).where(targetMember())
      await db.update(memberTable).set({ role: 'owner' }).where(otherOwner())
      vi.restoreAllMocks()
    })

    test('such a key has every feature of a normal key: the asked role, call.export, and the admin revokes any key', async () => {
      const own = await act(target, 'apiKey.create', { name: "The user's", role: 'member' })
      const { as } = await start(operator, target.userId)
      const revokeCmd = crypto.randomUUID()
      const made = await act(as, 'apiKey.create', { name: 'Support admin key', role: 'admin' })
      try {
        expect(made.status).toBe(200)
        const [row] = await db.select().from(api_keys).where(eq(api_keys.id, made.body.data.apiKeyId))
        expect(row).toMatchObject({ role: 'admin', created_by_impersonator: operator.userId })
        // Revoking any key of the workspace, like the user could; the command names the admin.
        expect((await act(as, 'apiKey.revoke', { apiKeyId: own.body.data.apiKeyId }, revokeCmd)).status).toBe(200)
      } finally {
        await stop(as)
      }
      expect((await db.select().from(commands).where(eq(commands.id, revokeCmd)))[0]).toMatchObject({
        actor_id: target.userId,
        impersonated_by: operator.userId,
      })
      expect(
        (await act(bearer(made.body.data.key), 'call.export', { from: '2026-01-01', to: '2026-01-31' })).status,
      ).toBe(200)
    })

    test("every command the key runs records the admin; the user's own key records nobody", async () => {
      const { as } = await start(operator, target.userId)
      const made = await act(as, 'apiKey.create', { name: 'Support integration', role: 'member' })
      await stop(as)
      const cmd = crypto.randomUUID()
      expect((await act(bearer(made.body.data.key), 'call.markRead', { callId: other.call.id }, cmd)).status).toBe(200)
      expect((await db.select().from(commands).where(eq(commands.id, cmd)))[0]).toMatchObject({
        actor_id: `apikey:${made.body.data.apiKeyId}`,
        impersonated_by: operator.userId,
      })
      // The audit log lists it under impersonation, naming the admin.
      const { entries } = (await request(operator, 'GET', '/v1/admin/audit?kind=impersonation&limit=50')).body
      expect(
        entries.find(
          (e: { id?: string; what: string; impersonatedBy?: unknown }) =>
            e.what === 'call.markRead' &&
            (e as { input?: { callId?: string } }).input?.callId === other.call.id &&
            e.impersonatedBy,
        ),
      ).toMatchObject({
        impersonatedBy: { id: operator.userId },
      })
      const own = await act(target, 'apiKey.create', { name: 'Own key', role: 'member' })
      const ownCmd = crypto.randomUUID()
      expect((await act(bearer(own.body.data.key), 'call.markRead', { callId: other.call.id }, ownCmd)).status).toBe(
        200,
      )
      expect((await db.select().from(commands).where(eq(commands.id, ownCmd)))[0]).toMatchObject({
        impersonated_by: null,
      })
    })

    test('call.export with such a key leaves a command row naming the admin; with a normal key, none', async () => {
      const exports = async () => db.select().from(commands).where(eq(commands.action, 'call.export'))
      const range = { from: '2026-01-01', to: '2026-01-31' }
      const { as } = await start(operator, target.userId)
      const made = await act(as, 'apiKey.create', { name: 'Support export', role: 'admin' })
      await stop(as)
      const before = (await exports()).map(r => r.id)
      expect((await act(bearer(made.body.data.key), 'call.export', range)).status).toBe(200)
      const logged = (await exports()).filter(r => !before.includes(r.id))
      expect(logged).toHaveLength(1)
      expect(logged[0]).toMatchObject({
        actor_id: `apikey:${made.body.data.apiKeyId}`,
        impersonated_by: operator.userId,
        workspace_id: other.id,
        input: { from: range.from, to: range.to },
        result: { ok: true, rows: {} },
      })
      // In the audit log, under impersonation, naming the admin.
      const { entries } = (await request(operator, 'GET', '/v1/admin/audit?kind=impersonation&limit=50')).body
      expect(entries.find((e: { id?: string; what: string }) => e.what === 'call.export')).toMatchObject({
        impersonatedBy: { id: operator.userId },
      })
      // The user's own key: a read as before, no row.
      const own = await act(target, 'apiKey.create', { name: 'Own export', role: 'admin' })
      const ownBefore = (await exports()).length
      expect((await act(bearer(own.body.data.key), 'call.export', range)).status).toBe(200)
      expect(await exports()).toHaveLength(ownBefore)
    })

    test('the list names the admin who made the key', async () => {
      const { as } = await start(operator, target.userId)
      try {
        const made = await act(as, 'apiKey.create', { name: 'Named', role: 'member' })
        const [admin] = await db.select().from(user).where(eq(user.id, operator.userId))
        const listed = (await act(as, 'apiKey.list', {})).body.data.keys
        expect(listed.find((k: { id: string }) => k.id === made.body.data.apiKeyId)).toMatchObject({
          created_during_support: true,
          created_during_support_by: admin!.name || admin!.email,
        })
      } finally {
        await stop(as)
      }
      const own = await act(target, 'apiKey.create', { name: 'Not named', role: 'member' })
      const mine = (await act(target, 'apiKey.list', {})).body.data.keys
      expect(mine.find((k: { id: string }) => k.id === own.body.data.apiKeyId)).toMatchObject({
        created_during_support: false,
        created_during_support_by: null,
      })
    })

  })

  test('the audit log has the start, what was done as the user, and the stop, each naming the admin', async () => {
    const { as } = await start(operator, target.userId)
    expect((await act(as, 'call.markRead', { callId: other.call.id })).status).toBe(200)
    await stop(as)
    const { entries } = (await request(operator, 'GET', '/v1/admin/audit?kind=impersonation&limit=10')).body
    const mine = entries.filter((e: { at: string }) => Date.now() - Date.parse(e.at) < 60_000)
    const what = mine.map((e: { what: string }) => e.what)
    expect(what).toEqual(expect.arrayContaining(['user.impersonate', 'call.markRead', 'impersonation.stop']))
    const asUser = mine.find((e: { what: string }) => e.what === 'call.markRead')
    expect(asUser).toMatchObject({
      kind: 'impersonation',
      actor: { id: target.userId },
      impersonatedBy: { id: operator.userId },
    })
    // Everyday actions without impersonation are not audit entries.
    await act(target, 'call.markRead', { callId: other.call.id })
    const all = (await request(operator, 'GET', '/v1/admin/audit?limit=200')).body.entries
    expect(
      all.filter((e: { what: string; impersonatedBy: unknown }) => e.what === 'call.markRead' && !e.impersonatedBy),
    ).toEqual([])
  })
})

describe('memberships across workspaces', () => {
  const membersOf = async (wsId: string) =>
    (await request(operator, 'GET', `/v1/admin/workspaces/${wsId}/members`)).body
  const memberRow = async (wsId: string, who: User) =>
    (await db.select().from(memberTable).where(eq(memberTable.userId, who.userId))).find(m => m.organizationId === wsId)
  const userRow = async (who: User) =>
    (await request(operator, 'GET', '/v1/admin/users')).body.users.find((u: { id: string }) => u.id === who.userId)

  test('an instance admin adds an existing user to any workspace, changes the role and removes them; all logged', async () => {
    const outsider = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, outsider.userId))
    const added = await act(operator, 'membership.add', {
      userId: outsider.userId,
      workspaceId: other.id,
      role: 'admin',
    })
    expect(added).toMatchObject({ status: 200, body: { ok: true } })
    expect(await memberRow(other.id, outsider)).toMatchObject({ role: 'admin' })
    expect((await membersOf(other.id)).members.map((m: { email: string; role: string }) => m.role)).toContain('admin')
    expect((await userRow(outsider)).workspaces).toEqual([
      { id: other.id, name: 'Brightwater Plumbing & Heating', role: 'admin', member_id: added.body.data.memberId },
    ])
    // The workspace's own owner sees the new member at once.
    expect(
      (await act(other.owner, 'team.list', {})).body.data.members.some(
        (m: { userId: string }) => m.userId === outsider.userId,
      ),
    ).toBe(true)
    expect(
      await act(operator, 'membership.add', { userId: outsider.userId, workspaceId: other.id, role: 'member' }),
    ).toMatchObject({
      status: 409,
      body: { error: expect.stringMatching(/already a member/) },
    })
    const memberId = added.body.data.memberId
    expect((await act(operator, 'membership.setRole', { memberId, role: 'member' })).status).toBe(200)
    expect(await memberRow(other.id, outsider)).toMatchObject({ role: 'member' })
    expect((await act(operator, 'membership.remove', { memberId })).status).toBe(200)
    expect(await memberRow(other.id, outsider)).toBeUndefined()
    const log = await db.select().from(commands).where(eq(commands.actor_id, operator.userId))
    expect(log.filter(c => c.action.startsWith('membership.')).map(c => c.action)).toEqual(
      expect.arrayContaining(['membership.add', 'membership.setRole', 'membership.remove']),
    )
  })

  test('the owner can be neither demoted nor removed, and there is no second owner; making someone owner hands it over', async () => {
    const ws = await createWorkspace('Last Owner Test')
    const ownerId = (await memberRow(ws.id, ws.owner))!.id
    const stays = { status: 409, body: { error: 'the workspace needs its owner: make someone else the owner first' } }
    expect(await act(operator, 'membership.setRole', { memberId: ownerId, role: 'admin' })).toMatchObject(stays)
    expect(await act(operator, 'membership.remove', { memberId: ownerId })).toMatchObject(stays)
    expect(await memberRow(ws.id, ws.owner)).toMatchObject({ role: 'owner' })
    const second = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, second.userId))
    expect(
      (await act(operator, 'membership.add', { userId: second.userId, workspaceId: ws.id, role: 'owner' })).body.error,
    ).toMatch(/has an owner already/)
    const added = await act(operator, 'membership.add', { userId: second.userId, workspaceId: ws.id, role: 'admin' })
    expect(added.status).toBe(200)
    // Making them owner is a transfer: the previous owner becomes an admin, and can then be removed.
    expect(
      (await act(operator, 'membership.setRole', { memberId: added.body.data.memberId, role: 'owner' })).status,
    ).toBe(200)
    expect(await memberRow(ws.id, second)).toMatchObject({ role: 'owner' })
    expect(await memberRow(ws.id, ws.owner)).toMatchObject({ role: 'admin' })
    expect((await act(operator, 'membership.remove', { memberId: ownerId })).status).toBe(200)
  })

  test("removing someone from their last workspace deletes the account by default; keepAccount keeps it; a server admin's never goes", async () => {
    const ws = await createWorkspace('Last Workspace Removal')
    const exists = async (who: User) => (await db.select().from(user).where(eq(user.id, who.userId))).length === 1
    const gone = await addMember(ws.id, 'member')
    expect(await act(operator, 'membership.remove', { memberId: (await memberRow(ws.id, gone))!.id })).toMatchObject({
      status: 200,
      body: { data: { accountDeleted: true } },
    })
    expect(await exists(gone)).toBe(false)

    const kept = await addMember(ws.id, 'member')
    expect(
      await act(operator, 'membership.remove', { memberId: (await memberRow(ws.id, kept))!.id, keepAccount: true }),
    ).toMatchObject({ status: 200, body: { data: { accountDeleted: false } } })
    expect(await exists(kept)).toBe(true)

    const serverAdmin = await addMember(ws.id, 'admin')
    await setAdmin(serverAdmin, true)
    try {
      expect(
        await act(operator, 'membership.remove', { memberId: (await memberRow(ws.id, serverAdmin))!.id }),
      ).toMatchObject({
        status: 200,
        body: { data: { accountDeleted: false } },
      })
      expect(await exists(serverAdmin)).toBe(true)
    } finally {
      await setAdmin(serverAdmin, false)
    }
  })

  test('a hand-over at the same moment: membership.setRole waits for it and then refuses to demote the new owner (#734 review, finding 3)', async () => {
    const ws = await createWorkspace('Hand Over Race')
    const next = await addMember(ws.id, 'admin')
    const ownerId = (await memberRow(ws.id, ws.owner))!.id
    const nextId = (await memberRow(ws.id, next))!.id
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let locked!: () => void
    const isLocked = new Promise<void>(resolve => {
      locked = resolve
    })
    // The hand-over (as team.transferOwnership does it) holds the new owner's row while it runs.
    const handOver = db.transaction(async tx => {
      await tx.select().from(memberTable).where(eq(memberTable.id, nextId)).for('update')
      locked()
      await held
      await tx.update(memberTable).set({ role: 'admin' }).where(eq(memberTable.id, ownerId))
      await tx.update(memberTable).set({ role: 'owner' }).where(eq(memberTable.id, nextId))
    })
    await isLocked
    const demote = act(operator, 'membership.setRole', { memberId: nextId, role: 'member' })
    await new Promise(resolve => setTimeout(resolve, 200))
    release()
    await handOver
    expect(await demote).toMatchObject({
      status: 409,
      body: { error: 'the workspace needs its owner: make someone else the owner first' },
    })
    expect(await memberRow(ws.id, next)).toMatchObject({ role: 'owner' })
  })

  test('one membership per user and workspace: the database refuses a second row', async () => {
    const row = await memberRow(other.id, member)
    await expect(
      db.insert(memberTable).values({
        id: `dup_${crypto.randomUUID()}`,
        organizationId: other.id,
        userId: member.userId,
        role: 'admin',
        createdAt: new Date(),
      }),
    ).rejects.toThrow()
    expect(
      (await db.select().from(memberTable).where(eq(memberTable.userId, member.userId))).filter(
        m => m.organizationId === other.id,
      ),
    ).toEqual([row])
  })

  test('unknown users, workspaces, members and invitations are refused', async () => {
    expect(
      (await act(operator, 'membership.add', { userId: 'nope', workspaceId: other.id, role: 'member' })).body.error,
    ).toBe('user not found')
    expect(
      (await act(operator, 'membership.add', { userId: member.userId, workspaceId: 'nope', role: 'member' })).body
        .error,
    ).toBe('workspace not found')
    expect((await act(operator, 'membership.remove', { memberId: 'nope' })).body.error).toBe('member not found')
    expect((await act(operator, 'invitation.revoke', { invitationId: 'nope' })).body.error).toBe('invitation not found')
  })

  test('pending invitations show on the workspace and the user; the admin revokes and resends them; adding answers them', async () => {
    const sent: string[] = []
    const texts: string[] = []
    const send = vi.spyOn(emailSender, 'send').mockImplementation(async e => {
      sent.push(e.to)
      texts.push(e.text)
    })
    vi.spyOn(emailSender, 'kind', 'get').mockReturnValue('log')
    try {
      const invitee = await signUp()
      const email = (await emailOf(invitee)).toUpperCase()
      const invited = await act(other.owner, 'team.invite', { email: email.toLowerCase(), role: 'member' })
      const invitationId = invited.body.data.invitationId
      expect((await membersOf(other.id)).invitations).toEqual([
        expect.objectContaining({ id: invitationId, email: email.toLowerCase(), role: 'member', expired: false }),
      ])
      expect((await userRow(invitee)).invitations).toEqual([
        expect.objectContaining({ id: invitationId, workspace_id: other.id, role: 'member' }),
      ])
      await db.update(user).set({ name: 'Mike Brennan' }).where(eq(user.id, other.owner.userId))
      await db.update(user).set({ name: 'Ops Admin' }).where(eq(user.id, operator.userId))
      expect((await act(operator, 'invitation.resend', { invitationId })).status).toBe(200)
      expect(sent.filter(to => to === email.toLowerCase())).toHaveLength(2)
      // The resent email names who invited them, not the instance admin who resent it.
      expect(texts.at(-1)).toMatch(/^Mike Brennan invited you/m)
      expect(texts.at(-1)).not.toMatch(/Ops Admin/)
      await db
        .update(user)
        .set({ name: 'Test User' })
        .where(inArray(user.id, [other.owner.userId, operator.userId]))
      expect((await act(operator, 'invitation.revoke', { invitationId })).status).toBe(200)
      expect((await membersOf(other.id)).invitations).toEqual([])
      // An invitation that is still open is answered by adding the user directly (their address confirmed).
      await db.update(user).set({ emailVerified: true }).where(eq(user.id, invitee.userId))
      const again = (await act(other.owner, 'team.invite', { email: email.toLowerCase(), role: 'admin' })).body.data
        .invitationId
      expect(
        (await act(operator, 'membership.add', { userId: invitee.userId, workspaceId: other.id, role: 'member' }))
          .status,
      ).toBe(200)
      expect((await db.select().from(invitation).where(eq(invitation.id, again)))[0]?.status).toBe('canceled')
    } finally {
      send.mockRestore()
      vi.restoreAllMocks()
    }
  })

  test('an accepted invitation can no longer be revoked or resent', async () => {
    const invitee = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, invitee.userId))
    const [invite] = await db
      .insert(invitation)
      .values({
        id: `inv_${crypto.randomUUID()}`,
        organizationId: home.id,
        email: await emailOf(invitee),
        role: 'member',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
        inviterId: operator.userId,
      })
      .returning()
    const accepted = await request(
      invitee,
      'POST',
      '/api/auth/organization/accept-invitation',
      { invitationId: invite!.id },
      { [FROM]: randomIp() },
    )
    expect(accepted.status).toBe(200)
    for (const name of ['invitation.revoke', 'invitation.resend'])
      expect(await act(operator, name, { invitationId: invite!.id })).toMatchObject({
        status: 409,
        body: { error: 'invitation not found' },
      })
    expect((await db.select().from(invitation).where(eq(invitation.id, invite!.id)))[0]?.status).toBe('accepted')
    // Adding the same person again is refused with a clear reason.
    expect(
      await act(operator, 'membership.add', { userId: invitee.userId, workspaceId: home.id, role: 'admin' }),
    ).toMatchObject({
      status: 409,
      body: { error: expect.stringMatching(/already a member of Linedesk Operations/) },
    })
  })

  test('an unconfirmed account is invited, not added, and the owners are told; never made owner or admin', async () => {
    const send = vi.spyOn(emailSender, 'send').mockImplementation(async () => {})
    try {
      const ws = await createWorkspace('Unconfirmed Adds Roofing')
      const unconfirmed = await signUp()
      const email = await emailOf(unconfirmed)
      const res = await act(operator, 'membership.add', {
        userId: unconfirmed.userId,
        workspaceId: ws.id,
        role: 'admin',
      })
      expect(res).toMatchObject({ status: 200, body: { data: { memberId: null, joined: 'invited' } } })
      expect(await memberRow(ws.id, unconfirmed)).toBeUndefined()
      const [invite] = await db
        .select()
        .from(invitation)
        .where(and(eq(invitation.email, email), eq(invitation.organizationId, ws.id)))
      expect(invite).toMatchObject({ role: 'admin', status: 'pending', inviterId: operator.userId })
      const owner = await emailOf(ws.owner)
      expect(send.mock.calls.map(([m]) => m).filter(m => m.to === owner)).toHaveLength(1)
      // A membership an unconfirmed account already has (an older add) cannot become owner or admin.
      const memberId = `m_${crypto.randomUUID().slice(0, 12)}`
      await db.delete(invitation).where(eq(invitation.id, invite!.id))
      await db.insert(memberTable).values({
        id: memberId,
        organizationId: ws.id,
        userId: unconfirmed.userId,
        role: 'member',
        createdAt: new Date(),
      })
      for (const role of ['owner', 'admin'])
        expect(await act(operator, 'membership.setRole', { memberId, role })).toMatchObject({
          status: 409,
          body: { error: `${email} must confirm their email address before they can be ${role}` },
        })
      expect((await act(operator, 'membership.setRole', { memberId, role: 'member' })).status).toBe(200)
    } finally {
      send.mockRestore()
    }
  })

  test('a disabled account or workspace is refused', async () => {
    const ws = await createWorkspace('Disabled Adds Electric')
    const someone = await signUp()
    await db.update(user).set({ emailVerified: true, disabledAt: new Date() }).where(eq(user.id, someone.userId))
    expect(
      (await act(operator, 'membership.add', { userId: someone.userId, workspaceId: ws.id, role: 'member' })).body
        .error,
    ).toBe(`${await emailOf(someone)} is disabled: enable the account first`)
    await db.update(user).set({ disabledAt: null }).where(eq(user.id, someone.userId))
    expect((await act(operator, 'workspace.disable', { workspaceId: ws.id })).status).toBe(200)
    expect(
      (await act(operator, 'membership.add', { userId: someone.userId, workspaceId: ws.id, role: 'member' })).body
        .error,
    ).toBe('Disabled Adds Electric is disabled: enable it first')
    expect(await memberRow(ws.id, someone)).toBeUndefined()
  })

  test("a workspace owner who is no instance admin cannot read another workspace's members", async () => {
    expect((await request(other.owner, 'GET', `/v1/admin/workspaces/${home.id}/members`)).status).toBe(403)
  })
})

describe('second factor for instance admins (ADMIN_SECOND_FACTOR on)', () => {
  const PASSKEY_PATH = '/passkey/verify-authentication'
  const HOUR = 3_600_000
  let admin: User
  const sessionOfAdmin = (values: {
    passkeyVerifiedAt?: Date | null
    impersonatedBy?: string | null
    createdAt?: Date
  }) => db.update(session).set(values).where(eq(session.userId, admin.userId))
  const confirmEmail = (emailVerified: boolean) =>
    db.update(user).set({ emailVerified }).where(eq(user.id, admin.userId))
  const addPasskey = () =>
    db.insert(passkey).values({
      id: `pk_${crypto.randomUUID().slice(0, 12)}`,
      userId: admin.userId,
      publicKey: 'cHVibGlj',
      credentialID: `cred-${crypto.randomUUID()}`,
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
    })
  /** The browser's cookie from a sign-in response, as a caller of its own. */
  const callerFrom = (res: Response): User => ({
    userId: admin.userId,
    headers: {
      cookie: res.headers
        .getSetCookie()
        .map(c => c.split(';')[0])
        .join('; '),
      origin: 'http://localhost:5173',
    },
  })

  beforeAll(async () => {
    admin = await signUp()
    await setAdmin(admin, true)
    // A confirmed address: an unconfirmed one cannot add passkeys at all.
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, admin.userId))
  })
  beforeEach(async () => {
    // A confirmed admin whose sign-in was 13 hours ago, unless a test says otherwise.
    await confirmEmail(true)
    await sessionOfAdmin({ createdAt: new Date(Date.now() - 13 * HOUR) })
  })
  afterEach(async () => {
    process.env.ADMIN_SECOND_FACTOR = 'off'
    vi.restoreAllMocks()
    await db.delete(passkey).where(eq(passkey.userId, admin.userId))
    await sessionOfAdmin({ passkeyVerifiedAt: null, impersonatedBy: null })
  })

  /** Every instance-admin action and admin read, refused with SECOND_FACTOR_REQUIRED and the state `want`. */
  async function expectAllAdminRefused(caller: User, want: 'confirm' | 'enrol' | 'email') {
    for (const path of adminRoutes) {
      expect(await request(caller, 'GET', path), path).toMatchObject({
        status: 403,
        body: { code: 'SECOND_FACTOR_REQUIRED', secondFactor: want },
      })
    }
    // Table-driven over the registry: an instance-admin action added later is covered without touching this test.
    // user.impersonate runs only through its own route (POST /v1/actions refuses it before any permission check).
    expect(adminActions.length).toBeGreaterThan(20)
    for (const def of adminActions.filter(d => d.name !== 'user.impersonate')) {
      expect(await act(caller, def.name, {}), def.name).toMatchObject({
        status: 403,
        body: { code: 'SECOND_FACTOR_REQUIRED', secondFactor: want },
      })
    }
    expect(await request(caller, 'POST', '/v1/impersonation/start', { userId: member.userId })).toMatchObject({
      status: 403,
      body: { code: 'SECOND_FACTOR_REQUIRED', secondFactor: want },
    })
  }

  test('a session without the passkey check, even a sign-in a minute old: no instance:admin, every admin route and action refused', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await addPasskey()
    await sessionOfAdmin({ createdAt: new Date(Date.now() - 60_000) })
    const me = (await request(admin, 'GET', '/v1/me')).body
    expect(me.permissions).not.toContain('instance:admin')
    expect(me.adminSecondFactor).toBe('confirm')
    await expectAllAdminRefused(admin, 'confirm')
    expect((await request(other.owner, 'GET', '/v1/me')).body.adminSecondFactor).toBeNull()
  })

  test('an admin without a passkey: /v1/me and every refusal say enrol (add the first passkey with a code)', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await sessionOfAdmin({ createdAt: new Date() })
    const me = (await request(admin, 'GET', '/v1/me')).body
    expect(me.adminSecondFactor).toBe('enrol')
    expect(me.passkeyEnrolment).toBe(true)
    await expectAllAdminRefused(admin, 'enrol')
  })

  test('the passkey check opens every admin route and action for 12 hours in that session; older or in the future never', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await addPasskey()
    const status = async () => (await request(admin, 'GET', '/v1/admin/users')).status
    // A passkey sign-in (marked when the session is made, so both times are the same).
    const elevenAgo = new Date(Date.now() - 11 * HOUR)
    await sessionOfAdmin({ createdAt: elevenAgo, passkeyVerifiedAt: elevenAgo })
    const me = (await request(admin, 'GET', '/v1/me')).body
    expect(me.permissions).toContain('instance:admin')
    expect(me.adminSecondFactor).toBeNull()
    for (const path of adminRoutes) expect((await request(admin, 'GET', path)).status, path).toBe(200)
    // Every instance-admin action gets past the permission check (its own input check answers instead).
    for (const def of adminActions.filter(d => d.name !== 'user.impersonate')) {
      const res = await act(admin, def.name, {})
      expect(res.body?.code, def.name).not.toBe('SECOND_FACTOR_REQUIRED')
      expect(res.status, def.name).not.toBe(401)
    }
    const almost = new Date(Date.now() - 12 * HOUR + 60_000)
    await sessionOfAdmin({ createdAt: almost, passkeyVerifiedAt: almost })
    expect(await status()).toBe(200)
    // Past 12 hours: closed again, until the next passkey check.
    const thirteenAgo = new Date(Date.now() - 13 * HOUR)
    await sessionOfAdmin({ createdAt: thirteenAgo, passkeyVerifiedAt: thirteenAgo })
    expect(await request(admin, 'GET', '/v1/admin/users')).toMatchObject({
      status: 403,
      body: { code: 'SECOND_FACTOR_REQUIRED', secondFactor: 'confirm' },
    })
    await sessionOfAdmin({ createdAt: new Date(), passkeyVerifiedAt: new Date(Date.now() + HOUR) })
    expect(await status()).toBe(403)
  })

  test('workspace.create without an owner through /v1/actions: refused without the passkey check and while impersonating, nothing made', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await addPasskey()
    const name = `Own Biz ${crypto.randomUUID().slice(0, 6)}`
    const made = async () => db.select().from(organization).where(eq(organization.name, name))
    // A sign-in a minute old without the passkey check.
    await sessionOfAdmin({ createdAt: new Date(Date.now() - 60_000) })
    expect(await act(admin, 'workspace.create', { name })).toMatchObject({
      status: 403,
      body: { ok: false, code: 'SECOND_FACTOR_REQUIRED' },
    })
    expect(await made()).toEqual([])
    // The same session as an impersonation (by another server admin), even with a fresh passkey check.
    const by = await signUp()
    await setAdmin(by, true)
    try {
      await sessionOfAdmin({ createdAt: new Date(), passkeyVerifiedAt: new Date(), impersonatedBy: by.userId })
      const refused = await act(admin, 'workspace.create', { name })
      expect(refused.status).toBe(403)
      expect(refused.body.ok).toBe(false)
      expect(await made()).toEqual([])
      // Control: the same session with the passkey check and no impersonation does make it.
      await sessionOfAdmin({ createdAt: new Date(), passkeyVerifiedAt: new Date(), impersonatedBy: null })
      expect((await act(admin, 'workspace.create', { name })).status).toBe(200)
      expect(await made()).toHaveLength(1)
    } finally {
      await setAdmin(by, false)
      // The rest of this block expects an admin in no workspace.
      await db.delete(memberTable).where(eq(memberTable.userId, admin.userId))
      await db.delete(organization).where(eq(organization.name, name))
      await db.update(session).set({ activeOrganizationId: null }).where(eq(session.userId, admin.userId))
    }
  })

  test('signing in again with a password never opens Server admin; the workspaces work as before', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await addPasskey()
    const res = await appRequest('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173', [FROM]: randomIp() },
      body: JSON.stringify({ email: await emailOf(admin), password: 'test-password-1234' }),
    })
    expect(res.status).toBe(200)
    const fresh = callerFrom(res)
    await expectAllAdminRefused(fresh, 'confirm')
    // Creating a workspace is Server admin's: it needs the passkey check too (#728 review, finding 4).
    expect(
      await request(fresh, 'POST', '/v1/workspaces', { name: `Admin Biz ${crypto.randomUUID().slice(0, 6)}` }),
    ).toMatchObject({
      status: 403,
      body: { code: 'admin_second_factor' },
    })
    // Workspace users' level: a workspace the admin is in works with any sign-in method.
    const biz = await createWorkspace(`Admin Biz ${crypto.randomUUID().slice(0, 6)}`)
    await db.insert(memberTable).values({
      id: `m_${crypto.randomUUID().slice(0, 12)}`,
      organizationId: biz.id,
      userId: admin.userId,
      role: 'admin',
      createdAt: new Date(),
    })
    const tab = { 'x-workspace-id': biz.id }
    const me = (await request(fresh, 'GET', '/v1/me', undefined, tab)).body
    expect(me.permissions).toEqual(expect.arrayContaining(['settings:write', 'team:write']))
    expect(me.permissions).not.toContain('instance:admin')
    expect(
      (
        await request(
          fresh,
          'POST',
          '/v1/actions/workspace.rename',
          { name: `Renamed ${crypto.randomUUID().slice(0, 6)}` },
          tab,
        )
      ).status,
    ).toBe(200)
  })

  test('signing in again with an email code never opens Server admin', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await addPasskey()
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const email = await emailOf(admin)
    const headers = { origin: 'http://localhost:5173', [FROM]: randomIp() }
    expect(
      (
        await request(
          anonymous,
          'POST',
          '/api/auth/email-otp/send-verification-otp',
          { email, type: 'sign-in' },
          headers,
        )
      ).status,
    ).toBe(200)
    await vi.waitFor(() => expect(send.mock.calls.some(([m]) => m.to === email)).toBe(true))
    const otp = send.mock.calls
      .map(([m]) => m)
      .findLast(m => m.to === email)!
      .subject.slice(0, 6)
    const res = await appRequest('/api/auth/sign-in/email-otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ email, otp }),
    })
    expect(res.status).toBe(200)
    expect(await request(callerFrom(res), 'GET', '/v1/admin/users')).toMatchObject({
      status: 403,
      body: { code: 'SECOND_FACTOR_REQUIRED', secondFactor: 'confirm' },
    })
  })

  test('the rule: only a passkey check of the last 12 hours counts, whatever started the session', () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const now = Date.now()
    const fresh = { passkeyVerifiedAt: null }
    const confirmed = { passkeyVerifiedAt: new Date(now - 30 * 60_000) }
    expect(adminSecondFactorGap({ emailVerified: true }, confirmed, true, now)).toBeNull()
    expect(adminSecondFactorGap({ emailVerified: true }, fresh, true, now)).toBe('confirm')
    expect(adminSecondFactorGap({ emailVerified: true }, fresh, false, now)).toBe('enrol')
    expect(adminSecondFactorGap({ emailVerified: false }, fresh, false, now)).toBe('email')
    expect(
      adminSecondFactorGap({ emailVerified: true }, { passkeyVerifiedAt: new Date(now - 13 * HOUR) }, true, now),
    ).toBe('confirm')
    expect(adminSecondFactorGap({ emailVerified: true }, { ...confirmed, impersonatedBy: 'someone' }, true, now)).toBe(
      'confirm',
    )
    process.env.ADMIN_SECOND_FACTOR = 'off'
    expect(adminSecondFactorGap({ emailVerified: true }, fresh, false, now)).toBeNull()
  })

  test('an unconfirmed email address keeps the admin area closed, even right after signing in', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await confirmEmail(false)
    await sessionOfAdmin({ createdAt: new Date() })
    const me = (await request(admin, 'GET', '/v1/me')).body
    expect(me.permissions).not.toContain('instance:admin')
    expect(me.adminSecondFactor).toBe('email')
    expect(await request(admin, 'GET', '/v1/admin/users')).toMatchObject({
      status: 403,
      body: { code: 'SECOND_FACTOR_REQUIRED', secondFactor: 'email' },
    })
  })

  test('a recent sign-in without the passkey check cannot add or remove passkeys either (H1)', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await addPasskey()
    await sessionOfAdmin({ createdAt: new Date() })
    expect((await request(admin, 'GET', '/v1/admin/users')).status).toBe(403)
    const authCall = (path: string, body?: unknown) =>
      request(admin, body === undefined ? 'GET' : 'POST', `/api/auth${path}`, body, {
        origin: 'http://localhost:5173',
        [FROM]: randomIp(),
      })
    const [own] = await db.select().from(passkey).where(eq(passkey.userId, admin.userId))
    expect((await authCall('/passkey/generate-register-options')).body.code).toBe('PASSKEY_CONFIRMATION_REQUIRED')
    expect((await authCall('/passkey/delete-passkey', { id: own!.id })).body.code).toBe('PASSKEY_CONFIRMATION_REQUIRED')
    expect((await db.select().from(passkey).where(eq(passkey.userId, admin.userId))).length).toBe(1)
  })

  test("an admin's first passkey needs the enrolment code from the granting admin; later ones a passkey session (H1)", async () => {
    await sessionOfAdmin({ createdAt: new Date() })
    const authCall = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
      request(admin, body === undefined ? 'GET' : 'POST', `/api/auth${path}`, body, {
        origin: 'http://localhost:5173',
        [FROM]: randomIp(),
        ...extra,
      })
    const verify = (code?: string) =>
      authCall(
        '/passkey/verify-registration',
        { response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } },
        code ? { 'x-passkey-enrolment': code } : {},
      )
    // No code: a fresh session with the first factor alone cannot even start.
    await db
      .update(user)
      .set({ passkeyEnrolmentHash: null, passkeyEnrolmentExpiresAt: null })
      .where(eq(user.id, admin.userId))
    expect(await authCall('/passkey/generate-register-options')).toMatchObject({
      status: 403,
      body: { code: 'PASSKEY_ENROLMENT_REQUIRED' },
    })
    // A code issued for them (by grant, invite, reset or the CLI; reset itself is tested with user.resetPasskeys).
    const { enrolmentCode: code } = await issuePasskeyEnrolment(db, admin.userId)
    expect((await authCall('/passkey/generate-register-options')).status).toBe(200)
    // Where the passkey is stored, the code itself is needed; the right one gets past the guard to the plugin.
    expect((await verify()).body.code).toBe('PASSKEY_ENROLMENT_REQUIRED')
    expect((await verify('not-the-code')).body.code).toBe('PASSKEY_ENROLMENT_REQUIRED')
    const right = await verify(code)
    expect(right.body?.code).not.toBe('PASSKEY_ENROLMENT_REQUIRED')
    expect(right.status).not.toBe(200) // no real authenticator response
    // Expired: refused again.
    await db
      .update(user)
      .set({ passkeyEnrolmentExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(user.id, admin.userId))
    expect((await verify(code)).body.code).toBe('PASSKEY_ENROLMENT_REQUIRED')
    // With a passkey: an attacker with the mailbox or password cannot add theirs or remove the real one.
    await addPasskey()
    const [own] = await db.select().from(passkey).where(eq(passkey.userId, admin.userId))
    expect((await authCall('/passkey/generate-register-options')).body.code).toBe('PASSKEY_CONFIRMATION_REQUIRED')
    expect((await authCall('/passkey/delete-passkey', { id: own!.id })).body.code).toBe('PASSKEY_CONFIRMATION_REQUIRED')
    expect((await db.select().from(passkey).where(eq(passkey.userId, admin.userId))).length).toBe(1)
    await sessionOfAdmin({ passkeyVerifiedAt: new Date() })
    expect((await authCall('/passkey/generate-register-options')).status).toBe(200)
  })

  test('only a passkey sign-in the device verified marks a session, never an impersonation', () => {
    const plain = { userId: 'u', impersonatedBy: null }
    /** A request's context, as Better Auth hands it to the plugin and the hook; `verified`: the response's UV flag. */
    const request = (path: string, verified: boolean) => {
      const ctx = { path, context: {} }
      if (verified) noteUserVerified(ctx)
      return ctx
    }
    expect(markPasskeySession(plain, request(PASSKEY_PATH, true))?.data.passkeyVerifiedAt).toBeInstanceOf(Date)
    // Without user verification (a security key without a PIN, a device that skipped the check): no passkey check.
    expect(markPasskeySession(plain, request(PASSKEY_PATH, false))).toBeUndefined()
    expect(markPasskeySession(plain, { path: PASSKEY_PATH })).toBeUndefined()
    // Another request's verification does not carry over.
    request(PASSKEY_PATH, true)
    expect(markPasskeySession(plain, request(PASSKEY_PATH, false))).toBeUndefined()
    for (const path of ['/sign-in/email', '/sign-in/email-otp', '/callback/github', '/passkey/verify-registration'])
      expect(markPasskeySession(plain, request(path, true)), path).toBeUndefined()
    expect(markPasskeySession({ ...plain, impersonatedBy: 'admin' }, request(PASSKEY_PATH, true))).toBeUndefined()
    expect(markPasskeySession(plain, undefined)).toBeUndefined()
  })

  test('a client can neither mark its own session nor move its sign-in time', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    const rows = () => db.select().from(session).where(eq(session.userId, admin.userId)).orderBy(session.id)
    const before = await rows()
    await request(admin, 'POST', '/api/auth/update-session', {
      passkeyVerifiedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    })
    const after = await rows()
    expect(after.map(row => row.passkeyVerifiedAt)).toEqual(before.map(() => null))
    expect(after.map(row => row.createdAt.getTime())).toEqual(before.map(row => row.createdAt.getTime()))
    // Still the gap of an admin without a passkey: nothing the client sent counts as the passkey check.
    expect((await request(admin, 'GET', '/v1/me')).body.adminSecondFactor).toBe('enrol')
  })

  test('an impersonation session never counts, even a fresh one whose row says passkey', async () => {
    process.env.ADMIN_SECOND_FACTOR = 'on'
    await sessionOfAdmin({ passkeyVerifiedAt: new Date(), impersonatedBy: operator.userId, createdAt: new Date() })
    const me = (await request(admin, 'GET', '/v1/me')).body
    expect(me.permissions).not.toContain('instance:admin')
    expect((await request(admin, 'GET', '/v1/admin/users')).status).toBe(403)
  })

  describe('(a) one rule for every admin action: the passkey check, nothing more per action', () => {
    let target: User // a plain user
    let otherAdmin: User
    beforeAll(async () => {
      target = await signUp()
      otherAdmin = await signUp()
      await setAdmin(otherAdmin, true)
    })
    afterAll(() => setAdmin(otherAdmin, false))
    const refused = { status: 403, body: { code: 'SECOND_FACTOR_REQUIRED' } }

    test('without it, granting, resetting, impersonating, inviting an admin and changes to an admin are refused and change nothing', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      await sessionOfAdmin({ createdAt: new Date() })
      const refusals = [
        await act(admin, 'instanceAdmin.grant', { userId: target.userId }),
        await act(admin, 'user.resetPasskeys', { userId: target.userId }),
        await act(admin, 'user.invite', {
          email: `${crypto.randomUUID().slice(0, 8)}@linedesk.test`,
          name: 'New Admin',
          admin: true,
        }),
        await act(admin, 'user.disable', { userId: otherAdmin.userId }),
        await act(admin, 'user.disable', { userId: target.userId }),
        await act(admin, 'instanceAdmin.revoke', { userId: otherAdmin.userId }),
        await act(admin, 'membership.add', { userId: target.userId, workspaceId: home.id, role: 'member' }),
        await act(admin, 'agentSetup.createKey', {}),
        await act(admin, 'provider.setKeys', { provider: 'deepgram', values: { api_key: 'dg-test-key-1234' } }),
        await request(admin, 'POST', '/v1/impersonation/start', { userId: target.userId }),
      ]
      for (const res of refusals)
        expect(res).toMatchObject({ ...refused, body: { ...refused.body, secondFactor: 'enrol' } })
      expect((await db.select().from(user).where(eq(user.id, target.userId)))[0]!.instanceAdmin).toBe(false)
      expect((await db.select().from(user).where(eq(user.id, target.userId)))[0]!.disabledAt).toBeNull()
      expect((await db.select().from(user).where(eq(user.id, otherAdmin.userId)))[0]!.disabledAt).toBeNull()
      // With a passkey on the account, the refusal asks to confirm with it.
      await addPasskey()
      expect(await act(admin, 'instanceAdmin.grant', { userId: target.userId })).toMatchObject({
        ...refused,
        body: { secondFactor: 'confirm' },
      })
    })

    test('with it, acting on another admin and on workspace memberships needs no second prompt', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      await addPasskey()
      const now = new Date()
      await sessionOfAdmin({ createdAt: now, passkeyVerifiedAt: now })
      const adminMember = `m_${crypto.randomUUID().slice(0, 12)}`
      await db.insert(memberTable).values([
        {
          id: adminMember,
          organizationId: other.id,
          userId: otherAdmin.userId,
          role: 'admin',
          createdAt: new Date(),
        },
      ])
      expect((await act(admin, 'membership.setRole', { memberId: adminMember, role: 'member' })).status).toBe(200)
      expect((await act(admin, 'membership.remove', { memberId: adminMember })).status).toBe(200)
      expect((await act(admin, 'user.disable', { userId: target.userId })).status).toBe(200)
      expect((await act(admin, 'user.enable', { userId: target.userId })).status).toBe(200)
    })

    test('the defence in depth: an actor with instance:admin but without the passkey check is refused all the same', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const forged: Actor = {
        actorId: admin.userId,
        role: 'member',
        workspaceId: null,
        permissions: ['instance:admin'],
        sessionId: 's',
      }
      for (const def of adminActions.filter(d => d.name !== 'user.impersonate'))
        expect((await runAction(def.name, {}, forged)).body, def.name).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' })
      expect(
        (await runAction('instanceAdmin.grant', { userId: target.userId }, { ...forged, passkeyConfirmed: true }))
          .status,
      ).toBe(200)
      await setAdmin(target, false)
    })

    test('in a passkey session they run, and (c) only then is an enrolment code handed out', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      await addPasskey()
      const now = new Date()
      await sessionOfAdmin({ createdAt: now, passkeyVerifiedAt: now })
      const granted = await act(admin, 'instanceAdmin.grant', { userId: target.userId })
      expect(granted).toMatchObject({ status: 200, body: { data: { enrolmentCode: expect.any(String) } } })
      await setAdmin(target, false)
    })

    test('(c) the handlers themselves never give an enrolment code to a session without a passkey sign-in', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const plain: Actor = {
        actorId: admin.userId,
        role: 'member',
        workspaceId: null,
        permissions: ['instance:admin'],
        sessionId: 's',
      }
      for (const [name, input] of [
        ['instanceAdmin.grant', { userId: target.userId }],
        ['user.resetPasskeys', { userId: target.userId }],
        ['user.invite', { email: 'never@linedesk.test', name: 'Never', admin: true }],
      ] as const) {
        await expect(
          adminHandlers[name]!({ tx: db, actor: plain, now: new Date().toISOString() }, input),
          name,
        ).rejects.toThrow(/passkey/)
      }
      expect(mayReceiveEnrolmentCode({ ...plain, passkeyConfirmed: true })).toBe(true)
      process.env.ADMIN_SECOND_FACTOR = 'off'
      expect(mayReceiveEnrolmentCode(plain)).toBe(true)
    })

    test('a passkey sign-in older than 12 hours no longer counts for them', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      await addPasskey()
      // Admin itself is closed by then too; even a fresh session with an old passkey mark is not confirmed.
      await sessionOfAdmin({ createdAt: new Date(), passkeyVerifiedAt: new Date(Date.now() - 13 * HOUR) })
      expect(await act(admin, 'instanceAdmin.grant', { userId: target.userId })).toMatchObject(refused)
    })
  })

  describe('(d) every instance admin is emailed', () => {
    let operatorEmail = ''
    const localOrigin = process.env.WEB_ORIGIN
    beforeAll(async () => {
      operatorEmail = await emailOf(operator)
      process.env.WEB_ORIGIN = 'https://app.linedesk.test' // on localhost no sign-in alerts go out
    })
    afterAll(() => {
      process.env.WEB_ORIGIN = localOrigin
    })
    const mails = () => vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const sentTo = (send: ReturnType<typeof mails>, subject: RegExp) =>
      send.mock.calls
        .map(([m]) => m)
        .filter(m => subject.test(m.subject))
        .map(m => m.to)

    /** A browser's sign-in request as the hook sees it: Better Auth's endpoint context with that browser's cookies. */
    const browser = () => {
      const jar = new Map<string, string>()
      const ctx = (path: string) => ({
        path,
        getCookie: (name: string) => jar.get(name) ?? null,
        setCookie: (name: string, value: string) => void jar.set(name, value),
        context: { createAuthCookie: (name: string) => ({ name: `better-auth.${name}`, attributes: {} }) },
      })
      return { jar, passkey: () => ctx('/passkey/verify-authentication'), at: (path: string) => ctx(path) }
    }
    const checked = { passkeyVerifiedAt: new Date() }
    const devicesOf = (who: User) => db.select().from(admin_devices).where(eq(admin_devices.user_id, who.userId))

    test("a server admin's passkey check from a new device emails every admin once; a known device sends nothing", async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      const laptop = browser()
      const device = {
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36',
      }
      await alertOnAdminSignIn({ userId: admin.userId, ...device, ...checked }, laptop.passkey())
      // Every enabled admin, each once, the admin themselves included.
      const adminAddresses = await instanceAdminEmails()
      expect(adminAddresses).toEqual(expect.arrayContaining([await emailOf(admin), await emailOf(operator)]))
      const alerts = send.mock.calls.map(([m]) => m).filter(m => /^Admin sign-in/.test(m.subject))
      expect(alerts.map(m => m.to).sort()).toEqual([...adminAddresses].sort())
      expect(alerts[0]!.text).toMatch(/confirmed with their passkey from a device not seen before/)
      expect(alerts[0]!.text).toContain('Browser: Chrome on macOS')
      expect(alerts[0]!.text).toContain('Address: 203.0.113.7')
      expect(alerts[0]!.text).toMatch(/Time: \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s(AM|PM) UTC/)
      expect(alerts[0]!.text).toMatch(/disable the account and reset its passkeys/)
      // Only the token's hash is stored; the browser keeps the token.
      const token = [...laptop.jar.values()][0]!
      expect((await devicesOf(admin)).map(d => d.device_hash)).toContain(deviceHash(token))
      expect((await devicesOf(admin)).map(d => d.device_hash)).not.toContain(token)
      send.mockClear()
      // The same browser again, from another address: known, nothing sent; the token is replaced (rotated).
      await alertOnAdminSignIn(
        { userId: admin.userId, ipAddress: '198.51.100.1', userAgent: 'x', ...checked },
        laptop.passkey(),
      )
      expect(sentTo(send, /^Admin sign-in/)).toEqual([])
      const rotated = [...laptop.jar.values()][0]!
      expect(rotated).not.toBe(token)
      const hashes = (await devicesOf(admin)).map(d => d.device_hash)
      expect(hashes).toContain(deviceHash(rotated))
      expect(hashes).not.toContain(deviceHash(token))
    })

    test('M1: a token the server did not issue is replaced and never stored; the browser counts as new', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      const planted = browser()
      const token = randomBytes(32).toString('base64url') // well-formed, e.g. tossed in from a subdomain
      planted.jar.set('admin_device', token)
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, planted.passkey())
      expect(sentTo(send, /^Admin sign-in/)).toContain(await emailOf(operator))
      expect(planted.jar.get('admin_device')).not.toBe(token)
      const all = await db.select().from(admin_devices)
      expect(all.map(d => d.device_hash)).not.toContain(deviceHash(token))
      // On https the name is `__Host-`: browsers then refuse it with a Domain, so no subdomain can toss one in.
      const https = deviceCookie(true)
      expect(https.name).toBe('__Host-admin_device')
      expect(https.attributes).toMatchObject({ secure: true, path: '/', httpOnly: true })
      expect(https.attributes).not.toHaveProperty('domain')
      expect(deviceCookie(false).name).toBe('admin_device')
    })

    test('L3: a copied cookie shows up as a new device once the real browser checked again', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      const laptop = browser()
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, laptop.passkey())
      const thief = browser()
      for (const [name, value] of laptop.jar) thief.jar.set(name, value)
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, laptop.passkey())
      send.mockClear()
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, thief.passkey())
      expect(sentTo(send, /^Admin sign-in/)).toContain(await emailOf(operator))
    })

    test('L1: when the device cannot be read or stored, the alert goes out', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      const laptop = browser()
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, laptop.passkey())
      send.mockClear()
      const failing = vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('database is down'))
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await alertOnAdminSignIn({ userId: admin.userId, ...checked }, laptop.passkey()) // a known browser
      } finally {
        failing.mockRestore()
        logged.mockRestore()
      }
      expect(sentTo(send, /^Admin sign-in/)).toContain(await emailOf(operator))
    })

    test('L2: passkeys reset, admin revoked and account disabled forget the browsers; old rows are pruned daily', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      mails()
      const now = new Date()
      await addPasskey()
      await sessionOfAdmin({ createdAt: now, passkeyVerifiedAt: now })
      const remember = async (who: User) => {
        await db.insert(admin_devices).values({ user_id: who.userId, device_hash: deviceHash(crypto.randomUUID()) })
        expect(await devicesOf(who)).toHaveLength(1)
      }
      const reset = await signUp()
      await setAdmin(reset, true)
      await remember(reset)
      expect((await act(admin, 'user.resetPasskeys', { userId: reset.userId })).status).toBe(200)
      expect(await devicesOf(reset)).toEqual([])
      await remember(reset)
      expect((await act(admin, 'instanceAdmin.revoke', { userId: reset.userId })).status).toBe(200)
      expect(await devicesOf(reset)).toEqual([])
      const disabled = await signUp()
      await setAdmin(disabled, true)
      await remember(disabled)
      expect((await act(admin, 'user.disable', { userId: disabled.userId })).status).toBe(200)
      expect(await devicesOf(disabled)).toEqual([])
      await setAdmin(disabled, false)
      // Daily prune: rows not seen for longer than the cookie lives (400 days).
      const day = 24 * 60 * 60 * 1000
      const old = deviceHash(crypto.randomUUID())
      const recent = deviceHash(crypto.randomUUID())
      await db.insert(admin_devices).values([
        { user_id: operator.userId, device_hash: old, last_seen_at: new Date(Date.now() - 401 * day).toISOString() },
        { user_id: operator.userId, device_hash: recent, last_seen_at: new Date(Date.now() - 10 * day).toISOString() },
      ])
      expect(await pruneOldAdminDevices(db)).toBeGreaterThanOrEqual(1)
      const left = (await devicesOf(operator)).map(d => d.device_hash)
      expect(left).not.toContain(old)
      expect(left).toContain(recent)
    })

    test('a browser whose device cookie was cleared counts as new again', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      const laptop = browser()
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, laptop.passkey())
      laptop.jar.clear()
      send.mockClear()
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, laptop.passkey())
      expect(sentTo(send, /^Admin sign-in/)).toContain(await emailOf(operator))
      // A cookie that is not one of ours is not trusted either.
      laptop.jar.set('admin_device', 'forged')
      send.mockClear()
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, laptop.passkey())
      expect(sentTo(send, /^Admin sign-in/)).toContain(await emailOf(operator))
    })

    test('one browser, two admins: each switch between them is reported once (rotation, accepted)', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      const shared = browser()
      const alertedFor = () => send.mock.calls.map(([m]) => m.subject).filter(subject => /^Admin sign-in/.test(subject))
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, shared.passkey())
      await alertOnAdminSignIn({ userId: operator.userId, ...checked }, shared.passkey())
      expect(new Set(alertedFor())).toEqual(
        new Set([expect.stringContaining(await emailOf(admin)), expect.stringContaining(await emailOf(operator))]),
      )
      send.mockClear()
      // The operator's check replaced the token, so the admin's next check there is new once, then known.
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, shared.passkey())
      expect(new Set(alertedFor())).toEqual(new Set([expect.stringContaining(await emailOf(admin))]))
      send.mockClear()
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, shared.passkey())
      expect(sentTo(send, /^Admin sign-in/)).toEqual([])
    })

    test("a sign-in that is not the passkey check, a member's check and an impersonation send nothing and remember no device", async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      const before = (await devicesOf(admin)).length
      for (const path of ['/sign-in/email', '/sign-in/email-otp', '/callback/google']) {
        const fresh = browser()
        await alertOnAdminSignIn({ userId: admin.userId, ipAddress: '203.0.113.20', userAgent: 'x' }, fresh.at(path))
        expect(fresh.jar.size, path).toBe(0)
      }
      await alertOnAdminSignIn({ userId: member.userId, ...checked }, browser().passkey())
      const impersonating = browser()
      await alertOnAdminSignIn(
        { userId: admin.userId, impersonatedBy: operator.userId, ...checked },
        impersonating.passkey(),
      )
      expect(impersonating.jar.size).toBe(0)
      expect(sentTo(send, /^Admin sign-in/)).toEqual([])
      expect((await devicesOf(admin)).length).toBe(before)
      expect(await devicesOf(member)).toEqual([])
    })

    test('a password sign-in of an admin sends no alert but is still in the audit log', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      const before = await db.select().from(auth_events).where(eq(auth_events.user_id, admin.userId))
      expect((await signIn(admin)).status).toBe(200)
      const after = await db.select().from(auth_events).where(eq(auth_events.user_id, admin.userId))
      expect(after.length).toBe(before.length + 1)
      expect(after.find(e => !before.some(b => b.id === e.id))).toMatchObject({ event: 'sign_in', method: 'password' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(sentTo(send, /^Admin sign-in/)).toEqual([])
    })

    test('with ADMIN_SECOND_FACTOR=off every sign-in opens Server admin: a new device is reported, through the real endpoint', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'off'
      try {
        const send = mails()
        const ip = randomIp()
        const post = (cookie?: string) =>
          appRequest('/api/auth/sign-in/email', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'http://localhost:5173',
              [FROM]: ip,
              ...(cookie ? { cookie } : {}),
            },
            body: JSON.stringify({ email: operatorEmail, password: 'test-password-1234' }),
          })
        const first = await post()
        expect(first.status).toBe(200)
        await vi.waitFor(() => expect(sentTo(send, /^Admin sign-in/)).toContain(operatorEmail))
        const device = first.headers.getSetCookie().find(c => /admin_device=/.test(c))
        expect(device).toMatch(/HttpOnly/i)
        expect(device).toMatch(/Max-Age=34560000/)
        send.mockClear()
        expect(device).toMatch(/^admin_device=/) // http here; on https `__Host-admin_device` (Secure, Path=/)
        const second = await post(device!.split(';')[0])
        expect(second.status).toBe(200)
        const rotated = second.headers.getSetCookie().find(c => /admin_device=/.test(c))
        expect(rotated?.split(';')[0]).not.toBe(device!.split(';')[0])
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(sentTo(send, /^Admin sign-in/)).toEqual([])
      } finally {
        process.env.ADMIN_SECOND_FACTOR = 'on'
      }
    })

    test("the first admin's sign-in right after setup sends no alert; the next one from a new device does", async () => {
      const send = mails()
      markSetupSignIn(admin.userId)
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, browser().passkey())
      expect(sentTo(send, /^Admin sign-in/)).toEqual([])
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, browser().passkey())
      expect(sentTo(send, /^Admin sign-in/)).toContain(await emailOf(operator))
    })

    test('an instance on localhost sends no sign-in alerts', async () => {
      const send = mails()
      process.env.WEB_ORIGIN = 'http://localhost:8490'
      try {
        await alertOnAdminSignIn({ userId: admin.userId, ...checked }, browser().passkey())
      } finally {
        process.env.WEB_ORIGIN = 'https://app.linedesk.test'
      }
      expect(sentTo(send, /^Admin sign-in/)).toEqual([])
      expect(isLocalInstance({ PUBLIC_URL: 'https://app.linedesk.ai', WEB_ORIGIN: 'http://localhost:5173' })).toBe(
        false,
      )
      expect(isLocalInstance({ WEB_ORIGIN: 'http://livemode.localhost:8490' })).toBe(true)
    })

    test('F1: a passkey check from an endpoint the alert does not know is still reported, as another method', async () => {
      const send = mails()
      await alertOnAdminSignIn(
        { userId: admin.userId, ipAddress: '198.51.100.4', userAgent: 'x', ...checked },
        browser().at('/some/new-endpoint'),
      )
      // No request to read a device cookie from: never a known device.
      await alertOnAdminSignIn({ userId: admin.userId, ...checked }, undefined)
      const alerts = send.mock.calls
        .map(([m]) => m)
        .filter(m => /^Admin sign-in/.test(m.subject) && m.to === operatorEmail)
      expect(alerts).toHaveLength(2)
      expect(alerts[0]!.text).toMatch(/a sign-in method this server does not recognise/)
    })

    test('F4: the alert carries no links and no long browser strings', () => {
      const ua = `Mozilla/5.0 (evil) visit https://phish.example/reset?x=1 or www.phish.example now ${'A'.repeat(300)}`
      const signIn = adminSignInEmail('ann@linedesk.test', 'password', {
        userId: 'u',
        ipAddress: '203.0.113.9',
        userAgent: ua,
      })
      const { text, html } = adminAlertEmail(signIn('en'), 'https://desk.example.com')
      // The one link is the alert's own button to the install's audit log.
      expect(text.replace('https://desk.example.com/#admin/audit', '')).not.toMatch(/https?:|www\./)
      expect(html).not.toMatch(/https?:\/\/phish|www\.phish/)
      expect(text).toContain('[link]')
      const browserLine = text.split('\n').find((line: string) => line.startsWith('Browser: '))!
      expect(browserLine.length).toBeLessThanOrEqual('Browser: '.length + 120)
      expect(plainSnippet(null)).toBe('')
      expect(adminAlertEmail(adminSignInEmail('ann@linedesk.test', 'password', { userId: 'u' })('en')).text).toContain(
        'Browser: Unknown\nAddress: Unknown',
      )
      const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1'
      expect(browserOf(iphone)).toEqual({ browser: 'Safari', os: 'iOS' })
      expect(
        adminAlertEmail(adminSignInEmail('a@b.test', 'passkey', { userId: 'u', userAgent: iphone })('en')).text,
      ).toContain('Browser: Safari on iOS')
      expect(browserOf('Mozilla/5.0 (Windows NT 10.0) Chrome/131.0 Safari/537.36 Edg/131.0')).toEqual({
        browser: 'Edge',
        os: 'Windows',
      })
      expect(browserOf('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0')).toEqual({
        browser: 'Firefox',
        os: 'Linux',
      })
      expect(browserOf('curl/8.0')).toBeNull()
    })

    test('when admin is granted and when passkeys are reset', async () => {
      process.env.ADMIN_SECOND_FACTOR = 'on'
      const send = mails()
      const someone = await signUp()
      const now = new Date()
      await addPasskey()
      await sessionOfAdmin({ createdAt: now, passkeyVerifiedAt: now })
      expect((await act(admin, 'instanceAdmin.grant', { userId: someone.userId })).status).toBe(200)
      expect(sentTo(send, /^New server admin/)).toEqual(
        expect.arrayContaining([await emailOf(admin), await emailOf(operator)]),
      )
      expect((await act(admin, 'user.resetPasskeys', { userId: someone.userId })).status).toBe(200)
      const reset = send.mock.calls.map(([m]) => m).filter(m => /^Passkeys reset/.test(m.subject))
      expect(reset.map(m => m.to)).toEqual(expect.arrayContaining([await emailOf(operator)]))
      expect(reset[0]!.text).toContain(await emailOf(admin)) // who did it
      await setAdmin(someone, false)
    })
  })

  test('ADMIN_SECOND_FACTOR=off turns the rule off, the email check included, with a loud warning', async () => {
    expect(adminSecondFactorRequired({})).toBe(true)
    expect(adminSecondFactorRequired({ ADMIN_SECOND_FACTOR: 'OFF' })).toBe(false)
    expect(secondFactorOffWarning({})).toBeNull()
    expect(secondFactorOffWarning({ ADMIN_SECOND_FACTOR: 'off' })).toMatch(/WARNING: ADMIN_SECOND_FACTOR=off/)
    // Passkeys off as a sign-in method while the rule is on: nobody can open Server admin, said at every start.
    expect(passkeysOffWarning({})).toBeNull()
    expect(passkeysOffWarning({ AUTH_PASSKEY_ENABLED: 'false', ADMIN_SECOND_FACTOR: 'off' })).toBeNull()
    expect(passkeysOffWarning({ AUTH_PASSKEY_ENABLED: 'false' })).toMatch(
      /WARNING: AUTH_PASSKEY_ENABLED=false[\s\S]*nobody can open Server admin[\s\S]*remove AUTH_PASSKEY_ENABLED=false/,
    )
    process.env.ADMIN_SECOND_FACTOR = 'off'
    await confirmEmail(false)
    expect((await request(admin, 'GET', '/v1/admin/users')).status).toBe(200)
    const someone = await signUp()
    expect((await act(admin, 'instanceAdmin.grant', { userId: someone.userId })).status).toBe(200)
    await setAdmin(someone, false)
  })
})

describe('audit log', () => {
  type Entry = {
    id: string
    at: string
    kind: string
    what: string
    method: string | null
    actor: { id: string | null; email: string | null }
    workspace: { id: string; name: string | null } | null
    input: unknown
    refused: boolean
  }
  const audit = async (query = '') =>
    (await request(operator, 'GET', `/v1/admin/audit${query}`)).body as { entries: Entry[]; next: string | null }

  test('only instance admins read it', async () => {
    expect((await request(other.owner, 'GET', '/v1/admin/audit')).status).toBe(403)
    expect((await request(operator, 'GET', '/v1/admin/audit?kind=everything')).status).toBe(400)
  })

  test('a sign-in is recorded with its method and found by the person', async () => {
    const person = await signUp()
    const email = await emailOf(person)
    expect((await signIn(person)).status).toBe(200)
    const { entries } = await audit(`?kind=sign_in&who=${encodeURIComponent(email.toUpperCase())}`)
    expect(entries.map(e => [e.what, e.method])).toEqual([
      ['sign_in', 'password'],
      // The fixture's own first sign-in (accounts are written directly: there is no open sign-up).
      ['sign_in', 'password'],
    ])
    expect(entries[0]!.actor).toMatchObject({ id: person.userId, email })
  })

  test('admin actions, refused ones too, and provider keys without their values', async () => {
    const victim = await signUp()
    await act(operator, 'user.disable', { userId: victim.userId })
    await act(operator, 'user.enable', { userId: victim.userId })
    // Speech to text, not telephony: other test files place calls at the same time.
    await act(operator, 'provider.setKeys', { provider: 'deepgram', values: { api_key: SECRET } })
    await act(operator, 'user.disable', { userId: operator.userId }) // refused: not yourself
    const { entries } = await audit('?limit=50')
    const recent = entries.filter(e => e.actor.id === operator.userId)
    expect(recent.find(e => e.what === 'user.disable' && !e.refused)).toMatchObject({
      kind: 'admin',
      input: { userId: victim.userId },
    })
    const keys = recent.find(e => e.what === 'provider.setKeys')!
    expect(keys.kind).toBe('keys')
    expect(JSON.stringify(keys)).not.toContain(SECRET)
    await clearAll()
    expect((await audit('?kind=keys')).entries.every(e => e.kind === 'keys')).toBe(true)
    expect(
      recent.find(e => e.what === 'user.disable' && (e.input as { userId: string }).userId === operator.userId),
    ).toMatchObject({ refused: true })
  })

  test('an admin adding themselves to a workspace is listed under that workspace, with whom it was about', async () => {
    const operatorEmail = await emailOf(operator)
    const added = await act(operator, 'membership.add', {
      userId: operator.userId,
      workspaceId: other.id,
      role: 'admin',
    })
    expect(added.status).toBe(200)
    const removed = await act(operator, 'membership.remove', { memberId: added.body.data.memberId })
    expect(removed.status).toBe(200)
    const { entries } = await audit(`?kind=admin&workspace=${other.id}`)
    // Newest first; other tests in this file change memberships of `other` too.
    const mine = entries.filter(e => e.actor.id === operator.userId && e.what.startsWith('membership.')).slice(0, 2)
    expect(mine.map(e => e.what)).toEqual(['membership.remove', 'membership.add'])
    for (const e of mine)
      expect(e).toMatchObject({ kind: 'admin', workspace: { id: other.id }, subject: { email: operatorEmail } })
    expect(mine[1]!.input).toMatchObject({ role: 'admin' })
  })

  test('removing a member, leaving, API keys and webhooks are recorded, the member named', async () => {
    const ws = await createWorkspace('Audit Trail Plumbing')
    const leaver = await addMember(ws.id, 'member')
    const removed = await addMember(ws.id, 'admin')
    const removedEmail = await emailOf(removed)
    const [row] = await db.select().from(memberTable).where(eq(memberTable.userId, removed.userId))
    expect((await act(ws.owner, 'team.setRole', { memberId: row!.id, role: 'member' })).status).toBe(200)
    expect((await act(ws.owner, 'team.removeMember', { memberId: row!.id })).status).toBe(200)
    expect((await act(leaver, 'team.leave', { deleteAccount: false })).status).toBe(200)
    const key = await act(ws.owner, 'apiKey.create', { name: 'Zapier', role: 'member' })
    expect(key.status).toBe(200)
    expect((await act(ws.owner, 'webhook.delete', { endpointId: ws.webhookEndpoint.id })).status).toBe(200)
    const { entries } = await audit(`?workspace=${ws.id}&limit=50`)
    const byWhat = (what: string) => entries.find(e => e.what === what)
    expect(byWhat('team.setRole')).toMatchObject({
      kind: 'team',
      subject: { email: removedEmail },
      input: { role: 'member' },
    })
    expect(byWhat('team.removeMember')).toMatchObject({ kind: 'team', subject: { email: removedEmail } })
    expect(byWhat('team.leave')).toMatchObject({ kind: 'team', actor: { id: leaver.userId } })
    expect(byWhat('apiKey.create')).toMatchObject({ kind: 'integrations', input: { name: 'Zapier' } })
    expect(byWhat('webhook.delete')).toMatchObject({ kind: 'integrations' })
    // The key itself is never in the log.
    expect(JSON.stringify(byWhat('apiKey.create'))).not.toContain(key.body.data.key)
    const integrations = (await audit(`?kind=integrations&workspace=${ws.id}`)).entries
    expect(integrations.map(e => e.what).sort()).toEqual(['apiKey.create', 'webhook.delete'])
  })

  test('team changes carry their workspace and can be filtered by it', async () => {
    const joined = await addMember(other.id, 'member')
    const [row] = await db.select().from(memberTable).where(eq(memberTable.userId, joined.userId))
    expect((await act(other.owner, 'team.setRole', { memberId: row!.id, role: 'admin' })).status).toBe(200)
    const { entries } = await audit(`?kind=team&workspace=${other.id}`)
    expect(entries[0]).toMatchObject({
      what: 'team.setRole',
      kind: 'team',
      workspace: { id: other.id, name: 'Brightwater Plumbing & Heating' },
    })
    expect(
      (await audit(`?kind=team&workspace=${home.id}`)).entries.some(
        e => e.what === 'team.setRole' && e.workspace?.id === other.id,
      ),
    ).toBe(false)
  })

  test('pages go back in time without gaps or repeats', async () => {
    const first = await audit('?limit=3')
    expect(first.entries).toHaveLength(3)
    expect(first.next).toBeTruthy()
    const second = await audit(`?limit=3&before=${encodeURIComponent(first.next!)}`)
    const ids = [...first.entries, ...second.entries].map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const both = (await audit('?limit=6')).entries.map(e => e.id)
    expect(ids).toEqual(both.slice(0, ids.length))
    expect((await request(operator, 'GET', '/v1/admin/audit?before=nonsense')).status).toBe(400)
  })

  test('a deleted user’s entries stay, without their email, address or browser', async () => {
    const leaving = await signUp()
    expect((await signIn(leaving)).status).toBe(200)
    const before = await db.select().from(auth_events).where(eq(auth_events.user_id, leaving.userId))
    expect(before.map(e => e.event)).toEqual(['sign_in', 'sign_in'])
    expect(before.some(e => e.email !== null)).toBe(true)
    await db.delete(user).where(eq(user.id, leaving.userId))
    const after = await db.select().from(auth_events).where(eq(auth_events.user_id, leaving.userId))
    expect(after.map(e => e.id).sort()).toEqual(before.map(e => e.id).sort())
    for (const e of after) expect(e).toMatchObject({ email: 'deleted', ip_address: null, user_agent: null })
    // Everyone else's entries are untouched.
    const kept = await db.select().from(auth_events).where(eq(auth_events.user_id, operator.userId))
    expect(kept.every(e => e.email !== 'deleted')).toBe(true)
  })

  test('impossible dates and cursors are refused with 400, never reach the database', async () => {
    for (const query of [
      'from=2026-02-30',
      'to=2026-13-01',
      'from=2026-1-5',
      'to=yesterday',
      'before=2026-02-30T10:00:00.000Z|ae_1',
      'before=2026-11-11T25:61:00.000Z|ae_1',
      `before=${encodeURIComponent("2026-11-11T10:00:00.000Z|x' or 1=1")}`,
    ]) {
      expect((await request(operator, 'GET', `/v1/admin/audit?${query}`)).status, query).toBe(400)
    }
    expect((await request(operator, 'GET', '/v1/admin/audit?from=2024-02-29&to=2026-11-11')).status).toBe(200)
  })

  test('the sign-in method comes from the endpoint that made the session; impersonation is not a sign-in', () => {
    expect(signInMethod({ path: '/sign-in/email' })).toBe('password')
    expect(signInMethod({ path: '/sign-in/email-otp' })).toBe('email_code')
    expect(signInMethod({ path: '/passkey/verify-authentication' })).toBe('passkey')
    expect(signInMethod({ path: '/callback/:id', params: { id: 'github' } })).toBe('github')
    expect(signInMethod({ path: '/oauth2/callback/:providerId', params: { providerId: 'oidc' } })).toBe('oidc')
    expect(signInMethod(undefined)).toBeNull()
  })
})

describe('monthly spending cap', () => {
  const capOf = async (workspaceId: string) =>
    (await db.select().from(organization).where(eq(organization.id, workspaceId)))[0]?.spendingCapCents
  /** A finished phone call of `minutes` this month (or `daysAgo` back), straight into the table. */
  const pastCall = (workspaceId: string, minutes: number, daysAgo = 0, source: 'phone' | 'test' = 'phone') =>
    db.insert(calls).values({
      id: `call_cap_${randomBytes(6).toString('hex')}`,
      workspace_id: workspaceId,
      from_number: '+15035550142',
      to_number: '+15035550100',
      source,
      status: 'completed',
      duration_sec: Math.round(minutes * 60),
      started_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    })
  /** Starts and finishes a short phone call through the agent: call.finish queues the alerts. */
  const finishedCall = async (ws: Workspace) => {
    const { body } = await act(agent(), 'call.start', { from: '+15035550177', to: ws.number })
    expect(body.data.overCap).toBe(false)
    await act(agent(ws.id), 'call.finish', { callId: body.data.callId })
  }
  let alerts: { name: string; data: { workspaceId: string; month: string; level: number } }[] = []
  beforeEach(() => {
    alerts = []
    setJobQueue({ send: async (name: string, data: never) => void alerts.push({ name, data }) } as never)
    // A speech provider with a price per minute, so calls cost something in the estimate.
    vi.stubEnv('DEEPGRAM_API_KEY', 'test-deepgram-key')
  })
  afterEach(() => {
    setJobQueue(null)
    vi.unstubAllEnvs()
  })

  test('test calls never count', async () => {
    const ws = await createWorkspace('Tested Plumbing')
    await pastCall(ws.id, 10_000, 0, 'test')
    const set = await act(operator, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: 1 })
    expect(set.body.data).toMatchObject({ spent_usd: 0, reached: false })
  })

  test('off by default; only instance admins set it; 80 % and 100 % alerts once a month; at the cap calls get a line and a callback', async () => {
    const ws = await createWorkspace('Capped Plumbing')
    // Over 10 000 minutes, so the estimate's rounding to cents does not matter.
    const perMinute = (await costEstimate(db))({ all: 600_000, phone: 600_000 }) / 10_000
    expect(perMinute).toBeGreaterThan(0)
    // $1 cap: about 1 / perMinute minutes.
    const capMinutes = 1 / perMinute
    expect(await capOf(ws.id)).toBeNull()
    await pastCall(ws.id, capMinutes * 2)
    await finishedCall(ws) // no cap: answered, nothing queued
    expect(alerts.filter(a => a.name === SPENDING_CAP_ALERT)).toEqual([])
    await db.delete(calls).where(eq(calls.workspace_id, ws.id))

    for (const who of [ws.owner, agent(ws.id)]) {
      expect((await act(who, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: 1 })).status).toBe(403)
    }
    expect((await act(operator, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: -1 })).status).toBe(422)
    const set = await act(operator, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: 1 })
    expect(set.body.data).toMatchObject({ spending_cap_usd: 1, spent_usd: 0, reached: false })
    expect(await capOf(ws.id)).toBe(100)

    // Last month's calls do not count; 85 % this month sends the 80 % email, once.
    await pastCall(ws.id, capMinutes * 3, 40)
    await pastCall(ws.id, capMinutes * 0.85)
    await finishedCall(ws)
    await finishedCall(ws)
    const month = new Date().toISOString().slice(0, 7)
    expect(alerts.filter(a => a.name === SPENDING_CAP_ALERT).map(a => a.data)).toEqual([
      { workspaceId: ws.id, month, level: 80 },
    ])

    // Past the cap (a call that finished, so call.finish sends the 100 % email): the next phone call is not answered
    // by the assistant, and the 100 % email is not sent twice.
    const last = (await act(agent(), 'call.start', { from: '+15035550177', to: ws.number })).body.data.callId
    await db
      .update(calls)
      .set({ started_at: new Date(Date.now() - capMinutes * 0.2 * 60_000).toISOString() })
      .where(eq(calls.id, last))
    await act(agent(ws.id), 'call.finish', { callId: last })
    expect(alerts.filter(a => a.name === SPENDING_CAP_ALERT).map(a => a.data.level)).toEqual([80, 100])
    const capped = await act(agent(), 'call.start', { from: '+15035550178', to: ws.number })
    expect(alerts.filter(a => a.name === SPENDING_CAP_ALERT).map(a => a.data.level)).toEqual([80, 100])
    expect(capped.body.data).toMatchObject({ overCap: true, blocked: true, busy: false, booking: null })
    expect(await getCall(capped.body.data.callId)).toMatchObject({
      status: 'completed',
      outcome: 'hangup',
      title: 'Missed call',
      unread: true,
      action_items: [{ text: 'Call back' }],
      summary: expect.stringContaining('monthly spending cap'),
    })
    expect(alerts.filter(a => a.name === 'call.push').map(a => a.data)).toContainEqual({
      callId: capped.body.data.callId,
      kind: 'finished',
    })
    // Test calls are off too.
    vi.stubEnv('LIVEKIT_URL', 'ws://livekit.test:7880')
    vi.stubEnv('LIVEKIT_API_KEY', 'k')
    vi.stubEnv('LIVEKIT_API_SECRET', 'test-secret-test-secret-test-secret')
    expect(await act(ws.owner, 'assistant.startTestCall', {})).toMatchObject({
      status: 409,
      body: { error: TEST_CALLS_OVER_CAP },
    })

    // The admin list shows the cap and the estimate.
    const listed = (await request(operator, 'GET', '/v1/admin/workspaces')).body.workspaces.find(
      (w: { id: string }) => w.id === ws.id,
    )
    expect(listed).toMatchObject({ spending_cap_usd: 1 })
    expect(listed.cost_this_month).toBeGreaterThanOrEqual(1)

    // A higher cap answers calls again, and its alerts start over; no cap at all answers too.
    alerts = []
    expect(
      (await act(operator, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: 1.2 })).body.data,
    ).toMatchObject({ reached: false })
    expect(alerts.filter(a => a.name === SPENDING_CAP_ALERT).map(a => a.data.level)).toEqual([80])
    expect((await act(agent(), 'call.start', { from: '+15035550179', to: ws.number })).body.data.overCap).toBe(false)
    await act(operator, 'workspace.setSpendingCap', { workspaceId: ws.id, capUsd: null })
    expect(await capOf(ws.id)).toBeNull()
  })

  test('the alert email goes to the owners and the instance admins, once per address, and says what happens', async () => {
    const ws = await createWorkspace('Alerted Plumbing')
    const wsAdmin = await addMember(ws.id, 'admin')
    await addMember(ws.id, 'member')
    await db.update(organization).set({ spendingCapCents: 0 }).where(eq(organization.id, ws.id))
    const sent: { to: string; subject: string; text: string }[] = []
    const sender = {
      kind: 'smtp' as const,
      send: async (email: (typeof sent)[number]) => void sent.push(email),
      check: async () => ({ ok: true, message: '' }),
    }
    const month = new Date().toISOString().slice(0, 7)
    expect(await sendSpendingAlert(db, sender, { workspaceId: ws.id, month, level: 100 })).toMatchObject({ failed: 0 })
    const to = sent.map(e => e.to)
    expect(to).toEqual(
      expect.arrayContaining([await emailOf(ws.owner), await emailOf(operator)].map(a => a.toLowerCase())),
    )
    expect(to).not.toContain((await emailOf(wsAdmin)).toLowerCase())
    expect(new Set(to).size).toBe(to.length)
    expect(sent[0]).toMatchObject({
      subject: 'Alerted Plumbing reached its monthly spending cap',
      text: expect.stringContaining('call them back'),
    })
    // A name that reads like a link is not put into the email (emailSafeName).
    await db.update(organization).set({ name: 'Pay at evil.example.com' }).where(eq(organization.id, ws.id))
    sent.length = 0
    await sendSpendingAlert(db, sender, { workspaceId: ws.id, month, level: 100 })
    expect(sent[0]!.subject).toBe('Your workspace reached its monthly spending cap')
    expect(JSON.stringify(sent)).not.toContain('evil.example.com')
    await db.update(organization).set({ name: 'Alerted Plumbing' }).where(eq(organization.id, ws.id))
    // Another month, or no cap any more: nothing is sent.
    sent.length = 0
    expect(await sendSpendingAlert(db, sender, { workspaceId: ws.id, month: '2001-01', level: 80 })).toEqual({
      sent: 0,
      failed: 0,
    })
    await db.update(organization).set({ spendingCapCents: null }).where(eq(organization.id, ws.id))
    expect(await sendSpendingAlert(db, sender, { workspaceId: ws.id, month, level: 100 })).toEqual({
      sent: 0,
      failed: 0,
    })
    expect(sent).toEqual([])
  })
})

describe('branding', () => {
  // 1×1 transparent PNG.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const logo = `data:image/png;base64,${PNG}`
  const input = { name: 'Front Desk Pro', color: '#0B5FFF', logo, starPrompt: false }
  afterEach(() => resetBranding(db))

  test('anyone reads the defaults before sign-in', async () => {
    expect((await request(anonymous, 'GET', '/v1/branding')).body).toEqual({
      name: 'Linedesk',
      color: null,
      logoUrl: null,
      starPrompt: true,
      starCount: null,
      poweredBy: true,
    })
    expect((await request(anonymous, 'GET', '/v1/branding/manifest.webmanifest')).body).toMatchObject({
      name: 'Linedesk',
    })
    expect((await request(anonymous, 'GET', '/v1/branding/logo.png')).status).toBe(404)
  })

  test('an instance admin sets name, color, logo and the star prompt; pages, the manifest and emails use them', async () => {
    const res = await act(operator, 'branding.set', input)
    expect(res.body).toMatchObject({ ok: true, data: { name: 'Front Desk Pro', color: '#0b5fff', starPrompt: false } })
    const logoUrl: string = res.body.data.logoUrl
    expect(logoUrl).toMatch(/^\/v1\/branding\/logo\.png\?v=/)
    expect((await request(anonymous, 'GET', '/v1/branding')).body).toEqual(res.body.data)
    const served = await appRequest(logoUrl)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await served.arrayBuffer()).toString('base64')).toBe(PNG)
    const manifest = (await request(anonymous, 'GET', '/v1/branding/manifest.webmanifest')).body
    expect(manifest).toMatchObject({
      name: 'Front Desk Pro',
      icons: [{ src: logoUrl }, { src: logoUrl, purpose: 'maskable' }],
    })
    const email = signInCodeEmail('123456', 'https://desk.example')
    expect(email.subject).toBe('123456 is your Front Desk Pro sign-in code')
    expect(email.html).toContain(`https://desk.example${logoUrl}`)

    // Left out keeps the logo; null removes it.
    expect((await act(operator, 'branding.set', { ...input, logo: undefined, name: 'Desk' })).body.data).toMatchObject({
      name: 'Desk',
      logoUrl,
    })
    expect((await act(operator, 'branding.set', { ...input, logo: null })).body.data.logoUrl).toBeNull()
    expect((await request(anonymous, 'GET', '/v1/branding/logo.png')).status).toBe(404)
  })

  test('Powered by Linedesk: on by default for an own name, hidden only by the switch; left out keeps it', async () => {
    const powered = (origin = 'https://desk.example') => signInCodeEmail('123456', origin).html.includes('Powered by')
    expect(powered()).toBe(false) // the default branding already says Linedesk
    expect((await act(operator, 'branding.set', { ...input, logo: undefined })).body.data.poweredBy).toBe(true)
    expect(powered()).toBe(true)
    const off = await act(operator, 'branding.set', { ...input, logo: undefined, poweredBy: false })
    expect(off.body.data.poweredBy).toBe(false)
    expect((await request(anonymous, 'GET', '/v1/branding')).body.poweredBy).toBe(false)
    expect(powered()).toBe(false)
    const { entries } = (await request(operator, 'GET', '/v1/admin/audit?kind=admin&limit=5')).body
    expect(entries[0]).toMatchObject({ what: 'branding.set', input: { name: 'Front Desk Pro', poweredBy: false } })
    // An older page that does not send the switch leaves it as it is.
    expect((await act(operator, 'branding.set', { ...input, logo: undefined, name: 'Desk' })).body.data.poweredBy).toBe(
      false,
    )
    await act(operator, 'branding.set', { ...input, logo: undefined, poweredBy: true })
    expect(powered()).toBe(true)
  })

  test('the command log notes that a logo was sent, not the image', async () => {
    // Other tests in this file log branding.set too (some without a logo): read the row of this call.
    const key = crypto.randomUUID()
    expect((await act(operator, 'branding.set', input, key)).status).toBe(200)
    const [row] = await db.select().from(commands).where(eq(commands.id, key))
    expect(row).toMatchObject({ action: 'branding.set' })
    expect(row?.input).toMatchObject({ name: 'Front Desk Pro', logo: REDACTED })
  })

  test('only a real PNG of at most 512 pixels is stored', async () => {
    const wide = Buffer.from(PNG, 'base64')
    wide.writeUInt32BE(1024, 16)
    expect(() => decodeLogo(`data:image/png;base64,${wide.toString('base64')}`)).toThrow('at most 512×512')
    const svg = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`
    expect((await act(operator, 'branding.set', { ...input, logo: svg })).body).toMatchObject({
      ok: false,
      error: 'The logo must be a PNG image.',
    })
    expect((await act(operator, 'branding.set', { ...input, logo: 'data:image/svg+xml;base64,AAAA' })).status).toBe(422)
    expect((await act(operator, 'branding.set', { ...input, name: ' ' })).status).toBe(422)
    expect((await request(anonymous, 'GET', '/v1/branding')).body.name).toBe('Linedesk')
  })

  test('a name with control characters, separators or bidi overrides is refused (review of #1040, I-2)', async () => {
    for (const name of ['Front\nDesk', 'Front\tDesk', 'Front\u0000Desk', 'Front Desk', 'Desk‮knal', 'A⁦B'])
      expect(
        (await act(operator, 'branding.set', { ...input, logo: undefined, name })).status,
        JSON.stringify(name),
      ).toBe(422)
    expect((await request(anonymous, 'GET', '/v1/branding')).body.name).toBe('Linedesk')
    // Letters of any language, digits, spaces and punctuation are fine.
    expect((await act(operator, 'branding.set', { ...input, logo: undefined, name: 'Büro & Co. — 受付' })).status).toBe(
      200,
    )
    await act(operator, 'branding.set', { ...input, logo: null, name: 'Linedesk' })
  })
})

describe('setup code', () => {
  test('only while nobody has an account', async () => {
    const methods = await request(anonymous, 'GET', '/v1/auth-methods')
    expect(methods.body.setupNeeded).toBe(false)
    const res = await request(anonymous, 'POST', '/v1/setup', {
      code: 'ABCD-EFGH',
      name: 'Someone',
      email: 'someone@brightwater.example',
      password: 'a-long-enough-password',
    })
    expect(res.status).toBe(409)
    expect(await db.select().from(user).where(eq(user.email, 'someone@brightwater.example'))).toHaveLength(0)
  })

  test('refuses a short password before anything else', async () => {
    const res = await request(anonymous, 'POST', '/v1/setup', {
      code: 'x',
      name: 'A',
      email: 'a@brightwater.example',
      password: 'short',
    })
    expect(res.status).toBe(400)
  })
})

describe('setup emails and the at-risk list', () => {
  const spy = () => {
    const sent: Email[] = []
    const sender: EmailSender = {
      kind: 'smtp',
      send: async email => void sent.push(email),
      check: async () => ({ ok: true, message: '' }),
    }
    return { sent, sender }
  }
  const signedUpDaysAgo = (ws: Workspace, days: number) =>
    db
      .update(setup_events)
      .set({ at: new Date(Date.now() - days * 86_400_000).toISOString() })
      .where(and(eq(setup_events.workspace_id, ws.id), eq(setup_events.event, 'signup')))
  const realCall = async (ws: Workspace) => {
    const callId = (
      await act(agent(), 'call.start', { from: `+1503${Math.floor(1e6 + Math.random() * 9e6)}`, to: ws.number })
    ).body.data.callId as string
    await act(agent(ws.id), 'call.finish', { callId, outcome: 'message', title: 'Dripping shower valve' })
    return callId
  }
  const setOn = (on: boolean) => act(operator, 'setupEmails.set', { on })
  /** Without the call the helper files for it: no real call has reached it yet. */
  const newWorkspace = async (name: string) => {
    const ws = await createWorkspace(name)
    await db.delete(calls).where(eq(calls.id, ws.call.id))
    return ws
  }

  afterAll(() => setOn(false))

  test('off by default: nothing goes out until an instance admin turns them on', async () => {
    await db.delete(instance_settings).where(eq(instance_settings.key, 'setup_emails'))
    const ws = await newWorkspace('Setup Off Plumbing')
    await signedUpDaysAgo(ws, 0.2)
    const { sent, sender } = spy()
    expect(await sendDueSetupEmails(db, sender)).toMatchObject({ off: true })
    // Tests send no real email: the switch says so, and the partner directory is not set.
    expect((await act(operator, 'setupEmails.get', {})).body.data).toEqual({
      on: false,
      emailConnected: emailSender.kind === 'smtp',
      partnerDirectoryUrl: null,
    })
    expect((await act(ws.owner, 'notifications.get', {})).body.data.setupEmails).toBeNull()

    expect((await setOn(true)).body.data).toMatchObject({ on: true })
    expect((await act(ws.owner, 'notifications.get', {})).body.data.setupEmails).toBe(true)
    expect(await sendDueSetupEmails(db, sender)).toMatchObject({ off: false })
    expect(sent.filter(e => e.subject.includes('Setup Off Plumbing'))).toHaveLength(1)
    await sendDueSetupEmails(db, sender)
    expect(sent.filter(e => e.subject.includes('Setup Off Plumbing'))).toHaveLength(1)
  })

  test('the first real call gets its own email, once; later calls the usual one', async () => {
    await setOn(true)
    const ws = await createWorkspace('First Call Plumbing')
    const { sent, sender } = spy()
    await notifyCallFinished(db, sender, await realCall(ws))
    expect(sent.map(e => e.subject)).toEqual([expect.stringContaining('Your first real call')])
    expect(sent[0]!.text).toContain('Your first call')
    await notifyCallFinished(db, sender, await realCall(ws))
    expect(sent[1]!.subject).not.toContain('first real call')
    expect((await db.select().from(setup_emails).where(eq(setup_emails.workspace_id, ws.id))).map(r => r.kind)).toEqual(
      ['first_call'],
    )
  })

  test('when no email could go out, the first-call email waits for the next try', async () => {
    await setOn(true)
    const ws = await createWorkspace('First Call Retry Plumbing')
    const callId = await realCall(ws)
    const down: EmailSender = {
      kind: 'smtp',
      send: async () => {
        throw new Error('mail server down')
      },
      check: async () => ({ ok: false, message: '' }),
    }
    expect(await notifyCallFinished(db, down, callId)).toMatchObject({ sent: 0, failed: 1 })
    expect(await db.select().from(setup_emails).where(eq(setup_emails.workspace_id, ws.id))).toEqual([])
    const { sent, sender } = spy()
    await notifyCallFinished(db, sender, callId)
    expect(sent[0]!.subject).toContain('Your first real call')
  })

  test('the first-call email goes only to owners, like the other setup emails; other members get the usual one', async () => {
    await setOn(true)
    const ws = await createWorkspace('First Call Owners Only Plumbing')
    const admin = await addMember(ws.id, 'admin')
    const { sent, sender } = spy()
    await notifyCallFinished(db, sender, await realCall(ws))
    const ownerEmail = (await emailOf(ws.owner)).toLowerCase()
    const adminEmail = (await emailOf(admin)).toLowerCase()
    expect(sent.find(e => e.to.toLowerCase() === ownerEmail)?.subject).toContain('Your first real call')
    expect(sent.find(e => e.to.toLowerCase() === adminEmail)?.subject).not.toContain('first real call')
    expect(sent.find(e => e.to.toLowerCase() === adminEmail)?.text).toContain(`#call/`)
  })

  test('while email only goes to the log, the first call is not marked as sent', async () => {
    await setOn(true)
    const ws = await createWorkspace('First Call Log Only Plumbing')
    const callId = await realCall(ws)
    const sent: Email[] = []
    const log: EmailSender = {
      kind: 'log',
      send: async email => void sent.push(email),
      check: async () => ({ ok: true, message: '' }),
    }
    await notifyCallFinished(db, log, callId)
    expect(sent[0]!.subject).not.toContain('first real call')
    expect(await db.select().from(setup_emails).where(eq(setup_emails.workspace_id, ws.id))).toEqual([])
  })

  test('an owner who turned setup emails off gets the usual call email for the first call', async () => {
    await setOn(true)
    const ws = await createWorkspace('First Call Opt Out Plumbing')
    await act(ws.owner, 'notifications.update', { setupEmails: false })
    const { sent, sender } = spy()
    await notifyCallFinished(db, sender, await realCall(ws))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.subject).not.toContain('first real call')
  })

  test('at risk: signed up more than N days ago, no real call yet; milestones, emails and the owner', async () => {
    const stuck = await newWorkspace('Stuck Setup Plumbing')
    await signedUpDaysAgo(stuck, 2)
    await act(stuck.owner, 'onboarding.recordEvent', { event: 'forwarding_instructions_shown' })
    // Real calls from before the milestones were recorded: live too.
    const early = await createWorkspace('Early Calls Setup Plumbing')
    await signedUpDaysAgo(early, 2)
    await realCall(early)
    await db
      .delete(setup_events)
      .where(
        and(eq(setup_events.workspace_id, early.id), inArray(setup_events.event, ['first_real_call', 'activated'])),
      )
    const live = await createWorkspace('Live Setup Plumbing')
    await signedUpDaysAgo(live, 2)
    await realCall(live)
    const fresh = await newWorkspace('Fresh Setup Plumbing')

    const list = async (query = '') =>
      (await request(operator, 'GET', `/v1/admin/onboarding${query}`)).body as {
        days: number
        oldEnough: number
        workspaces: { id: string }[]
      }
    const byDefault = await list()
    expect(byDefault.days).toBe(1)
    // Stuck, early and live are old enough to judge, whether or not a real call came in; fresh is not.
    expect(byDefault.oldEnough).toBeGreaterThanOrEqual(3)
    expect(byDefault.oldEnough).toBeGreaterThan(byDefault.workspaces.length)
    const ids = byDefault.workspaces.map(w => w.id)
    expect(ids).toContain(stuck.id)
    expect(ids).not.toContain(live.id)
    expect(ids).not.toContain(early.id)
    expect(ids).not.toContain(fresh.id)
    expect(byDefault.workspaces.find(w => w.id === stuck.id)).toMatchObject({
      name: 'Stuck Setup Plumbing',
      owner_email: await emailOf(stuck.owner),
      milestones: { signup: expect.any(String), forwarding_instructions_shown: expect.any(String) },
      emails: {},
    })
    expect((await list('?days=3')).workspaces.map(w => w.id)).not.toContain(stuck.id)
    expect((await list('?days=0')).workspaces.map(w => w.id)).toContain(fresh.id)
    expect((await list('?days=-4')).days).toBe(0)
  })

  test('at risk: on a new install no workspace is old enough yet, which is not the same as all had a real call', async () => {
    const days = 30
    const now = new Date().toISOString()
    // Nothing in this test database signed up 30 days ago: an empty list with nobody to judge.
    expect(await workspacesOldEnough(db, days, now)).toBe(0)
    const old = await newWorkspace('Old Setup Plumbing')
    await signedUpDaysAgo(old, days + 1)
    await realCall(old)
    expect(await atRiskWorkspaces(db, days, now)).toEqual([])
    expect(await workspacesOldEnough(db, days, now)).toBe(1)
  })
})

describe('workspace.delete', () => {
  /** Rows per table of a workspace, over every table that has workspace_id (kept ones included). */
  async function rowsOf(workspaceId: string) {
    const counts: Record<string, number> = {}
    for (const table of [
      ...workspaceTables(),
      commands,
      auth_events,
      number_purchases,
      voice_clones,
      ledger_entries,
      usage_counters,
    ]) {
      const column = (table as unknown as { workspace_id: typeof calls.workspace_id }).workspace_id
      const [row] = (await db.execute(sql`select count(*)::int as n from ${table} where ${column} = ${workspaceId}`))
        .rows as { n: number }[]
      counts[getTableName(table)] = row!.n
    }
    return counts
  }

  /** A workspace with more than the fixture: a recording, settings, a push subscription, an API key, an invitation, a member's session on it. */
  async function fullWorkspace(name: string) {
    const ws = await createWorkspace(name)
    await db
      .update(calls)
      .set({ recording_key: recordingKey(ws.id, ws.call.id), recording_store: 'file' })
      .where(eq(calls.id, ws.call.id))
    await db.insert(push_subscriptions).values({
      workspace_id: ws.id,
      user_id: ws.owner.userId,
      endpoint: `https://push.example/${ws.id}`,
      p256dh: 'p',
      auth: 'a',
    })
    await db.insert(api_keys).values({
      id: `key_${ws.id}`,
      workspace_id: ws.id,
      name: 'Zapier',
      prefix: 'ld_test',
      key_hash: `hash_${ws.id}`,
      created_by: ws.owner.userId,
    })
    await db.insert(invitation).values({
      id: `inv_${ws.id}`,
      organizationId: ws.id,
      email: `invited-${ws.id}@example.com`,
      role: 'member',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId: ws.owner.userId,
      createdAt: new Date(),
    })
    await act(ws.owner, 'call.markDone', { callId: ws.call.id })
    return ws
  }

  test("refused for anyone but an instance admin, and for a name that is not the workspace's", async () => {
    const ws = await createWorkspace('Not Yours To Delete')
    for (const who of [ws.owner, other.owner, member, agent(ws.id)])
      expect(await act(who, 'workspace.delete', { workspaceId: ws.id, name: 'Not Yours To Delete' })).toMatchObject({
        status: 403,
      })
    expect(await act(operator, 'workspace.delete', { workspaceId: ws.id, name: 'Not Yours' })).toMatchObject({
      status: 409,
      body: { error: "type the workspace's name, Not Yours To Delete, to confirm" },
    })
    expect(await act(operator, 'workspace.delete', { workspaceId: 'org_missing', name: 'x' })).toMatchObject({
      status: 409,
      body: { error: 'workspace not found' },
    })
    expect((await db.select().from(organization).where(eq(organization.id, ws.id))).length).toBe(1)
  })

  test('keepAccounts keeps the accounts of members only in it; an instance admin member always keeps theirs', async () => {
    const ws = await createWorkspace('Keep The People')
    const res = await act(operator, 'workspace.delete', {
      workspaceId: ws.id,
      name: 'Keep The People',
      keepAccounts: true,
    })
    expect(res).toMatchObject({ status: 200, body: { data: { usersDeleted: [] } } })
    expect((await db.select().from(user).where(eq(user.id, ws.owner.userId))).length).toBe(1)

    const withAdmin = await createWorkspace('Admin Inside')
    await auth.api.addMember({ body: { userId: operator.userId, organizationId: withAdmin.id, role: 'member' } })
    const listed = (await request(operator, 'GET', '/v1/admin/workspaces')).body.workspaces.find(
      (w: { id: string }) => w.id === withAdmin.id,
    )
    expect(listed).toMatchObject({ members: 2, members_only_here: 1 })
    await act(operator, 'workspace.delete', { workspaceId: withAdmin.id, name: 'Admin Inside' })
    expect((await db.select().from(user).where(eq(user.id, operator.userId))).length).toBe(1)
    expect(await db.select().from(user).where(eq(user.id, withAdmin.owner.userId))).toEqual([])
  })

  test('a server admin only through INSTANCE_ADMIN_EMAILS keeps the account too: workspace deleted, removed, or leaving (#734 review, finding 1)', async () => {
    const before = process.env.INSTANCE_ADMIN_EMAILS
    const ws = await createWorkspace('Env Admin Inside')
    const envAdmins = [
      await addMember(ws.id, 'member'),
      await addMember(ws.id, 'admin'),
      await addMember(ws.id, 'member'),
    ]
    await db
      .update(user)
      .set({ emailVerified: true })
      .where(
        inArray(
          user.id,
          envAdmins.map(a => a.userId),
        ),
      )
    process.env.INSTANCE_ADMIN_EMAILS = (await Promise.all(envAdmins.map(emailOf))).join(',')
    try {
      const [removed, leaving, inDeleted] = envAdmins as [User, User, User]
      const memberIdOf = async (who: User) =>
        (
          await db
            .select()
            .from(memberTable)
            .where(and(eq(memberTable.userId, who.userId), eq(memberTable.organizationId, ws.id)))
        )[0]!.id
      expect(await act(operator, 'membership.remove', { memberId: await memberIdOf(removed) })).toMatchObject({
        status: 200,
        body: { data: { accountDeleted: false } },
      })
      expect((await act(leaving, 'team.leave', { deleteAccount: true })).body.data).toMatchObject({
        accountDeleted: false,
      })
      const res = await act(operator, 'workspace.delete', { workspaceId: ws.id, name: 'Env Admin Inside' })
      expect(res.status).toBe(200)
      expect(await db.select().from(user).where(eq(user.id, ws.owner.userId))).toEqual([])
      for (const who of [removed, leaving, inDeleted])
        expect(await db.select().from(user).where(eq(user.id, who.userId))).toHaveLength(1)
    } finally {
      process.env.INSTANCE_ADMIN_EMAILS = before ?? ''
      await db
        .update(user)
        .set({ emailVerified: false })
        .where(
          inArray(
            user.id,
            envAdmins.map(a => a.userId),
          ),
        )
    }
  })

  test('removes every row of the workspace and none of another; members only here lose their accounts, others land elsewhere', async () => {
    const gone = await fullWorkspace('Gone Plumbing')
    const kept = await fullWorkspace('Kept Plumbing')
    // Someone in both: their session is on the one that goes.
    const both = await addMember(gone.id, 'member')
    await auth.api.addMember({ body: { userId: both.userId, organizationId: kept.id, role: 'member' } })
    await db.update(session).set({ activeOrganizationId: gone.id }).where(eq(session.userId, both.userId))
    const queued: { name: string; data: unknown }[] = []
    setJobQueue({
      insert: async (name: string, jobs: { data: unknown }[]) =>
        void queued.push(...jobs.map(j => ({ name, data: j.data }))),
    } as never)
    const keptBefore = await rowsOf(kept.id)
    const emailOf = async (id: string) => (await db.select().from(user).where(eq(user.id, id)))[0]!.email
    const [ownerEmail, bothEmail] = [await emailOf(gone.owner.userId), await emailOf(both.userId)]
    try {
      const res = await act(operator, 'workspace.delete', { workspaceId: gone.id, name: ' gone plumbing ' })
      expect(res).toMatchObject({
        status: 200,
        body: { ok: true, data: { workspaceId: gone.id, name: 'Gone Plumbing', recordings: 1 } },
      })
      expect(res.body.data.deleted).toMatchObject({
        calls: 1,
        contacts: 1,
        push_subscriptions: 1,
        api_keys: 1,
        phone_numbers: 1,
      })
      expect(res.body.data.numbers).toEqual([{ e164: gone.number, carrier: 'none' }])
      expect(res.body.data.usersDeleted).toContain(ownerEmail)
      expect(res.body.data.usersDeleted).not.toContain(bothEmail)
    } finally {
      setJobQueue(null)
    }
    expect(queued.filter(q => q.name !== 'workspace.deletedEmail')).toEqual([
      { name: 'recording.deleteFile', data: { store: 'file', key: recordingKey(gone.id, gone.call.id) } },
    ])
    // Every member hears of it, with whether their account went (member-cleanup.test.ts has the details).
    expect(
      queued
        .filter(q => q.name === 'workspace.deletedEmail')
        .map(q => q.data as { to: string; accountDeleted: boolean }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: ownerEmail, accountDeleted: true }),
        expect.objectContaining({ to: bothEmail, accountDeleted: false }),
      ]),
    )

    const after = await rowsOf(gone.id)
    for (const [table, n] of Object.entries(after)) if (!(table in KEPT_TABLES)) expect(n, table).toBe(0)
    expect(await rowsOf(kept.id)).toEqual(keptBefore)
    expect(await db.select().from(organization).where(eq(organization.id, gone.id))).toEqual([])
    expect(await db.select().from(memberTable).where(eq(memberTable.organizationId, gone.id))).toEqual([])
    expect(await db.select().from(invitation).where(eq(invitation.organizationId, gone.id))).toEqual([])
    expect((await db.select().from(invitation).where(eq(invitation.organizationId, kept.id))).length).toBe(1)

    // The audit log keeps its entries, but nothing else of what the workspace's commands carried.
    const logged = await db.select().from(commands).where(eq(commands.workspace_id, gone.id))
    expect(logged.find(c => c.action === 'call.markDone')?.pruned_at).not.toBeNull()
    const [entry] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.action, 'workspace.delete'), sql`${commands.input}->>'workspaceId' = ${gone.id}`))
    expect(entry).toMatchObject({
      actor_id: operator.userId,
      rejected: false,
      input: { workspaceId: gone.id, name: 'gone plumbing' },
    })
    const audit = (await request(operator, 'GET', `/v1/admin/audit?workspace=${gone.id}`)).body
    expect(audit.entries.some((e: { what: string }) => e.what === 'workspace.delete')).toBe(true)

    // One in another workspace keeps the account and lands there; the owner of only this one is deleted.
    expect((await request(both, 'GET', '/v1/me')).body.workspace).toMatchObject({ id: kept.id })
    expect(await db.select().from(user).where(eq(user.id, gone.owner.userId))).toEqual([])
    expect(await db.select().from(session).where(eq(session.userId, gone.owner.userId))).toEqual([])
    expect((await request(gone.owner, 'GET', '/v1/me')).status).toBe(401)
    // A tab still on the deleted workspace is told it is gone.
    expect(await request(both, 'GET', '/v1/me', undefined, { 'x-workspace-id': gone.id })).toMatchObject({
      status: 403,
      body: { code: 'workspace_access_lost' },
    })
  })

  test('numbers: bought ones are released in the install account, others un-routed; a carrier failure is reported, not fatal', async () => {
    const ws = await createWorkspace('Numbers Plumbing')
    await db.delete(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))
    const n = (suffix: string) => `+1971555${suffix}`
    await db.insert(phone_numbers).values([
      {
        id: `pn_b_${ws.id}`,
        workspace_id: ws.id,
        e164: n('0101'),
        provider: 'telnyx',
        provider_ref: 'r1',
        purchased: true,
      },
      { id: `pn_a_${ws.id}`, workspace_id: ws.id, e164: n('0102'), provider: 'telnyx', provider_ref: 'r2' },
      {
        id: `pn_o_${ws.id}`,
        workspace_id: ws.id,
        e164: n('0103'),
        provider: 'telnyx',
        provider_ref: 'r3',
        purchased: true,
        carrier_account: 'workspace',
      },
      { id: `pn_f_${ws.id}`, workspace_id: ws.id, e164: n('0104'), provider: 'telnyx', provider_ref: 'fail' },
      { id: `pn_t_${ws.id}`, workspace_id: ws.id, e164: n('0105'), provider: 'twilio', provider_ref: 'r5' },
    ])
    const calls_: string[] = []
    const telephony = {
      name: 'telnyx',
      releaseNumber: async (o: { e164: string }) => void calls_.push(`release ${o.e164}`),
      unrouteNumber: async (o: { e164: string; providerRef: string }) => {
        if (o.providerRef === 'fail') throw new Error('carrier down')
        calls_.push(`unroute ${o.e164}`)
      },
    }
    const actor = {
      actorId: operator.userId,
      role: 'owner',
      workspaceId: null,
      permissions: ['instance:admin'],
    } as unknown as Actor
    const result = await db.transaction(tx =>
      adminHandlers['workspace.delete']!(
        { tx, actor, now: new Date().toISOString(), telephony: telephony as never },
        { workspaceId: ws.id, name: 'Numbers Plumbing' },
      ),
    )
    expect(calls_.sort()).toEqual([`release ${n('0101')}`, `unroute ${n('0102')}`, `unroute ${n('0103')}`].sort())
    const numbers = (result.data as { numbers: { e164: string; carrier: string }[] }).numbers
    expect(Object.fromEntries(numbers.map(x => [x.e164, x.carrier]))).toEqual({
      [n('0101')]: 'released',
      [n('0102')]: 'unrouted',
      [n('0103')]: 'unrouted',
      [n('0104')]: 'left',
      [n('0105')]: 'left',
    })
    expect(await db.select().from(phone_numbers).where(eq(phone_numbers.workspace_id, ws.id))).toEqual([])
  })
})

describe("the system prompt: the instance admin's wording for every workspace (LIN-346)", () => {
  const getPrompt = async () => (await act(operator, 'systemPrompt.get', {})).body.data
  const startCall = async (ws: Workspace) =>
    (await act(agent(), 'call.start', { from: `+1503${Math.floor(1e6 + Math.random() * 9e6)}`, to: ws.number })).body
      .data.promptOverrides

  afterAll(() => db.delete(prompt_overrides))

  test('only instance admins read or change it; an edit must keep the variables of its default', async () => {
    await db.delete(prompt_overrides)
    expect(await getPrompt()).toEqual({ overrides: [] })
    const ws = await createWorkspace('Prompt Rights Plumbing')
    expect((await act(ws.owner, 'systemPrompt.get', {})).status).toBe(403)
    expect((await act(ws.owner, 'systemPrompt.setPart', { key: 'rules.spam', text: 'Hang up.' })).status).toBe(403)
    expect((await act(ws.owner, 'systemPrompt.resetPart', { key: 'rules.spam' })).status).toBe(403)
    // An unknown part, an edit without the {name} of its default, an empty one, one too long.
    for (const input of [
      { key: 'rules.unknown', text: 'x' },
      { key: 'role.intro', text: 'You are the assistant.' },
      { key: 'rules.spam', text: ' \n ' },
      { key: 'rules.spam', text: 'x'.repeat(PROMPT_OVERRIDE_MAX + 1) },
    ])
      expect((await act(operator, 'systemPrompt.setPart', input)).status, input.key).toBe(422)
    expect(await db.select().from(prompt_overrides)).toEqual([])
  })

  test('the agent gets the edits at call start, cleaned; the default text and a reset go back to the default', async () => {
    await db.delete(prompt_overrides)
    const ws = await createWorkspace('Prompt Edit Plumbing')
    const set = await act(operator, 'systemPrompt.setPart', {
      key: 'role.intro',
      text: ' You are {name}.\r\nBe brief.\u0007 ',
    })
    expect(set.status).toBe(200)
    expect(set.body.data.overrides).toEqual([
      expect.objectContaining({
        key: 'role.intro',
        text: 'You are {name}.\nBe brief.',
        defaultChanged: false,
        fits: true,
      }),
    ])
    await act(operator, 'systemPrompt.setPart', { key: 'rules.spam', text: 'Spam: hang up politely.' })
    expect(await startCall(ws)).toEqual({
      'role.intro': 'You are {name}.\nBe brief.',
      'rules.spam': 'Spam: hang up politely.',
    })
    // The audit log keeps who changed the prompt.
    const logged = await db.select().from(commands).where(eq(commands.action, 'systemPrompt.setPart'))
    expect(logged.length).toBeGreaterThanOrEqual(2)

    await act(operator, 'systemPrompt.setPart', { key: 'rules.spam', text: PROMPT_TEXTS['rules.spam'].text })
    expect((await act(operator, 'systemPrompt.resetPart', { key: 'role.intro' })).body.data).toEqual({ overrides: [] })
    expect(await startCall(ws)).toEqual({})
  })

  test('an edit says when its default changed since, and whether it still fits', async () => {
    await db.delete(prompt_overrides)
    await db.insert(prompt_overrides).values([
      { key: 'rules.spam', text: 'Hang up on spam.', default_text: 'An older default.' },
      { key: 'role.intro', text: 'You are the assistant.', default_text: PROMPT_TEXTS['role.intro'].text },
      { key: 'gone.part', text: 'A part no longer in the code.', default_text: 'x' },
    ])
    const { overrides } = await getPrompt()
    // In the order of the prompt; a part no longer in the code is left out.
    expect(overrides.map((o: { key: string }) => o.key)).toEqual(['role.intro', 'rules.spam'])
    expect(overrides[0]).toMatchObject({ defaultChanged: false, fits: false })
    expect(overrides[1]).toMatchObject({ defaultChanged: true, fits: true })
  })
})

describe('alerts without email set up (the CLI on a fresh install)', () => {
  afterEach(() => vi.restoreAllMocks())
  const noEmail = (): EmailSender => ({
    kind: 'none',
    send: vi.fn(async () => {
      throw new Error('Email is not set up: connect it in Server admin › Providers › Email')
    }),
    check: async () => ({ ok: false, message: 'Not set up' }),
  })

  test('the admin alert is skipped with one log line, no error and no stack', async () => {
    const sender = noEmail()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await alertInstanceAdmins(passkeysResetAlert({ operator: true }, 'ann@example.com', 1, false), sender)
    sendNotice({ to: 'ann@example.com', subject: 's', text: 't' }, 'passkeys reset email', sender)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sender.send).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([
      [`Admin alert not sent (email is not set up): Passkeys reset on ${brandName()}: ann@example.com`],
      ['passkeys reset email not sent: email is not set up (Server admin › Providers › Email).'],
    ])
  })

  test('with email set up the alert goes to every instance admin as before', async () => {
    const sent: Email[] = []
    const sender: EmailSender = {
      kind: 'smtp',
      send: async e => void sent.push(e),
      check: async () => ({ ok: true, message: '' }),
    }
    await alertInstanceAdmins(locale => ({ subject: `Subject ${locale}`, blocks: [] }), sender)
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0))
    expect(sent.every(e => e.subject === 'Subject en')).toBe(true)
  })
})

describe('Server admin › Call reviews: the flagged calls, staff only', () => {
  const evaluate = async (ws: Workspace, score: number, issues: string[], at: string) => {
    const id = `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
    await db.insert(calls).values({
      id,
      workspace_id: ws.id,
      from_number: '+15035550199',
      to_number: ws.number,
      status: 'completed',
      title: `Call ${score}`,
      started_at: at,
    })
    await db
      .insert(call_evaluations)
      .values({ call_id: id, workspace_id: ws.id, score, issues, unanswered: [], created_at: at })
    return id
  }
  type Review = { call_id: string; workspace_id: string; workspace_name: string; score: number; issues: string[] }
  const read = async (query = '') =>
    (await request(operator, 'GET', `/v1/admin/call-reviews${query}`)).body as {
      reviews: Review[]
      workspaces: { id: string; name: string; flagged: number }[]
    }

  test('across workspaces, newest first, only scores of 3 or lower, a deleted call never; filtered by workspace', async () => {
    const elsewhere = await createWorkspace('Harbor Dental Review')
    const older = await evaluate(other, 2, ['Kept asking "Are you still there?"'], '2026-11-10T10:00:00.000Z')
    const newer = await evaluate(elsewhere, 3, ['Said Tuesday for Wednesday'], '2026-11-12T10:00:00.000Z')
    const fine = await evaluate(other, 5, [], '2026-11-13T10:00:00.000Z')
    const deleted = await evaluate(other, 1, ['Hung up'], '2026-11-14T10:00:00.000Z')
    await db.update(calls).set({ deleted_at: new Date().toISOString() }).where(eq(calls.id, deleted))

    const all = await read()
    const ids = all.reviews.map(r => r.call_id)
    expect(ids).toEqual(expect.arrayContaining([older, newer]))
    expect(ids).not.toContain(fine)
    expect(ids).not.toContain(deleted)
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older))
    expect(all.reviews.find(r => r.call_id === older)).toMatchObject({
      workspace_id: other.id,
      workspace_name: 'Brightwater Plumbing & Heating',
      score: 2,
      issues: ['Kept asking "Are you still there?"'],
    })
    expect(all.workspaces).toEqual(
      expect.arrayContaining([
        { id: other.id, name: 'Brightwater Plumbing & Heating', flagged: 1 },
        { id: elsewhere.id, name: 'Harbor Dental Review', flagged: 1 },
      ]),
    )

    const filtered = await read(`?workspace=${elsewhere.id}`)
    expect(filtered.reviews.map(r => r.call_id)).toEqual([newer])
    // The filter still offers every workspace with flagged calls.
    expect(filtered.workspaces.map(w => w.id)).toEqual(expect.arrayContaining([other.id, elsewhere.id]))
  })

  test("refused to the workspace's own owner and admins, members, agents and a partner's team", async () => {
    const admin = await addMember(other.id, 'admin')
    for (const who of [other.owner, admin, member, agent(other.id)])
      expect((await request(who, 'GET', '/v1/admin/call-reviews')).status).toBe(403)
    // A white-label partner that runs workspaces for its clients is no server admin either.
    const mails: Email[] = []
    vi.spyOn(emailSender, 'send').mockImplementation(async e => void mails.push(e as never))
    try {
      const ownerEmail = `partner_${crypto.randomUUID().slice(0, 8)}@linedesk.test`
      const created = await act(operator, 'partner.create', { name: 'Review Partner', ownerEmail })
      expect(created.status).toBe(200)
      const partnerId: string = created.body.data.partner.id
      expect((await act(operator, 'partner.approve', { partnerId })).status).toBe(200)
      const partnerOwner = await signUp(ownerEmail)
      await db.update(user).set({ emailVerified: true }).where(eq(user.id, partnerOwner.userId))
      const token = mails
        .filter(e => e.to === ownerEmail)
        .map(e => e.text.match(/#partner-invite=([\w-]+)/)?.[1])
        .findLast(Boolean)
      expect((await act(partnerOwner, 'partnerInvitation.accept', { token })).status).toBe(200)
      expect((await act(partnerOwner, 'workspace.createForClient', { partnerId, name: 'Partner Client' })).status).toBe(
        200,
      )
      expect(await request(partnerOwner, 'GET', '/v1/admin/call-reviews')).toMatchObject({
        status: 403,
        body: { ok: false, error: 'missing permission instance:admin' },
      })
    } finally {
      vi.restoreAllMocks()
    }
  })
})
