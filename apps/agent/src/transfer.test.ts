import type { Assistant } from '@linedesk/db/types'
import { expect, test, vi } from 'vitest'
import { ringbackFrame } from './audio-bridge.ts'
import { parseTestMetadata } from './call-session.ts'
import { buildInstructions } from './prompt.ts'
import { mergeToolResults } from './summary.ts'
import { phoneRefused, scenarios } from './test-caller/scenarios.ts'
import { isPhoneCallTest, liveTransferTestAllows, onCallDialerFor } from './transfer-tool.ts'
import { simulatedContact } from './call-session.ts'
import { maskedNumber, parseOnCallResponderMetadata } from './oncall-responder.ts'
import { parseSetupOnCallTestArgs, parseSetupSipArgs } from './setup-args.ts'
import { NotAnsweredError, sipDialer } from './on-call-dialer.ts'
import type { TransferContact } from '@linedesk/db/types'
import {
  answerOf,
  answerOfDigit,
  briefingText,
  type Dialable,
  MAX_TRANSFER_TRIES,
  notConnectedReply,
  resultOf,
  transferContactsFor,
  transferLabel,
  transferPlan,
} from './transfer.ts'
import { transferToolDescription } from './transfer-tool.ts'

const contact = (over: Partial<TransferContact> = {}): TransferContact => ({
  id: 'oncall',
  name: 'Mike',
  number: '+15035550199',
  condition: 'Urgent: a burst pipe, a gas smell, no heat',
  hours_only: false,
  ring_seconds: 25,
  if_no_answer: 'message_urgent',
  enabled: true,
  ...over,
})
const office = contact({ id: 'office', name: 'Office', number: '+15035550187', condition: 'Billing questions', if_no_answer: 'message', hours_only: true })
const person = contact({ id: 'person', name: 'Owner', number: null, condition: 'The caller asks to speak to a person', if_no_answer: 'message' })
const assistant = (over: Partial<Assistant> = {}) =>
  ({
    name: 'Maya',
    greeting: 'Hi.',
    business_profile: {},
    call_rules: null,
    transfers: [contact(), office, person],
    ...over,
  }) as Assistant
const open = { openNow: true, summary: 'Open now.' }
const closed = { openNow: false, summary: 'Closed now.' }
const ids = (list: { id: string }[]) => list.map(c => c.id)

test('transfer contacts: switched on with a number; "only during business hours" drops them while closed', () => {
  expect(ids(transferContactsFor(assistant(), open))).toEqual(['oncall', 'office']) // Owner has no number yet
  expect(ids(transferContactsFor(assistant(), closed))).toEqual(['oncall'])
  expect(ids(transferContactsFor(assistant(), null))).toEqual(['oncall', 'office']) // no hours: never "closed"
  expect(ids(transferContactsFor(assistant({ transfers: [contact({ enabled: false })] }), open))).toEqual([])
  expect(transferContactsFor(assistant({ transfers: [] }), open)).toEqual([])
  expect(transferContactsFor(null, null)).toEqual([])
})

test('the plan tries the contacts that fit in the owner\'s order, whatever order the assistant named them in', () => {
  const sarah = contact({ id: 'sarah', name: 'Sarah', number: '+15035550111' })
  const mikeNext = contact({ if_no_answer: 'next' })
  const list = transferContactsFor(assistant({ transfers: [mikeNext, office, sarah] }), open)
  // Mike hands over to the next one that fits (Sarah, not the office: billing does not fit).
  expect(transferPlan(list, ['Sarah', 'mike'])).toMatchObject({ tries: [{ id: 'oncall' }, { id: 'sarah' }], fallback: 'message_urgent' })
  // Only the office fits: one try, and a plain message when nobody accepts.
  expect(transferPlan(list, ['Office'])).toMatchObject({ tries: [{ id: 'office' }], fallback: 'message' })
  // Mike's fallback is a message: Sarah is not tried even though she fits.
  const plain = transferContactsFor(assistant({ transfers: [contact(), sarah] }), open)
  expect(ids(transferPlan(plain, ['Mike', 'Sarah'])!.tries)).toEqual(['oncall'])
  // "Try the next" with nobody left: a message marked urgent.
  expect(transferPlan(list, ['Mike'])).toMatchObject({ tries: [{ id: 'oncall' }], fallback: 'message_urgent' })
  // A name that is no contact (or a contact not reachable now): no transfer.
  expect(transferPlan(list, ['Owner'])).toBeNull()
})

