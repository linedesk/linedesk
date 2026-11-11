import { expect, test } from 'vitest'
import { callOrigin, startCall } from './call-session.ts'
import { buildInstructions } from './prompt.ts'

const sip = { 'sip.phoneNumber': '+15035550191', 'sip.trunkPhoneNumber': '+15035550142' }

test('a room dispatched by the web app is a test call in the workspace of its metadata', () => {
  const metadata = JSON.stringify({ source: 'test', workspaceId: 'ws_1' })
  expect(callOrigin(metadata, {}, 'test-abc')).toEqual({ kind: 'test', workspaceId: 'ws_1', room: 'test-abc' })
})

test('anything else is a phone call, numbered by LiveKit SIP', () => {
  expect(callOrigin('', sip, 'call-1')).toEqual({ kind: 'phone', from: '+15035550191', to: '+15035550142', room: 'call-1' })
  for (const metadata of ['not json', '{"source":"phone"}', '{"source":"test"}', '{"source":"test","workspaceId":""}', '{"source":"test","workspaceId":7}']) {
    expect(callOrigin(metadata, sip, 'call-1').kind).toBe('phone')
  }
})

test('a room that is neither is refused', () => {
  expect(() => callOrigin('', {}, 'room')).toThrow('participant has no sip.trunkPhoneNumber attribute')
})

test('a phone call without a caller ID is registered as anonymous, never under some number', () => {
  expect(callOrigin('', { 'sip.trunkPhoneNumber': '+15035550142' }, 'call-1')).toEqual({ kind: 'phone', from: 'anonymous', to: '+15035550142', room: 'call-1' })
  expect(callOrigin('', { ...sip, 'sip.phoneNumber': '' }, 'call-1')).toMatchObject({ from: 'anonymous' })
})

test('a test room may bring business hours to use instead of the workspace\'s; anything malformed is ignored', async () => {
  const closed = { openNow: false, summary: 'Closed now; opens tomorrow at 7 AM.' }
  const origin = callOrigin(JSON.stringify({ source: 'test', workspaceId: 'ws_1', businessHours: closed }), {}, 'room')
  expect(origin).toEqual({ kind: 'test', workspaceId: 'ws_1', room: 'room', businessHours: closed })
  expect(callOrigin(JSON.stringify({ source: 'test', workspaceId: 'ws_1', businessHours: { openNow: 'no' } }), {}, 'room')).toEqual({ kind: 'test', workspaceId: 'ws_1', room: 'room' })

  // The override wins over what call.startTest reports; without one, the API's hours are used.
  const api = (hours: unknown) => ({ run: async () => ({ data: { callId: 'c', workspaceId: 'ws_1', assistant: null, contact: {}, businessHours: hours } }) }) as never
  const fromApi = { openNow: true, summary: 'Open now, until 6 PM.' }
  expect((await startCall(api(fromApi), origin)).businessHours).toEqual(closed)
  expect((await startCall(api(fromApi), { kind: 'test', workspaceId: 'ws_1', room: 'room' })).businessHours).toEqual(fromApi)
  expect((await startCall(api(undefined), { kind: 'test', workspaceId: 'ws_1', room: 'room' })).businessHours).toBeNull()
})

test('a test room names the assistant picked in the web app, and call.startTest gets it', async () => {
  const origin = callOrigin(JSON.stringify({ source: 'test', workspaceId: 'ws_1', assistantId: 'as_2' }), {}, 'room')
  expect(origin).toEqual({ kind: 'test', workspaceId: 'ws_1', room: 'room', assistantId: 'as_2' })
  expect(callOrigin(JSON.stringify({ source: 'test', workspaceId: 'ws_1', assistantId: 7 }), {}, 'room')).toEqual({
    kind: 'test',
    workspaceId: 'ws_1',
    room: 'room',
  })
  const sent: unknown[] = []
  const api = {
    run: async (_def: unknown, input: unknown) => {
      sent.push(input)
      return { data: { callId: 'c', workspaceId: 'ws_1', assistant: null, contact: {} } }
    },
  } as never
  await startCall(api, origin)
  await startCall(api, { kind: 'test', workspaceId: 'ws_1', room: 'other' })
  expect(sent).toEqual([{ room: 'room', assistantId: 'as_2' }, { room: 'other' }])
})

test('outside business hours the call uses the outside greeting; the call test may set one', async () => {
  const closed = { openNow: false, summary: 'Closed now.' }
  const row = { id: 'as_1', greeting: 'Hello, this is Maya.', greeting_outside: 'We are closed.', business_profile: {} }
  const api = (hours: unknown) =>
    ({ run: async () => ({ data: { callId: 'c', workspaceId: 'ws_1', assistant: row, contact: {}, businessHours: hours } }) }) as never
  expect((await startCall(api(closed), { kind: 'test', workspaceId: 'ws_1', room: 'r' })).assistant?.greeting).toBe('We are closed.')
  expect((await startCall(api({ openNow: true, summary: 'Open.' }), { kind: 'test', workspaceId: 'ws_1', room: 'r' })).assistant?.greeting).toBe('Hello, this is Maya.')
  const origin = callOrigin(JSON.stringify({ source: 'test', workspaceId: 'ws_1', businessHours: closed, outsideGreeting: 'After-hours line.' }), {}, 'r')
  expect((await startCall(api(null), origin)).assistant?.greeting).toBe('After-hours line.')
})

test('the recording notice from call.start is said right after the greeting, also outside hours', async () => {
  const row = { id: 'as_1', greeting: 'Hello, this is Maya.', greeting_outside: 'We are closed.', business_profile: {} }
  const api = (recordingNotice: unknown, hours: unknown = null) =>
    ({ run: async () => ({ data: { callId: 'c', workspaceId: 'ws_1', assistant: row, contact: {}, businessHours: hours, recordingNotice } }) }) as never
  const phone = { kind: 'phone', from: '+15035550191', to: '+15035550142' } as const
  const notice = 'This call may be recorded.'
  expect((await startCall(api(notice), phone)).assistant?.greeting).toBe('Hello, this is Maya. This call may be recorded.')
  expect((await startCall(api(notice, { openNow: false, summary: 'Closed now.' }), phone)).assistant?.greeting).toBe(
    'We are closed. This call may be recorded.',
  )
  for (const off of [null, undefined, '  ']) expect((await startCall(api(off), phone)).assistant?.greeting).toBe(row.greeting)
})

test('the contact call.start matched reaches the instructions with its note; a withheld number brings none', async () => {
  const api = (contact: unknown) => ({ run: async () => ({ data: { callId: 'c', workspaceId: 'ws_1', assistant: null, contact } }) }) as never
  const phone = { kind: 'phone', from: '+15035550191', to: '+15035550142' } as const
  const known = await startCall(api({ id: 'ct_1', name: 'Dana Ortiz', note: 'Prefers mornings.' }), phone)
  expect(buildInstructions(known.assistant, known.businessHours, known.booking, false, known.contact)).toContain('<caller_notes>Prefers mornings.</caller_notes>')
  const withheld = await startCall(api(null), { ...phone, from: 'anonymous' })
  expect(buildInstructions(withheld.assistant, withheld.businessHours, withheld.booking, false, withheld.contact)).not.toContain('caller_notes')
})
