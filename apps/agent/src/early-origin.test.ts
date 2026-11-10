import { expect, test } from 'vitest'
import { earlyOrigin } from './early-origin.ts'

const sip = { 'sip.phoneNumber': '+15035550191', 'sip.trunkPhoneNumber': '+15035550142' }
const list = (...attributes: Record<string, string>[]) => async () => attributes.map(a => ({ attributes: a }))

test('a phone call is known from the SIP participant already in the room', async () => {
  expect(await earlyOrigin('', 'call-1', list(sip))).toEqual({ kind: 'phone', from: '+15035550191', to: '+15035550142', room: 'call-1' })
})

test('a test call is known from its metadata, without asking LiveKit', async () => {
  const never = async () => { throw new Error('not asked') }
  expect(await earlyOrigin(JSON.stringify({ source: 'test', workspaceId: 'ws_1' }), 'room', never)).toEqual({ kind: 'test', workspaceId: 'ws_1', room: 'room' })
})

test('no caller yet, more than one, or no room: left to the normal path', async () => {
  expect(await earlyOrigin('', 'call-1', list())).toBeNull()
  expect(await earlyOrigin('', 'call-1', list({}))).toBeNull()
  expect(await earlyOrigin('', 'call-1', list(sip, sip))).toBeNull()
  expect(await earlyOrigin('', '', list(sip))).toBeNull()
})