test('the plan stops after a few tries, so the caller is not on hold for minutes', () => {
  const chain = Array.from({ length: 5 }, (_, i) =>
    contact({ id: `c${i}`, name: `C${i}`, number: `+1503555010${i}`, if_no_answer: 'next' }),
  )
  const plan = transferPlan(chain as Dialable[], chain.map(c => c.name))!
  expect(plan.tries).toHaveLength(MAX_TRANSFER_TRIES)
  expect(plan.fallback).toBe('message_urgent')
})

test('the assistant hears what to tell the caller when nobody accepts', () => {
  expect(notConnectedReply('message_urgent')).toMatch(/flagged as urgent/)
  expect(notConnectedReply('message')).not.toMatch(/urgent/)
})

test('the tool names every contact with its condition', () => {
  const description = transferToolDescription([contact(), office])
  expect(description).toContain('"Mike": Urgent: a burst pipe, a gas smell, no heat')
  expect(description).toContain('"Office": Billing questions')
})

test('the call test\'s simulated on-call person is one urgent contact', () => {
  const sim = simulatedContact('+15035550199')
  expect(transferContactsFor(assistant({ transfers: [sim] }), closed)).toEqual([sim])
  expect(transferPlan([sim as never], ['Mike'])?.fallback).toBe('message_urgent')
})

test('the briefing names the caller (or reads the number) and what it is about, and says how to answer', () => {
  expect(
    briefingText({ callerName: 'Dana Ruiz', callerNumber: '+15035550142', about: 'a burst pipe in the kitchen.' }),
  ).toBe(
    'Urgent call from Dana Ruiz about a burst pipe in the kitchen. Press 1 or say yes to take it, or press 2 or say no.',
  )
  expect(briefingText({ callerName: ' ', callerNumber: '+15035550142', about: 'no heat' })).toMatch(
    /^Urgent call from 503 555 0142 about no heat\./,
  )
  expect(briefingText({ callerNumber: 'test', about: '' })).toMatch(/^Urgent call from a caller\. Press 1/)
  expect(briefingText({ callerName: 'Dana', about: 'a bill', urgent: false })).toMatch(/^Call from Dana about a bill\./)
})

test('the on-call person answers by voice or key; unclear answers are no decision', () => {
  for (const yes of ['Yes', 'yeah sure', 'Okay, put them through', "I'll take it", 'No problem, go ahead'])
    expect(answerOf(yes)).toBe('yes')
  for (const no of ['No', "Sorry, I can't right now", 'not now, busy', 'nope']) expect(answerOf(no)).toBe('no')
  for (const unclear of ['Hello?', 'Who is this?', "Yes, but I can't", 'I know']) expect(answerOf(unclear)).toBeNull()
  // A voicemail greeting or a long sentence is no decision, even with a yes-word in it.
  for (const machine of [
    "Hi, you've reached Mike. Sure, leave a message after the tone.",
    'The person you are calling is not available.',
    'Yeah so I was just about to head out to the other job across town',
    'Please record your message',
  ])
    expect(answerOf(machine)).toBeNull()
  expect(answerOfDigit('1')).toBe('yes')
  expect(answerOfDigit('2')).toBe('no')
  expect(answerOfDigit('5')).toBeNull()
  expect([resultOf('yes'), resultOf('no'), resultOf(null)]).toEqual(['connected', 'declined', 'not_answered'])
})

test('a phone call test never transfers; transfer scenarios refuse --phone', () => {
  const env = { CALL_TEST_FROM: '+15035550192' }
  expect(isPhoneCallTest({ contact: { phone: '+15035550192' } as never }, env)).toBe(true)
  expect(isPhoneCallTest({ contact: { phone: '+15035550142' } as never }, env)).toBe(false)
  expect(isPhoneCallTest({ contact: { phone: '+15035550192' } as never }, {})).toBe(false)
  expect(phoneRefused(scenarios['transfer-accepted'], {})).toBe(true)
  expect(phoneRefused(scenarios['burst-pipe'], {})).toBe(false)
})

