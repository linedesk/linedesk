import { expect, test } from 'vitest'
import { matchCarrierNumbers } from './CarrierNumberInput.tsx'

const numbers = ['+15035550142', '+15415550199', '+12065550100']

test('a search matches the digits anywhere in the number, however they are typed', () => {
  expect(matchCarrierNumbers(numbers, '')).toEqual(numbers)
  expect(matchCarrierNumbers(numbers, '(503)')).toEqual(['+15035550142'])
  expect(matchCarrierNumbers(numbers, '555 01')).toEqual(['+15035550142', '+15415550199', '+12065550100'])
  expect(matchCarrierNumbers(numbers, '0199')).toEqual(['+15415550199'])
  expect(matchCarrierNumbers(numbers, '999')).toEqual([])
})

test("the phone field's value (E.164 as far as typed) finds the numbers it starts, in any country", () => {
  const mixed = [...numbers, '+4930123456']
  expect(matchCarrierNumbers(mixed, '+1503')).toEqual(['+15035550142'])
  expect(matchCarrierNumbers(mixed, '+4930')).toEqual(['+4930123456'])
  expect(matchCarrierNumbers(mixed, '+15')).toEqual(['+15035550142', '+15415550199'])
})
