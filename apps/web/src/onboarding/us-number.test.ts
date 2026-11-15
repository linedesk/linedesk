import { expect, test } from 'vitest'
import { whoHearsProblem } from './flow.ts'
import { usE164, withUnfinishedNumber } from './us-number.ts'

const draft = (mobile: string) => ({ urgent: 'transfer' as const, mobile, condition: 'Burst pipes' })
const problem = (mobile: string) => withUnfinishedNumber(draft(mobile), whoHearsProblem(draft(mobile)))

test('an unfinished mobile number says so for its country', () => {
  expect(problem('+1503555')).toEqual({
    field: 'mobile',
    message: "This number doesn't look complete for the United States.",
  })
})

test('a whole number goes by the step’s own rules: US mobiles only', () => {
  expect(problem('+15035550142')).toBeNull()
  expect(problem('+4915112345678')).toMatchObject({
    field: 'mobile',
    message: expect.stringMatching(/US phone number/),
  })
  // Ten digits after another country code are never taken for a US number
  expect(problem('+4930123456')).toMatchObject({ field: 'mobile', message: expect.stringMatching(/US phone number/) })
  expect(problem('')).toMatchObject({ field: 'mobile', message: expect.stringMatching(/Enter your mobile/) })
})

test('usE164: US numbers as typed or in E.164; never another country code', () => {
  expect(usE164('+15035550142')).toBe('+15035550142')
  expect(usE164('(503) 555-0142')).toBe('+15035550142')
  expect(usE164('+4930123456')).toBeNull()
  expect(usE164('')).toBeNull()
})
