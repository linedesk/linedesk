import { expect, test } from 'vitest'
import {
  actions,
  applyLocally,
  isRecordingKey,
  recordingKey,
  callFlagUrgent,
  callTakeMessage,
  onboardingSetStep,
  phoneNumberSetup,
  rolePermissions,
  type LocalTables,
} from './index.ts'

test('assistant tools and phone setup are in the registry with the right permission', () => {
  expect(actions.get('call.takeMessage')?.permission).toBe('agent')
  expect(actions.get('call.flagUrgent')?.permission).toBe('agent')
  expect(actions.get('phoneNumber.setup')?.permission).toBe('settings:write')
  expect(rolePermissions.agent).toContain('agent')
  expect(rolePermissions.member).not.toContain('settings:write')
  expect(rolePermissions.member).not.toContain('agent')
})

// A read without readOnly counts as a write: an impersonation without edits refuses it, so its part of the page cannot
// load for support (mail.getAnalysis on Integrations › Support email, 2026-11-22).
test('actions named like a read (get, list) are read-only', () => {
  const reads = [...actions.values()].filter(a => /\.(get|list)[A-Z]/.test(a.name))
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.filter(a => !a.readOnly).map(a => a.name)).toEqual([])
})

test('call.flagUrgent applies locally as urgency urgent', () => {
  const tables = { calls: new Map([['call_1', { id: 'call_1', urgency: 'normal' }]]) } as unknown as LocalTables
  applyLocally(tables, callFlagUrgent, { callId: 'call_1' }, new Date().toISOString())
  expect(tables.calls.get('call_1')?.urgency).toBe('urgent')
})

test('inputs are validated', () => {
  expect(callTakeMessage.input.safeParse({ callId: 'call_1', message: '' }).success).toBe(false)
  expect(callTakeMessage.input.safeParse({ callId: 'call_1', message: 'Call back about the quote' }).success).toBe(true)
  expect(phoneNumberSetup.input.safeParse({ e164: '5035550142' }).success).toBe(false)
  expect(phoneNumberSetup.input.safeParse({ areaCode: '50' }).success).toBe(false)
  expect(phoneNumberSetup.input.safeParse({ e164: '+15035550142' }).success).toBe(true)
  expect(phoneNumberSetup.input.safeParse({ areaCode: '503' }).success).toBe(false) // an area code alone would buy
  expect(phoneNumberSetup.input.safeParse({ areaCode: '503', purchase: true }).success).toBe(true)
  // Which area codes a number can be bought in depends on the workspace's country and the install's offers: the
  // server refuses toll-free, N11, 555 and codes not in service (apps/api/test/number-buy.test.ts).
  expect(phoneNumberSetup.input.safeParse({ areaCode: '0503', purchase: true }).success).toBe(false)
  // A country without area codes (a national number) buys with neither: the server checks the offer.
  expect(phoneNumberSetup.input.safeParse({ purchase: true }).success).toBe(true)
  expect(phoneNumberSetup.input.parse({ e164: '+15035550142' })).toEqual({ e164: '+15035550142', purchase: false })
  expect(phoneNumberSetup.input.safeParse({ e164: '+15035550142', mode: 'ported' }).success).toBe(true)
  expect(phoneNumberSetup.input.safeParse({ e164: '+15035550142', mode: 'rented' }).success).toBe(false)
  expect(phoneNumberSetup.input.safeParse({}).success).toBe(false)
})

test('recordings: the agent only names the call, the key is derived, the setting is a boolean', () => {
  const setRecording = actions.get('call.setRecording')!
  expect(setRecording.permission).toBe('agent')
  expect(setRecording.patch).toBeUndefined()
  expect(setRecording.input.parse({ callId: 'call_1' })).toEqual({ callId: 'call_1', format: 'ogg' })
  expect(setRecording.input.parse({ callId: 'call_1', recordingKey: '../other/secret.txt' })).toEqual({
    callId: 'call_1',
    format: 'ogg',
  })
  expect(setRecording.input.safeParse({ callId: 'call_1', format: 'exe' }).success).toBe(false)

  expect(recordingKey('ws_1', 'call_1')).toBe('ws_1/call_1.ogg')
  expect(isRecordingKey(recordingKey('NRopXAq2oDVg6xL3', 'call_61ba36e0'))).toBe(true)
  for (const key of [
    '../other-bucket/secret.txt',
    '/etc/passwd',
    'ws_1/../ws_2/call.ogg',
    'ws_1/call_1.txt',
    'ws_1/a/call.ogg',
    'call.ogg',
  ]) {
    expect(isRecordingKey(key)).toBe(false)
  }

  for (const role of ['owner', 'admin', 'member'] as const) expect(rolePermissions[role]).toContain('call:read')
  expect(rolePermissions.agent).not.toContain('call:read')

  const update = actions.get('assistant.update')!
  expect(update.input.safeParse({ assistantId: 'as_1', record_calls: false }).success).toBe(true)
  expect(update.input.safeParse({ assistantId: 'as_1', record_calls: 'no' }).success).toBe(false)
  expect(update.patch!.set({ assistantId: 'as_1', record_calls: false }, '')).toEqual({ record_calls: false })
  // call_rules is no longer a setting: a web app of the release before sending it changes nothing.
  expect(update.input.parse({ assistantId: 'as_1', call_rules: 'Ask for the address.' })).not.toHaveProperty(
    'call_rules',
  )
})

test('onboarding.setStep: registered, owners and admins only, known steps only', () => {
  expect(actions.get('onboarding.setStep')).toBe(onboardingSetStep)
  expect(onboardingSetStep.permission).toBe('settings:write')
  expect(rolePermissions.member).not.toContain(onboardingSetStep.permission)
  for (const step of ['business', 'phone', 'hours', 'calendar', 'test_call', 'done', 'skipped'])
    expect(onboardingSetStep.input.safeParse({ step }).success).toBe(true)
  expect(onboardingSetStep.input.safeParse({ step: 'billing' }).success).toBe(false)
})

test('How the assistant did: Done, Reopen and the questions are for owners and admins, like reading evaluations', async () => {
  const {
    evaluationMarkDone,
    evaluationReopen,
    evaluationListQuestions,
    callListEvaluations,
    callGetEvaluation,
    scoreWords,
  } = await import('./evaluations.ts')
  for (const def of [evaluationMarkDone, evaluationReopen, evaluationListQuestions]) {
    expect(actions.get(def.name)).toBe(def)
    expect(def.permission).toBe(callGetEvaluation.permission)
    expect(rolePermissions.member).not.toContain(def.permission)
  }
  // Writes on the server only: nothing to apply in the browser (evaluations are not synced).
  expect(evaluationMarkDone.patch).toBeUndefined()
  expect(evaluationReopen.readOnly).toBeUndefined()
  expect(evaluationListQuestions.readOnly).toBe(true)
  expect(evaluationMarkDone.input.safeParse({ callId: '' }).success).toBe(false)
  expect(evaluationMarkDone.input.parse({ callId: 'call_1' })).toEqual({ callId: 'call_1' })
  // The open filter: true, false or left out (all, as before).
  expect(callListEvaluations.input.parse({ needsReview: true, open: true })).toMatchObject({ open: true, limit: 200 })
  expect(callListEvaluations.input.parse({}).open).toBeUndefined()
  expect(callListEvaluations.input.safeParse({ open: 'yes' }).success).toBe(false)
  expect([5, 4, 3, 2, 1].map(scoreWords)).toEqual([
    'Handled well',
    'Mostly fine',
    'Missed something',
    'Went wrong',
    'Went wrong',
  ])
})
