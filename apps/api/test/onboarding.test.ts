// Onboarding progress on the workspace: starts with a new workspace, survives reloads (/v1/me), ends with done or skipped.
import { BASE_BUY_OFFERS } from '@linedesk/actions'
import { phone_numbers, setup_events, workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { phoneSetupStatus, phoneSetupView, workspaceTimeZone } from '../src/onboarding.ts'
import { act, addMember, createWorkspace, getAssistant, request } from './helpers.ts'

/** A number libphonenumber takes as a US line (randomNumber can draw an exchange no line has). */
const mobileNumber = () => `+1503922${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`

const settingsOf = async (id: string) => (await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, id)))[0]

describe('onboarding progress', () => {
  test('a new workspace starts at the business step (US Eastern when the browser sends no time zone)', async () => {
    const ws = await createWorkspace('Fresh Plumbing')
    expect((await request(ws.owner, 'GET', '/v1/me')).body.onboarding).toMatchObject({ step: 'business', phone: expect.any(Object) })
    expect(await settingsOf(ws.id)).toMatchObject({ timezone: 'America/New_York', onboarding_step: 'business' })
  })

  test('the step is stored and /v1/me resumes there; done ends onboarding', async () => {
    const ws = await createWorkspace('Resume Plumbing')
    for (const step of ['assistant', 'pickup', 'notify', 'phone']) {
      expect((await act(ws.owner, 'onboarding.setStep', { step })).status).toBe(200)
      expect((await request(ws.owner, 'GET', '/v1/me')).body.onboarding.step).toBe(step)
    }
    await act(ws.owner, 'onboarding.setStep', { step: 'done' })
    expect((await request(ws.owner, 'GET', '/v1/me')).body.onboarding).toBeNull()
  })

  test('a step of the earlier flow (from the release before) is still taken, and resumes at the step that took its place', async () => {
    const ws = await createWorkspace('Legacy Plumbing')
    const resumed: Record<string, string> = { hours: 'pickup', calendar: 'assistant', test_call: 'assistant' }
    for (const [old, now] of Object.entries(resumed)) {
      expect((await act(ws.owner, 'onboarding.setStep', { step: old })).status).toBe(200)
      expect((await settingsOf(ws.id))?.onboarding_step).toBe(old)
      expect((await request(ws.owner, 'GET', '/v1/me')).body.onboarding.step).toBe(now)
    }
  })

  test('the pick-up choice is stored with the workspace settings; members cannot change it', async () => {
    const ws = await createWorkspace('Pickup Plumbing')
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data.pickupMode).toBeNull()
    const saved = await act(ws.owner, 'workspace.updateSettings', { pickupMode: 'after_hours', businessHoursOn: true })
    expect(saved.status).toBe(200)
    expect(saved.body.data).toMatchObject({ pickupMode: 'after_hours', businessHoursOn: true })
    expect((await act(ws.owner, 'workspace.getSettings', {})).body.data.pickupMode).toBe('after_hours')
    expect(await settingsOf(ws.id)).toMatchObject({ pickup_mode: 'after_hours', business_hours_on: true })
    expect((await act(ws.owner, 'workspace.updateSettings', { pickupMode: 'sometimes' })).status).toBe(422)
    const member = await addMember(ws.id, 'member')
    expect((await act(member, 'workspace.updateSettings', { pickupMode: 'always' })).status).toBe(403)
    expect((await settingsOf(ws.id))?.pickup_mode).toBe('after_hours')
  })

  test("who hears about calls: the owner's mobile is an urgent transfer contact, checked like any other", async () => {
    const ws = await createWorkspace('Who Hears Plumbing')
    const { transfers } = ws.assistant
    const urgent = (number: string) => ({
      id: 'urgent',
      name: 'Mike Brennan',
      number,
      condition: 'An urgent problem or emergency that cannot wait until we call back',
      hours_only: false,
      ring_seconds: 25,
      if_no_answer: 'message',
      enabled: true,
    })
    const save = (number: string, who = ws.owner, assistantId = ws.assistant.id) =>
      act(who, 'assistant.update', { assistantId, transfers: [urgent(number), ...transfers] })
    // The workspace's own Linedesk number would ring back into Linedesk.
    const linedesk = mobileNumber()
    await db.insert(phone_numbers).values({ id: `pn_${crypto.randomUUID()}`, workspace_id: ws.id, e164: linedesk, provider: 'dev' })
    const own = await save(linedesk)
    expect(own.status).toBe(409)
    expect(own.body.error).toMatch(/is a Linedesk number/)
    const mobile = mobileNumber()
    expect((await save(mobile)).status).toBe(200)
    expect((await getAssistant(ws.assistant.id))?.transfers.map(c => [c.id, c.number])).toEqual([
      ['urgent', mobile],
      ['person', null],
    ])
    const events = await db.select().from(setup_events).where(eq(setup_events.workspace_id, ws.id))
    expect(events.map(e => e.event)).toContain('mobile_added')
    // An address not confirmed yet puts no calls through to a number.
    const unconfirmed = await createWorkspace('Unconfirmed Plumbing', false)
    const refused = await act(unconfirmed.owner, 'assistant.update', {
      assistantId: unconfirmed.assistant.id,
      transfers: [urgent(mobileNumber())],
    })
    expect(refused.status).toBe(403)
    expect(refused.body.code).toBe('EMAIL_NOT_VERIFIED')
  })

  test("a mobile that becomes a Linedesk number is switched off as a transfer contact; Settings stays editable", async () => {
    const ws = await createWorkspace('Solo Plumbing')
    const mobile = mobileNumber()
    const urgent = {
      id: 'urgent',
      name: 'Mike Brennan',
      number: mobile,
      condition: 'An urgent problem',
      hours_only: false,
      ring_seconds: 25,
      if_no_answer: 'message',
      enabled: true,
    }
    const transfers = [urgent, ...ws.assistant.transfers]
    expect((await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers })).status).toBe(200)
    // The owner's mobile is the business line, and it is set up in Linedesk: a transfer there would ring back in.
    const setup = await act(ws.owner, 'phoneNumber.setup', { e164: mobile })
    expect(setup.status).toBe(200)
    const after = (await getAssistant(ws.assistant.id))!.transfers
    expect(after[0]).toMatchObject({ id: 'urgent', number: mobile, enabled: false })
    expect(after[1]).toEqual(ws.assistant.transfers[0])
    // The list still saves with the contact off; switching it on again is refused.
    expect((await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: after })).status).toBe(200)
    const on = after.map(c => (c.id === 'urgent' ? { ...c, enabled: true } : c))
    expect((await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, transfers: on })).status).toBe(409)
  })

  test('skipping ends it too; an unknown step is refused', async () => {
    const ws = await createWorkspace('Skip Plumbing')
    expect((await act(ws.owner, 'onboarding.setStep', { step: 'billing' })).status).toBe(422)
    await act(ws.owner, 'onboarding.setStep', { step: 'skipped' })
    expect((await request(ws.owner, 'GET', '/v1/me')).body.onboarding).toBeNull()
  })

  test('members without settings access never see onboarding and cannot move it', async () => {
    const ws = await createWorkspace('Member Plumbing')
    const member = await addMember(ws.id, 'member')
    expect((await request(member, 'GET', '/v1/me')).body.onboarding).toBeNull()
    expect((await act(member, 'onboarding.setStep', { step: 'done' })).status).toBe(403)
    expect((await settingsOf(ws.id))?.onboarding_step).toBe('business')
  })

  test('a workspace without a settings row (made before onboarding existed) skips it', async () => {
    const ws = await createWorkspace('Old Plumbing')
    await db.delete(workspace_settings).where(eq(workspace_settings.workspace_id, ws.id))
    expect((await request(ws.owner, 'GET', '/v1/me')).body.onboarding).toBeNull()
    await act(ws.owner, 'onboarding.setStep', { step: 'phone' }) // creates the row again
    expect(await settingsOf(ws.id)).toMatchObject({ timezone: 'America/New_York', onboarding_step: 'phone' })
  })
})

