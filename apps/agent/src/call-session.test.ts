import { expect, test } from 'vitest'
import { callOrigin } from './call-session.ts'

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