test('live transfer test: with CALL_TEST_ONCALL a phone call test goes through to that number only', async () => {
  const oncall = '+19715550123'
  expect(liveTransferTestAllows(oncall, { CALL_TEST_ONCALL: oncall })).toBe(true)
  expect(liveTransferTestAllows('+15035550199', { CALL_TEST_ONCALL: oncall })).toBe(false)
  expect(liveTransferTestAllows(oncall, {})).toBe(false)
  expect(liveTransferTestAllows('', { CALL_TEST_ONCALL: '' })).toBe(false)
  expect(phoneRefused(scenarios['transfer-accepted'], { CALL_TEST_ONCALL: oncall })).toBe(false)

  // The dialer: a phone call test to any other number still gets none (nothing is dialled), with or without the opt-in.
  const phoneTest = {
    callId: 'c1',
    businessNumber: '+15035550194',
    simulatedOnCall: null,
    documents: null,
    contact: { phone: '+15035550192' },
  } as never
  vi.stubEnv('CALL_TEST_FROM', '+15035550192')
  try {
    expect(await onCallDialerFor(phoneTest, '+15035550199', {} as never, {} as never)).toBeNull()
    vi.stubEnv('CALL_TEST_ONCALL', oncall)
    expect(await onCallDialerFor(phoneTest, '+15035550199', {} as never, {} as never)).toBeNull()
    // The business's own number is never dialled: it would ring back into the assistant.
    vi.stubEnv('CALL_TEST_ONCALL', '+15035550194')
    expect(await onCallDialerFor(phoneTest, '+15035550194', {} as never, {} as never)).toBeNull()
  } finally {
    vi.unstubAllEnvs()
  }
})

test('the on-call responder is chosen only by its own metadata', () => {
  expect(parseOnCallResponderMetadata('{"source":"oncall-responder","answer":"accept"}')).toEqual({
    source: 'oncall-responder',
    answer: 'accept',
  })
  expect(parseOnCallResponderMetadata('{"source":"oncall-responder","answer":"hang-up"}')).toBeNull()
  expect(parseOnCallResponderMetadata('{"source":"test","workspaceId":"w"}')).toBeNull()
  expect(parseOnCallResponderMetadata('')).toBeNull()
})

test('setup-sip refuses unknown options and a missing number instead of using a default', () => {
  expect(parseSetupSipArgs(['--outbound', '+15035550194', '+19715550123'])).toEqual({
    printAllowedAddresses: false,
    outbound: true,
    numbers: ['+15035550194', '+19715550123'],
  })
  expect(parseSetupSipArgs(['--print-allowed-addresses'])).toEqual({ printAllowedAddresses: true })
  expect(() => parseSetupSipArgs([])).toThrow(/No number given[\s\S]*usage: setup-sip/)
  expect(() => parseSetupSipArgs(['--outbound'])).toThrow(/No number given/)
  expect(() => parseSetupSipArgs(['--help'])).toThrow(/Unknown option: --help/)
  expect(() => parseSetupSipArgs(['--outbond', '+15035550194'])).toThrow(/Unknown option: --outbond/)
  expect(() => parseSetupSipArgs(['5035550194'])).toThrow(/E\.164/)
})

test('setup-oncall-test takes one number and what the responder answers', () => {
  expect(parseSetupOnCallTestArgs(['+19715550123'])).toEqual({ remove: false, number: '+19715550123', answer: 'accept' })
  expect(parseSetupOnCallTestArgs(['--answer', 'no-answer', '+19715550123'])).toEqual({
    remove: false,
    number: '+19715550123',
    answer: 'no-answer',
  })
  expect(() => parseSetupOnCallTestArgs([])).toThrow(/No number given/)
  expect(() => parseSetupOnCallTestArgs(['+19715550123', '--answer', 'maybe'])).toThrow(/--answer takes/)
  expect(() => parseSetupOnCallTestArgs(['+19715550123', '+15035550194'])).toThrow(/one test on-call number/)
  expect(() => parseSetupOnCallTestArgs(['+19715550123', '--force'])).toThrow(/Unknown option/)
  expect(parseSetupOnCallTestArgs(['--remove'])).toEqual({ remove: true })
  expect(() => parseSetupOnCallTestArgs(['--remove', '+19715550123'])).toThrow(/--remove takes nothing else/)
})

test('the responder logs only the last four digits of who called', () => {
  expect(maskedNumber('+15035550194')).toBe('…4064')
  expect(maskedNumber(undefined)).toBe('an unknown number')
})