describe('phone setup status', () => {
  test('says plainly when carrier keys or the SIP endpoint are missing', async () => {
    const provider = (name: string) => async () => ({ name })
    const missingKeys = async () => { throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN not set') }
    expect(await phoneSetupStatus(provider('dev'), {})).toEqual({ provider: 'dev', problem: null })
    expect(await phoneSetupStatus(missingKeys, {})).toEqual({ provider: null, problem: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN not set' })
    expect(await phoneSetupStatus(provider('twilio'), {})).toEqual({ provider: 'twilio', problem: 'LIVEKIT_SIP_ENDPOINT is not set' })
    expect(await phoneSetupStatus(provider('twilio'), { LIVEKIT_SIP_ENDPOINT: 'sip.example.com' })).toEqual({ provider: 'twilio', problem: null })
  })

  test('only instance admins see what the server lacks; owners get available or not', () => {
    const missing = { provider: 'twilio', problem: 'LIVEKIT_SIP_ENDPOINT is not set' }
    expect(phoneSetupView(missing, { permissions: ['settings:write'] })).toEqual({ provider: 'twilio', available: false, detail: null, canAttach: false, buy: [...BASE_BUY_OFFERS], account: 'install' })
    expect(phoneSetupView(missing, { permissions: ['settings:write', 'instance:admin'] })).toEqual({ provider: 'twilio', available: false, detail: 'LIVEKIT_SIP_ENDPOINT is not set', canAttach: true, buy: [...BASE_BUY_OFFERS], account: 'install' })
    expect(phoneSetupView({ provider: 'dev', problem: null }, { permissions: [] })).toEqual({ provider: 'dev', available: true, detail: null, canAttach: true, buy: [...BASE_BUY_OFFERS], account: 'install' })
    expect(phoneSetupView(missing, { permissions: ['settings:write'] }, 'workspace').canAttach).toBe(true)
  })

  test("a number already in the install's account, whatever its carrier: only an instance admin", () => {
    const owner = { permissions: ['settings:write'] } as const
    const admin = { permissions: ['settings:write', 'instance:admin'] } as const
    const canAttach = (actor: { permissions: readonly ('settings:write' | 'instance:admin')[] }, account: 'install' | 'workspace', provider: string) =>
      phoneSetupView({ provider, problem: null }, actor, account).canAttach
    for (const provider of ['telnyx', 'twilio']) {
      expect(canAttach(owner, 'install', provider)).toBe(false)
      expect(canAttach(admin, 'install', provider)).toBe(true)
      // The workspace's own carrier account is never limited.
      expect(canAttach(owner, 'workspace', provider)).toBe(true)
    }
    // Nor is the development carrier.
    expect(canAttach(owner, 'install', 'dev')).toBe(true)
  })

  test('/v1/me tells owners whether phone setup works, members get nothing', async () => {
    const ws = await createWorkspace('Phone View Plumbing')
    expect((await request(ws.owner, 'GET', '/v1/me')).body.phoneSetup).toMatchObject({ available: expect.any(Boolean) })
    const member = await addMember(ws.id, 'member')
    expect((await request(member, 'GET', '/v1/me')).body.phoneSetup).toBeNull()
  })

  test('the workspace time zone falls back to US Eastern for anything that is not a zone', () => {
    expect(workspaceTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles')
    expect(workspaceTimeZone('Mars/Olympus')).toBe('America/New_York')
    expect(workspaceTimeZone(42)).toBe('America/New_York')
  })
})
