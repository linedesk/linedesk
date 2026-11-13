import type { Assistant } from '@linedesk/db/types'
import { expect, test, vi } from 'vitest'
import { ringbackFrame } from './audio-bridge.ts'
import { parseTestMetadata } from './call-session.ts'
import { buildInstructions } from './prompt.ts'
import { mergeToolResults } from './summary.ts'
import { phoneRefused, type Scenario, scenarios } from './test-caller/scenarios.ts'
import { isPhoneCallTest, liveTransferTestAllows, onCallDialerFor } from './transfer-tool.ts'
import { simulatedContact, simulatedContacts } from './call-session.ts'
import { maskedNumber, parseOnCallResponderMetadata } from './oncall-responder.ts'
import { parseSetupOnCallTestArgs, parseSetupSipArgs } from './setup-args.ts'
import { NotAnsweredError, sipDialer } from './on-call-dialer.ts'
import type { TransferContact } from '@linedesk/db/types'
import {
  answerOf,
  answerOfDigit,
  briefingText,
  connectingLine,
  type Dialable,
  MAX_TRANSFER_TRIES,
  notConnectedMessage,
  transferCallerName,
  notConnectedReply,
  resultOf,
  transferContactsFor,
  transferLabel,
  transferPlan,
} from './transfer.ts'
import { transferTool, transferToolDescription } from './transfer-tool.ts'
import { CallLog } from './call-log.ts'

const contact = (over: Partial<TransferContact> = {}): TransferContact => ({
  id: 'oncall',
  name: 'Mike',
  number: '+15035550199',
  condition: 'Urgent: a burst pipe, a gas smell, no heat',
  hours_only: false,
  ring_seconds: 25,
  if_no_answer: 'message',
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
  expect(transferPlan(list, ['Sarah', 'mike'])).toMatchObject({ tries: [{ id: 'oncall' }, { id: 'sarah' }] })
  // Only the office fits: one try.
  expect(transferPlan(list, ['Office'])).toMatchObject({ tries: [{ id: 'office' }] })
  // Mike's fallback is a message: Sarah is not tried even though she fits.
  const plain = transferContactsFor(assistant({ transfers: [contact(), sarah] }), open)
  expect(ids(transferPlan(plain, ['Mike', 'Sarah'])!.tries)).toEqual(['oncall'])
  // Sarah has Mike's condition: she fits too, even when only Mike is named (the model often names one).
  expect(ids(transferPlan(list, ['Mike'])!.tries)).toEqual(['oncall', 'sarah'])
  expect(ids(transferPlan(list, ['sarah'])!.tries)).toEqual(['oncall', 'sarah']) // the owner's order, from the first that fits
  // "Try the next" with nobody left: one try (then a message).
  const alone = transferContactsFor(assistant({ transfers: [mikeNext, office] }), open)
  expect(transferPlan(alone, ['Mike'])).toMatchObject({ tries: [{ id: 'oncall' }] })
  // The same condition written differently (case, spaces, a full stop) is the same condition.
  const backup = contact({ id: 'backup', name: 'Backup', number: '+15035550122', condition: ' urgent:  a burst pipe, a gas smell, no heat. ' })
  expect(ids(transferPlan(transferContactsFor(assistant({ transfers: [mikeNext, backup] }), open), ['Mike'])!.tries)).toEqual(['oncall', 'backup'])
  // A name that is no contact (or a contact not reachable now): no transfer.
  expect(transferPlan(list, ['Owner'])).toBeNull()
})

test('the plan stops after a few tries, so the caller is not on hold for minutes', () => {
  const chain = Array.from({ length: 5 }, (_, i) =>
    contact({ id: `c${i}`, name: `C${i}`, number: `+1503555010${i}`, if_no_answer: 'next' }),
  )
  const plan = transferPlan(chain as Dialable[], chain.map(c => c.name))!
  expect(plan.tries).toHaveLength(MAX_TRANSFER_TRIES)
})

test('the assistant hears what to tell the caller when nobody accepts: a message, never urgent', () => {
  expect(notConnectedReply()).not.toMatch(/urgent/)
  expect(notConnectedReply()).toMatch(/saved already/)
  // After a failed transfer nothing is on its way: the assistant is told so.
  expect(notConnectedReply()).toMatch(/nobody is on the way/)
})

