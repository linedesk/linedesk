import { expect, test } from 'vitest'
import { actions, applyLocally, callFlagUrgent, callTakeMessage, phoneNumberSetup, rolePermissions, type LocalTables } from './index.ts'

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
