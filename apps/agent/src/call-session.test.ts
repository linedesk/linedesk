import { expect, test } from 'vitest'
import { callOrigin, startCall } from './call-session.ts'

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
  expect(() => callOrigin('', {}, 'room')).toThrow('participant has no sip.phoneNumber / sip.trunkPhoneNumber attributes')
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