test('when nobody took the call the team gets a message naming who was tried and why', () => {
  expect(notConnectedMessage({ callerName: 'Dana Ruiz', nameConfirmed: true, about: 'a burst pipe.', tried: ['On-call', 'Backup'] })).toBe(
    'Dana Ruiz wanted to be put through to On-call, then Backup about a burst pipe; nobody took the call. Call them back.',
  )
  expect(notConnectedMessage({ callerName: ' ', about: '', tried: ['Mike'] })).toBe('The caller wanted to be put through to Mike; nobody took the call. Call them back.')
  // A name the team did not give or confirm is only who the caller says they are.
  expect(notConnectedMessage({ callerName: 'Dana Ruiz', about: 'a burst pipe', tried: ['Mike'] })).toBe(
    'A caller who says they are Dana Ruiz wanted to be put through to Mike about a burst pipe; nobody took the call. Call them back.',
  )
})

test("only the contact's name the team gave or confirmed counts as confirmed; any name the caller gives is what they say", () => {
  const member = { name: 'Dana Ruiz', nameConfirmed: true }
  expect(transferCallerName(null, member)).toEqual({ name: 'Dana Ruiz', confirmed: true })
  expect(transferCallerName('dana ruiz', member)).toEqual({ name: 'dana ruiz', confirmed: true })
  expect(transferCallerName('Sam Lee', member)).toEqual({ name: 'Sam Lee', confirmed: false })
  expect(transferCallerName(null, { name: 'Dana Ruiz', nameConfirmed: false })).toEqual({ name: 'Dana Ruiz', confirmed: false })
  expect(transferCallerName('Dana Ruiz', null)).toEqual({ name: 'Dana Ruiz', confirmed: false })
  expect(transferCallerName(null, null)).toEqual({ name: null, confirmed: false })
})

test('the tool names every contact with its condition', () => {
  const description = transferToolDescription([contact(), office])
  expect(description).toContain('"Mike": Urgent: a burst pipe, a gas smell, no heat')
  expect(description).toContain('"Office": Billing questions')
})

test('the call test\'s simulated on-call person is one contact for urgent calls', () => {
  const sim = simulatedContact('+15035550199')
  expect(transferContactsFor(assistant({ transfers: [sim] }), closed)).toEqual([sim])
  expect(transferPlan([sim as never], ['Mike'])?.tries).toEqual([sim])
})

test('the briefing names the caller (or reads the number) and what it is about, and says how to answer', () => {
  expect(
    briefingText({ callerName: 'Dana Ruiz', nameConfirmed: true, callerNumber: '+15035550142', about: 'a burst pipe in the kitchen.' }),
  ).toBe(
    'Call from Dana Ruiz about a burst pipe in the kitchen. Press 1 or say yes to take it, or press 2 or say no.',
  )
  // A name the team did not confirm: the number, and who the caller says they are.
  expect(briefingText({ callerName: 'Dana Ruiz', callerNumber: '+15035550142', about: 'no heat' })).toBe(
    'Call from 503 555 0142, who says they are Dana Ruiz, about no heat. Press 1 or say yes to take it, or press 2 or say no.',
  )
  expect(briefingText({ callerName: 'Dana Ruiz', callerNumber: 'test', about: '' })).toMatch(/^Call from a caller, who says they are Dana Ruiz\. Press 1/)
  expect(briefingText({ callerName: ' ', callerNumber: '+15035550142', about: 'no heat' })).toMatch(
    /^Call from 503 555 0142 about no heat\./,
  )
  expect(briefingText({ callerNumber: 'test', about: '' })).toMatch(/^Call from a caller\. Press 1/)
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
    timeZone: null,
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
  // For callers who ask for a person: the default "asks for a person" contact, never hours-only in the test.
  const person = parseTestMetadata(meta({ answer: 'accept', number: '+15035550199', for: 'person' }))?.onCall
  expect(person).toEqual({ answer: 'accept', number: '+15035550199', for: 'person' })
  expect(simulatedContact(person!.number, person!.for)).toMatchObject({ condition: 'The caller asks to speak to a person', if_no_answer: 'message', hours_only: false, number: '+15035550199' })
  // A backup: two urgent contacts with the same condition, the first tries the next; the plan walks both.
  const backup = parseTestMetadata(meta({ answer: 'no-answer', number: '+15035550199', backup: true }))?.onCall
  expect(backup).toEqual({ answer: 'no-answer', number: '+15035550199', backup: true })
  const contacts = simulatedContacts(backup!)
  expect(contacts.map(c => [c.name, c.if_no_answer])).toEqual([['Mike', 'next'], ['Sarah', 'message']])
  expect(transferPlan(contacts as Dialable[], ['Mike'])!.tries.map(c => c.name)).toEqual(['Mike', 'Sarah'])
  expect(parseTestMetadata(meta({ answer: 'accept', number: '+15035550199', backup: 'yes' }))?.onCall).not.toHaveProperty('backup')
})

