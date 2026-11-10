import { expect, test } from 'vitest'
import { rejectionText } from './rejections.ts'

test('refusals read as sentences and never show action ids or server settings', () => {
  expect(rejectionText('call.markDone', 'call not found')).toBe('Could not mark the call done. Call not found.')
  expect(rejectionText('something.new', 'nope')).toBe('Could not do that. Nope.')
  const phone = rejectionText('phoneNumber.setup', 'phone setup is not configured: LIVEKIT_SIP_ENDPOINT is not set')
  expect(phone).not.toMatch(/LIVEKIT|phoneNumber/)
  expect(phone).toMatch(/aren't set up on this server/)
})
