import { expect, test } from 'vitest'
import { callerIdOf, phoneNumbersIn, phoneStepRefusal, withCallbackNumber } from './callback-number.ts'

const callerId = '+15035550142'
const none = { confirmed: [], saved: [] }

test('caller ID is a number from the contact the call matched; withheld or anonymous is none', () => {
  expect(callerIdOf({ contact: { phone: callerId } })).toBe(callerId)
  expect(callerIdOf({ contact: { phone: 'anonymous' } })).toBeNull()
  expect(callerIdOf({ contact: null })).toBeNull()
})

test('whole phone numbers are found in a message; a ZIP, a time or a price are not', () => {
  expect(phoneNumbersIn('Call Lena back on (503) 555-0199 or +1 503 555 0142, ZIP 97214, after 3:30, $250.')).toEqual([
    '+15035550199',
    callerId,
  ])
})

test('with caller ID and no number in the message, caller ID is saved as the callback number', () => {
  expect(withCallbackNumber('Lena Brooks wants a call back about the faucet quote.', callerId, none)).toEqual({
    text: 'Lena Brooks wants a call back about the faucet quote. Callback number: +15035550142 (caller ID).',
  })
})

test('a number the caller made up is refused: only caller ID or a number confirmed with get_phone_number goes in', () => {
  const made = withCallbackNumber('Lena Brooks wants a call back on 503-555-0199.', callerId, none)
  expect(made).toMatchObject({ refusal: expect.stringContaining('+15035550199 is not the caller') })
  expect('refusal' in made && made.refusal).toMatch(/get_phone_number first, giving their reason/)
  // Confirmed with get_phone_number: saved as it is, without caller ID next to it.
  expect(
    withCallbackNumber('Lena Brooks wants a call back on 503-555-0199.', callerId, {
      confirmed: ['+15035550199'],
      saved: [],
    }),
  ).toEqual({
    text: 'Lena Brooks wants a call back on 503-555-0199.',
  })
  // Caller ID itself in the words: nothing added.
  expect(withCallbackNumber('Call Lena back on 503 555 0142.', callerId, none)).toEqual({
    text: 'Call Lena back on 503 555 0142.',
  })
})

test('caller ID is added once per call, and not when the caller confirmed another number', () => {
  const saved = ['Lena wants a call back. Callback number: +15035550142 (caller ID).']
  expect(withCallbackNumber('Afternoons are best.', callerId, { confirmed: [], saved })).toEqual({
    text: 'Afternoons are best.',
  })
  expect(withCallbackNumber('Lena wants a call back.', callerId, { confirmed: ['+15035550199'], saved: [] })).toEqual({
    text: 'Lena wants a call back.',
  })
})

test('without caller ID the message is saved as written', () => {
  expect(withCallbackNumber('Call back on 503-555-0199.', null, none)).toEqual({ text: 'Call back on 503-555-0199.' })
})

test('a message too long for the number keeps its words', () => {
  const long = 'x'.repeat(480)
  expect(withCallbackNumber(long, callerId, none)).toEqual({ text: long })
})

test('get_phone_number asks for a callback number with caller ID only with a reason', () => {
  expect(phoneStepRefusal(callerId, 'callback number', null)).toMatch(/do not ask for one/)
  expect(phoneStepRefusal(callerId, 'callback number', 'wants a call back on their work phone')).toBeNull()
  expect(phoneStepRefusal(callerId, "site contact's number", null)).toBeNull()
  expect(phoneStepRefusal(null, 'callback number', null)).toBeNull()
})