test('a test room can allow other languages; unknown codes are dropped', () => {
  const meta = (languages: unknown) => JSON.stringify({ source: 'test', workspaceId: 'ws_1', languages })
  expect(parseTestMetadata(meta(['es', 'xx']))?.languages).toEqual(['es'])
  expect(parseTestMetadata(meta(['xx']))?.languages).toBeUndefined()
  expect(parseTestMetadata(meta('es'))?.languages).toBeUndefined()
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

test('a test call from the web app asks for a simulated transfer; only `true` counts', () => {
  const meta = (value: unknown) => JSON.stringify({ source: 'test', workspaceId: 'w', simulateTransfer: value })
  expect(parseTestMetadata(meta(true))?.simulateTransfer).toBe(true)
  expect(parseTestMetadata(meta('yes'))?.simulateTransfer).toBeUndefined()
  expect(parseTestMetadata(JSON.stringify({ source: 'test', workspaceId: 'w' }))?.simulateTransfer).toBeUndefined()
})

test('the caller hears that the assistant is trying to reach the contact', () => {
  expect(connectingLine('Mike')).toBe("I'm trying to reach Mike now. Please stay on the line.")
  expect(transferToolDescription([contact()])).toContain('It tells the caller itself that you are trying to reach them')
})

/** transfer_call run outside a live session: the caller is on hold, nothing is said, every API request is kept. */
function runTransfer(contacts: Dialable[], dialable: (c: Dialable) => boolean) {
  const requests: { name: string; input: Record<string, unknown> }[] = []
  const call = { callId: 'c1', workspaceId: 'w', contact: { phone: '+15035550142', name: null }, assistant: null, append: async () => {} } as never
  const log = new CallLog(call)
  const dialed: string[] = []
  const tool = transferTool({
    ctx: { room: { on() {}, off() {} } } as never,
    api: {
      run: async (def: { name: string }, input: Record<string, unknown>) => {
        requests.push({ name: def.name, input })
        return { data: {} }
      },
    } as never,
    call,
    log,
    speech: {} as never,
    callerIdentity: Promise.resolve('caller'),
    contacts,
    dialerOf: async c => {
      dialed.push(c.name)
      return dialable(c) ? ({ dial: async () => {} } as never) : null
    },
  })
  const session = { input: { setAudioEnabled() {} }, output: { setAudioEnabled() {} } }
  const run = { waitForPlayout: async () => {}, disallowInterruptions() {}, session }
  const execute = (picked: string[]) =>
    (tool as unknown as { execute: (args: unknown, opts: unknown) => Promise<string | undefined> }).execute({ contacts: picked, caller_name: 'Dana', about: 'a burst pipe' }, { ctx: run })
  return { execute, requests, dialed, log }
}

test('a contact that cannot be dialled counts as not answered: the next one only when its setting says so', async () => {
  const first = { ...contact({ if_no_answer: 'next' }), number: '+15035550199' }
  const backup = { ...contact({ id: 'backup', name: 'Sarah', number: '+15035550188' }), number: '+15035550188' }
  const { execute, requests, dialed, log } = runTransfer([first, backup], () => false)
  expect(await execute(['Mike'])).toBe(notConnectedReply())
  expect(dialed).toEqual(['Mike', 'Sarah'])
  // Nothing was started at the API (no `dialing`): both are recorded as failed, and the team gets the message.
  expect(requests.filter(r => r.name === 'call.transfer').map(r => r.input.result)).toEqual(['failed', 'failed'])
  expect(requests.some(r => r.name === 'call.takeMessage')).toBe(true)
  // A transfer never makes the call urgent.
  expect(log.urgent).toBe(false)
  expect(requests.every(r => !('urgent' in r.input))).toBe(true)

  // "If nobody accepts: take a message": the backup with the same condition is not tried.
  const only = runTransfer([{ ...first, if_no_answer: 'message' }, backup], () => false)
  expect(await only.execute(['Mike'])).toBe(notConnectedReply())
  expect(only.dialed).toEqual(['Mike'])
})

test('--external refuses every transfer scenario, even with CALL_TEST_ONCALL set', () => {
  const transferScenarios = Object.entries<Scenario>(scenarios).filter(([name, s]) => name.startsWith('transfer-') || s.onCall)
  expect(transferScenarios.length).toBeGreaterThan(0)
  for (const [name, scenario] of transferScenarios) {
    expect(scenario.onCall, name).toBeDefined()
    expect(phoneRefused(scenario, { CALL_TEST_ONCALL: '+19715550123' }, true), name).toBe(true)
  }
  expect(phoneRefused(scenarios['burst-pipe'], {}, true)).toBe(false)
})