test('what the call shows for each result', () => {
  expect(transferLabel('dialing', '+15035550199')).toBe('Transferring to +1 503 555 0199')
  expect(transferLabel('connected', '+15035550199')).toBe('Transferred to +1 503 555 0199')
  expect(transferLabel('not_answered', '+15035550199')).toBe('Transfer not answered')
  expect(transferLabel('declined', '+15035550199')).toBe('Transfer declined by +1 503 555 0199')
  expect(transferLabel('failed', '+15035550199')).toBe('Transfer to +1 503 555 0199 could not be placed')
  expect(transferLabel('connected', '+15035550199', 'Mike')).toBe('Transferred to Mike (+1 503 555 0199)')
})

test('the prompt offers transfer_call only when the assistant transfers on this call, with each contact\'s condition', () => {
  const withTransfer = buildInstructions(assistant(), null, null, [contact(), office])
  expect(withTransfer).toContain('put the caller through to a person with transfer_call')
  expect(withTransfer).toContain('1. Mike: Urgent: a burst pipe, a gas smell, no heat.\n2. Office: Billing questions.')
  expect(withTransfer).toContain('Never transfer a call that fits no contact')
  expect(withTransfer).not.toContain('You cannot book appointments, transfer calls')
  const without = buildInstructions(assistant(), null, null, [])
  expect(without).toContain('You cannot book appointments, transfer calls')
  expect(without).not.toContain('transfer_call')
})

test('a connected transfer makes the call transferred, whatever the summary says', () => {
  const summary = {
    outcome: 'message' as const,
    urgency: 'normal' as const,
    title: 'Burst pipe',
    summary: 'Put through.',
  }
  expect(mergeToolResults(summary, { messages: [], urgent: true, transferred: true })).toMatchObject({
    outcome: 'transferred',
    urgency: 'urgent',
  })
  expect(mergeToolResults(summary, { messages: ['Call Dana back'], urgent: true, transferred: false })).toMatchObject({
    outcome: 'message',
    urgency: 'urgent',
  })
})

test('a test room can bring a simulated on-call person; anything malformed is ignored', () => {
  const meta = (onCall: unknown) => JSON.stringify({ source: 'test', workspaceId: 'ws_1', onCall })
  expect(parseTestMetadata(meta({ answer: 'accept', number: '+15035550199' }))?.onCall).toEqual({
    answer: 'accept',
    number: '+15035550199',
  })
  expect(parseTestMetadata(meta({ answer: 'maybe', number: '+15035550199' }))?.onCall).toBeUndefined()
  expect(parseTestMetadata(meta({ answer: 'accept', number: 'call me' }))?.onCall).toBeUndefined()
  expect(parseTestMetadata(meta(undefined))?.onCall).toBeUndefined()
})

test('ringback: 440 + 480 Hz for two seconds, then four seconds of silence', () => {
  expect(ringbackFrame(0).some(s => s !== 0)).toBe(true)
  expect(ringbackFrame(99).some(s => s !== 0)).toBe(true) // 1.98 s
  expect(ringbackFrame(100).every(s => s === 0)).toBe(true) // 2.0 s
  expect(ringbackFrame(299).every(s => s === 0)).toBe(true)
  expect(ringbackFrame(300).some(s => s !== 0)).toBe(true) // 6 s: the next ring
  expect(Math.max(...ringbackFrame(10))).toBeLessThan(32767 * 0.2)
})

test('the SIP dial gives up as soon as the caller hangs up, not when the phone stops ringing', async () => {
  const sip = { createSipParticipant: () => new Promise(() => {}) } as never
  const controller = new AbortController()
  const dialling = sipDialer({ sip, trunkId: 'ST_1', to: '+15035550199' }).dial({
    room: 'r-oncall',
    identity: 'on-call',
    signal: controller.signal,
  })
  controller.abort()
  await expect(dialling).rejects.toBeInstanceOf(NotAnsweredError)
  const already = new AbortController()
  already.abort()
  await expect(
    sipDialer({ sip, trunkId: 'ST_1', to: '+15035550199' }).dial({
      room: 'r',
      identity: 'on-call',
      signal: already.signal,
    }),
  ).rejects.toThrow('cancelled before dialling')
})
