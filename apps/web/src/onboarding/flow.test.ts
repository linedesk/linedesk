import type { Call } from '@linedesk/db/types'
import { expect, test } from 'vitest'
import {
  carriers,
  firstTestCall,
  formatNumber,
  forwardingDigits,
  nextStep,
  phoneSetupInput,
  previousStep,
  progress,
  renameInGreeting,
  toE164,
} from './flow.ts'

test('steps run business → phone → test call → done, and back', () => {
  expect(nextStep('business')).toBe('phone')
  expect(nextStep('phone')).toBe('test_call')
  expect(nextStep('test_call')).toBe('done')
  expect(nextStep('done')).toBe('done')
  expect(previousStep('business')).toBeNull()
  expect(previousStep('done')).toBe('test_call')
  expect(progress('business', false)).toBe(0)
  expect(progress('phone', true)).toBe(50)
  expect(progress('done', true)).toBe(100)
})

test('US numbers are read the way people type them', () => {
  expect(toE164('(503) 555-0142')).toBe('+15035550142')
  expect(toE164('+1 503.555.0142')).toBe('+15035550142')
  expect(toE164('15035550142')).toBe('+15035550142')
  expect(toE164('555-0142')).toBeNull()
  expect(formatNumber('+15035550142')).toBe('+1 503 555 0142')
})

test('an existing number is attached and never bought', () => {
  expect(phoneSetupInput({ kind: 'existing', number: '(503) 555-0142' })).toEqual({
    input: { e164: '+15035550142', purchase: false },
  })
  expect(phoneSetupInput({ kind: 'existing', number: '0142' })).toHaveProperty('problem')
})

test('a new number is only requested with purchase after the user confirmed the cost', () => {
  expect(phoneSetupInput({ kind: 'new', areaCode: '503', confirmed: false })).toEqual({
    problem: 'Confirm the monthly cost first.',
  })
  expect(phoneSetupInput({ kind: 'new', areaCode: '50', confirmed: true })).toHaveProperty('problem')
  expect(phoneSetupInput({ kind: 'new', areaCode: '503', confirmed: true })).toEqual({
    input: { areaCode: '503', purchase: true, mode: 'new' },
  })
})

test('forwarding codes per carrier', () => {
  const digits = forwardingDigits('+15035550142')
  expect(digits).toBe('5035550142')
  expect(carriers.map(c => [c.name, c.on(digits), c.off])).toEqual([
    ['Verizon', '*715035550142', '*73'],
    ['AT&T', '**004*5035550142#', '##004#'],
    ['T-Mobile', '**004*5035550142#', '##004#'],
  ])
})

const call = (id: string, to: string, started_at: string, deleted_at: string | null = null) =>
  ({ id, to_number: to, started_at, deleted_at }) as Call

test('the test call is the first new call to one of our numbers', () => {
  const since = '2026-11-10T15:00:00.000Z'
  const calls = [
    call('old', '+15035550142', '2026-11-10T14:00:00.000Z'),
    call('other', '+15035550199', '2026-11-10T15:01:00.000Z'),
    call('deleted', '+15035550142', '2026-11-10T15:01:00.000Z', '2026-11-10T15:02:00.000Z'),
    call('second', '+15035550142', '2026-11-10T15:03:00.000Z'),
    call('first', '+15035550142', '2026-11-10T15:02:00.000Z'),
  ]
  expect(firstTestCall(calls, ['+15035550142'], since)?.id).toBe('first')
  expect(firstTestCall(calls.slice(0, 3), ['+15035550142'], since)).toBeUndefined()
})

test('renaming the assistant keeps the greeting in step', () => {
  expect(renameInGreeting('Thanks for calling Brightwater. This is Maya, the AI assistant.', 'Maya', 'Ava')).toBe(
    'Thanks for calling Brightwater. This is Ava, the AI assistant.',
  )
  expect(renameInGreeting('Hi, Mayan Plumbing here.', 'Maya', 'Ava')).toBe('Hi, Mayan Plumbing here.')
  expect(renameInGreeting('Hello', 'Maya', 'Maya')).toBe('Hello')
})
