import type { Assistant } from '@linedesk/db/types'
import { expect, test } from 'vitest'
import { ringbackFrame } from './audio-bridge.ts'
import { parseTestMetadata } from './call-session.ts'
import { buildInstructions } from './prompt.ts'
import { mergeToolResults } from './summary.ts'
import { phoneRefused, scenarios } from './test-caller/scenarios.ts'
import { isPhoneCallTest } from './transfer-tool.ts'
import { NotAnsweredError, sipDialer } from './on-call-dialer.ts'
import { answerOf, answerOfDigit, briefingText, resultOf, transferLabel, transferNumberFor } from './transfer.ts'

const assistant = (over: Partial<Assistant> = {}) =>
  ({
    name: 'Maya',
    greeting: 'Hi.',
    business_profile: {},
    call_rules: null,
    transfer_urgent: true,
    transfer_number: '+15035550199',
    transfer_hours_only: false,
    ...over,
  }) as Assistant
const open = { openNow: true, summary: 'Open now.' }
const closed = { openNow: false, summary: 'Closed now.' }

test('transfer applies when it is on with a number; "only during business hours" blocks it while closed', () => {
  expect(transferNumberFor(assistant(), null)).toBe('+15035550199')
  expect(transferNumberFor(assistant({ transfer_urgent: false }), null)).toBeNull()
  expect(transferNumberFor(assistant({ transfer_number: null }), null)).toBeNull()
  expect(transferNumberFor(null, null)).toBeNull()
  const hoursOnly = assistant({ transfer_hours_only: true })
  expect(transferNumberFor(hoursOnly, open)).toBe('+15035550199')
  expect(transferNumberFor(hoursOnly, closed)).toBeNull()
  expect(transferNumberFor(hoursOnly, null)).toBe('+15035550199') // a workspace without hours is never "closed"
  expect(transferNumberFor(assistant(), closed)).toBe('+15035550199')
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
  expect(phoneRefused(scenarios['transfer-accepted'])).toBe(true)
  expect(phoneRefused(scenarios['burst-pipe'])).toBe(false)
})

test('what the call shows for each result', () => {
  expect(transferLabel('dialing', '+15035550199')).toBe('Transferring to +1 503 555 0199')
  expect(transferLabel('connected', '+15035550199')).toBe('Transferred to +1 503 555 0199')
  expect(transferLabel('not_answered', '+15035550199')).toBe('Transfer not answered')
  expect(transferLabel('declined', '+15035550199')).toBe('Transfer declined by +1 503 555 0199')
  expect(transferLabel('failed', '+15035550199')).toBe('Transfer to +1 503 555 0199 could not be placed')
})

test('the prompt offers transfer_call only when the assistant transfers on this call', () => {
  const withTransfer = buildInstructions(assistant(), null, null, true)
  expect(withTransfer).toContain('put an urgent caller through to the on-call person with transfer_call')
  expect(withTransfer).toContain('Never transfer a call that is not urgent')
  expect(withTransfer).not.toContain('You cannot book appointments, transfer calls')
  const without = buildInstructions(assistant(), null, null, false)
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
