import { expect, test } from 'vitest'
import { actions, assistantUpdate, callTransfer, onCallNumberProblem } from './index.ts'

test('on-call numbers: US landlines and mobiles only', () => {
  for (const ok of ['+15035550199', '+12125550123', '+13125550123', '+14155552671'])
    expect(onCallNumberProblem(ok)).toBeNull()
  expect(onCallNumberProblem('5035550199')).toMatch(/area code/)
  expect(onCallNumberProblem('+445035550199')).toMatch(/area code/)
  expect(onCallNumberProblem('+10355550199')).toMatch(/area code/) // area codes start with 2-9
})

test('Canada, the Caribbean and US territories with their own region are refused', () => {
  for (const foreign of [
    '+16045550123',
    '+14165550123',
    '+18765550123',
    '+18095550123',
    '+12845550123',
    '+14735550123',
    '+16495550123',
    '+17875550123',
  ])
    expect(onCallNumberProblem(foreign)).toMatch(/Only US phone numbers/)
})

test('premium rate (900, 976 anywhere), personal, 700, toll-free and N11 numbers are refused', () => {
  expect(onCallNumberProblem('+19005550199')).toMatch(/Premium-rate/)
  expect(onCallNumberProblem('+19765550199')).toMatch(/Premium-rate/)
  expect(onCallNumberProblem('+12129765555')).toMatch(/Premium-rate/) // 976 behind a New York area code
  expect(onCallNumberProblem('+15005550199')).toMatch(/Premium-rate and personal/)
  expect(onCallNumberProblem('+17005550199')).toMatch(/Premium-rate and personal/)
  for (const tollFree of ['+18005550199', '+18885550199', '+18335550199'])
    expect(onCallNumberProblem(tollFree)).toMatch(/Toll-free/)
  expect(onCallNumberProblem('+14115550199')).toMatch(/Service numbers/)
  expect(onCallNumberProblem('+15039110199')).toMatch(/Service numbers/)
})

test('assistant.update takes the transfer settings and validates the number', () => {
  const base = { assistantId: 'as_1' }
  expect(
    assistantUpdate.input.safeParse({
      ...base,
      transfer_urgent: true,
      transfer_number: '+15035550199',
      transfer_hours_only: true,
    }).success,
  ).toBe(true)
  expect(assistantUpdate.input.safeParse({ ...base, transfer_number: null }).success).toBe(true)
  expect(assistantUpdate.input.safeParse({ ...base, transfer_number: '+19005550199' }).success).toBe(false)
  expect(assistantUpdate.input.safeParse({ ...base, transfer_number: '+18765550123' }).success).toBe(false)
  expect(assistantUpdate.input.safeParse({ ...base, transfer_number: '(503) 555-0199' }).success).toBe(false)
})

test('call.transfer: agent only, a server handler (the limits), dialing first', () => {
  expect(actions.get('call.transfer')?.permission).toBe('agent')
  expect(callTransfer.patch).toBeUndefined()
  expect(callTransfer.input.safeParse({ callId: 'call_1', to: '+15035550199', result: 'dialing' }).success).toBe(true)
  expect(callTransfer.input.safeParse({ callId: 'call_1', to: '+15035550199', result: 'maybe' }).success).toBe(false)
  expect(callTransfer.input.safeParse({ callId: 'call_1', to: '+19005550199', result: 'connected' }).success).toBe(
    false,
  )
})
