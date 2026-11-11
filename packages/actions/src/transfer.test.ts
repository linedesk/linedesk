import { expect, test } from 'vitest'
import {
  actions,
  assistantUpdate,
  callTransfer,
  isActiveContact,
  onCallNumberProblem,
  setsTransferNumber,
  TRANSFER_CONTACTS_MAX,
} from './index.ts'

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

const contact = (over: Record<string, unknown> = {}) => ({
  id: 'oncall',
  name: 'Mike',
  number: '+15035550199',
  condition: 'Urgent: a burst pipe',
  hours_only: true,
  ring_seconds: 25,
  if_no_answer: 'message_urgent',
  enabled: true,
  ...over,
})

test('assistant.update takes the list of transfer contacts and validates each number', () => {
  const update = (transfers: unknown) => assistantUpdate.input.safeParse({ assistantId: 'as_1', transfers }).success
  expect(update([contact(), contact({ id: 'person', name: 'Owner', number: null, if_no_answer: 'next' })])).toBe(true)
  expect(update([])).toBe(true)
  expect(update([contact({ number: '+19005550199' })])).toBe(false)
  expect(update([contact({ number: '+18765550123' })])).toBe(false)
  expect(update([contact({ number: '(503) 555-0199' })])).toBe(false)
  expect(update([contact({ condition: ' ' })])).toBe(false)
  expect(update([contact({ ring_seconds: 5 })])).toBe(false)
  expect(update([contact({ ring_seconds: 61 })])).toBe(false)
  expect(update([contact({ if_no_answer: 'hang_up' })])).toBe(false)
  // The assistant picks contacts by name: two of the same name (or id) are refused.
  expect(update([contact(), contact({ id: 'other', name: 'mike' })])).toBe(false)
  expect(update([contact(), contact({ name: 'Sarah' })])).toBe(false)
  expect(update(Array.from({ length: TRANSFER_CONTACTS_MAX + 1 }, (_, i) => contact({ id: `c${i}`, name: `C${i}` })))).toBe(false)
  // The old single on-call number is gone from the input.
  expect(Object.keys(assistantUpdate.input.shape)).not.toContain('transfer_number')
})

test('which assistant.update inputs let calls be put through to a number', () => {
  expect(setsTransferNumber({ transfers: [contact()] })).toBe(true)
  expect(setsTransferNumber({ transfers: [contact({ enabled: false })] })).toBe(false)
  expect(setsTransferNumber({ transfers: [contact({ number: null })] })).toBe(false)
  expect(setsTransferNumber({ transfers: [] })).toBe(false)
  expect(setsTransferNumber({ greeting: 'Hi' })).toBe(false)
  expect(setsTransferNumber(null)).toBe(false)
  expect(isActiveContact({ enabled: true, number: '+15035550199' })).toBe(true)
})

test('call.transfer: agent only, a server handler (the limits), dialing first', () => {
  expect(actions.get('call.transfer')?.permission).toBe('agent')
  expect(callTransfer.patch).toBeUndefined()
  expect(callTransfer.input.safeParse({ callId: 'call_1', to: '+15035550199', result: 'dialing' }).success).toBe(true)
  expect(callTransfer.input.safeParse({ callId: 'call_1', to: '+15035550199', result: 'maybe' }).success).toBe(false)
  expect(
    callTransfer.input.safeParse({ callId: 'call_1', to: '+15035550199', result: 'dialing', name: 'Office', urgent: false })
      .success,
  ).toBe(true)
  expect(callTransfer.input.safeParse({ callId: 'call_1', to: '+19005550199', result: 'connected' }).success).toBe(
    false,
  )
})
