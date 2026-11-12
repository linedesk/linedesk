import { expect, test } from 'vitest'
import { rejectionText } from './rejections.ts'

test('refusals read as sentences and never show action ids or server settings', () => {
  expect(rejectionText('call.markDone', 'call not found')).toBe('Could not mark the call done. Call not found.')
  expect(rejectionText('something.new', 'nope')).toBe('Could not do that. Nope.')
  const phone = rejectionText('phoneNumber.setup', 'phone setup is not configured: LIVEKIT_SIP_ENDPOINT is not set')
  expect(phone).not.toMatch(/LIVEKIT|phoneNumber/)
  expect(phone).toMatch(/aren't set up on this server/)
  // The limits on buying numbers through the install's account reach the user as they are written.
  for (const limit of [
    'A workspace can get 2 numbers through this server: ask whoever runs this server, or use your own carrier account.',
    'You bought 2 numbers today: try again tomorrow, or ask whoever runs this server, or use your own carrier account.',
    'Numbers on this server are bought by US area code: give an area code instead of a number.',
    'Numbers on this server are bought in the app, not with an API key.',
  ]) expect(rejectionText('phoneNumber.setup', limit)).toBe(limit)
})
