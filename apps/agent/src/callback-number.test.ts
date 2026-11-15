import { expect, test } from 'vitest'
import { callerIdOf, hasCallbackNumber, phoneNumbersIn, phoneStepRefusal } from './callback-number.ts'

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

test('the team has a number to call back on: caller ID, a confirmed number, or one in a saved message', () => {
  expect(hasCallbackNumber(callerId, none)).toBe(true)
  expect(hasCallbackNumber(null, { confirmed: ['+15035550199'], saved: [] })).toBe(true)
  expect(hasCallbackNumber(null, { confirmed: [], saved: ['Call Lena back on 503-555-0199.'] })).toBe(true)
  expect(hasCallbackNumber(null, none)).toBe(false)
})

test('get_phone_number asks for a callback number with caller ID only with a reason', () => {
  expect(phoneStepRefusal(callerId, 'callback number', null)).toMatch(/do not ask for one/)
  expect(phoneStepRefusal(callerId, 'callback number', 'wants a call back on their work phone')).toBeNull()
  expect(phoneStepRefusal(callerId, "site contact's number", null)).toBeNull()
  expect(phoneStepRefusal(null, 'callback number', null)).toBeNull()
})
