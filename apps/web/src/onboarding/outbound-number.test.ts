import { expect, test } from 'vitest'
import { outboundE164, whoHearsProblem } from './flow.ts'
import { withUnfinishedNumber } from './outbound-number.ts'

const draft = (mobile: string) => ({ urgent: 'transfer' as const, mobile, condition: 'Burst pipes' })
const problem = (mobile: string, countries: readonly string[] | 'any' = ['US']) =>
  withUnfinishedNumber(draft(mobile), whoHearsProblem(draft(mobile), [], countries))

test('an unfinished mobile number says so for its country', () => {
  expect(problem('+1503555')).toEqual({
    field: 'mobile',
    message: "This number doesn't look complete for the United States.",
  })
})

test('a whole number goes by the countries the workspace may call', () => {
  expect(problem('+15035550142')).toBeNull()
  expect(problem('+4915112345678')).toMatchObject({
    field: 'mobile',
    message:
      'Only numbers in the United States can take transferred calls. Ask your server admin to allow other countries.',
  })
  expect(problem('+4915112345678', ['DE'])).toBeNull()
  expect(problem('+16135550123', ['CA', 'US'])).toBeNull()
  // No Linedesk number yet: any country passes here, the server checks the dial.
  expect(problem('+4915112345678', 'any')).toBeNull()
  // Ten digits after another country code are never taken for a US number
  expect(problem('+4930123456')).toMatchObject({ field: 'mobile' })
  expect(problem('')).toMatchObject({
    field: 'mobile',
    message: expect.stringMatching(/Enter the number urgent calls should ring/),
  })
})

test('outboundE164: the phone field’s E.164 in any country, or an older US number without its country code', () => {
  expect(outboundE164('+15035550142')).toBe('+15035550142')
  expect(outboundE164('(503) 555-0142')).toBe('+15035550142')
  expect(outboundE164('+4930123456')).toBe('+4930123456')
  expect(outboundE164('+49301')).toBeNull()
  expect(outboundE164('')).toBeNull()
})

test('outboundE164: spaces as the field shows them are not part of the number', () => {
  expect(outboundE164('+1 503 555 0142')).toBe('+15035550142')
  expect(outboundE164('+49 30 1234 5678')).toBe('+493012345678')
})
