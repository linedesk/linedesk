import { expect, test } from 'vitest'
import { actions, applyLocally, isRecordingKey, recordingKey, callFlagUrgent, callTakeMessage, phoneNumberSetup, rolePermissions, type LocalTables } from './index.ts'

test('assistant tools and phone setup are in the registry with the right permission', () => {
  expect(actions.get('call.takeMessage')?.permission).toBe('agent')
  expect(actions.get('call.flagUrgent')?.permission).toBe('agent')
  expect(actions.get('phoneNumber.setup')?.permission).toBe('settings:write')
  expect(rolePermissions.agent).toContain('agent')
  expect(rolePermissions.member).not.toContain('settings:write')
  expect(rolePermissions.member).not.toContain('agent')
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
  expect(phoneNumberSetup.input.safeParse({ areaCode: '503' }).success).toBe(true)
  expect(phoneNumberSetup.input.safeParse({}).success).toBe(false)
})

test('recordings: the agent only names the call, the key is derived, the setting is a boolean', () => {
  const setRecording = actions.get('call.setRecording')!
  expect(setRecording.permission).toBe('agent')
  expect(setRecording.patch).toBeUndefined()
  expect(setRecording.input.parse({ callId: 'call_1' })).toEqual({ callId: 'call_1', format: 'ogg' })
  expect(setRecording.input.parse({ callId: 'call_1', recordingKey: '../other/secret.txt' })).toEqual({ callId: 'call_1', format: 'ogg' })
  expect(setRecording.input.safeParse({ callId: 'call_1', format: 'exe' }).success).toBe(false)

  expect(recordingKey('ws_1', 'call_1')).toBe('ws_1/call_1.ogg')
  expect(isRecordingKey(recordingKey('NRopXAq2oDVg6xL3', 'call_61ba36e0'))).toBe(true)
  for (const key of ['../other-bucket/secret.txt', '/etc/passwd', 'ws_1/../ws_2/call.ogg', 'ws_1/call_1.txt', 'ws_1/a/call.ogg', 'call.ogg']) {
    expect(isRecordingKey(key)).toBe(false)
  }

  for (const role of ['owner', 'admin', 'member'] as const) expect(rolePermissions[role]).toContain('call:read')
  expect(rolePermissions.agent).not.toContain('call:read')

  const update = actions.get('assistant.update')!
  expect(update.input.safeParse({ assistantId: 'as_1', record_calls: false }).success).toBe(true)
  expect(update.input.safeParse({ assistantId: 'as_1', record_calls: 'no' }).success).toBe(false)
  expect(update.patch!.set({ assistantId: 'as_1', record_calls: false }, '')).toEqual({ record_calls: false })
})
