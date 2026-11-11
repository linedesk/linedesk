// Onboarding progress on the workspace: starts with a new workspace, survives reloads (/v1/me), ends with done or skipped.
import { workspace_settings } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { phoneSetupStatus } from '../src/handlers.ts'
import { phoneSetupView, workspaceTimeZone } from '../src/onboarding.ts'
import { act, addMember, createWorkspace, request } from './helpers.ts'

const settingsOf = async (id: string) => (await db.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, id)))[0]

describe('onboarding progress', () => {
  test('a new workspace starts at the business step (US Eastern when the browser sends no time zone)', async () => {
    const ws = await createWorkspace('Fresh Plumbing')
    expect((await request(ws.owner, 'GET', '/v1/me')).body.onboarding).toMatchObject({ step: 'business', phone: expect.any(Object) })
    expect(await settingsOf(ws.id)).toMatchObject({ timezone: 'America/New_York', onboarding_step: 'business' })
  })

  test('the step is stored and /v1/me resumes there; done ends onboarding', async () => {
    const ws = await createWorkspace('Resume Plumbing')
    expect((await act(ws.owner, 'onboarding.setStep', { step: 'test_call' })).status).toBe(200)
    expect((await request(ws.owner, 'GET', '/v1/me')).body.onboarding.step).toBe('test_call')
    await act(ws.owner, 'onboarding.setStep', { step: 'done' })
    expect((await request(ws.owner, 'GET', '/v1/me')).body.onboarding).toBeNull()
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
    expect(phoneSetupView(missing, { permissions: ['settings:write'] })).toEqual({ provider: 'twilio', available: false, detail: null, canAttach: false })
    expect(phoneSetupView(missing, { permissions: ['settings:write', 'instance:admin'] })).toEqual({ provider: 'twilio', available: false, detail: 'LIVEKIT_SIP_ENDPOINT is not set', canAttach: true })
    expect(phoneSetupView({ provider: 'dev', problem: null }, { permissions: [] })).toEqual({ provider: 'dev', available: true, detail: null, canAttach: true })
    expect(phoneSetupView(missing, { permissions: ['settings:write'] }, 'workspace').canAttach).toBe(true)
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
