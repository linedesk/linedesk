import { describe, expect, test } from 'vitest'
import { bannerText, confirmText, type Impersonation, minutesLeft, remainingText } from './impersonation.ts'

const imp: Impersonation = {
  by: { id: 'a', name: 'Tim Admin', email: 'owner@linedesk.test' },
  user: { id: 'u', name: 'Mike Brennan', email: 'mike@brightwater.example' },
  expiresAt: '2026-11-11T12:00:00.000Z',
}

describe('impersonation banner', () => {
  test('says whose session it is and which admin is in it', () => {
    expect(bannerText(imp)).toEqual({
      who: 'Signed in as Mike Brennan',
      email: 'mike@brightwater.example',
      by: 'by Tim Admin',
    })
    // Without a name the email names them already: it is not repeated.
    expect(bannerText({ ...imp, user: { ...imp.user, name: '' } })).toMatchObject({ who: 'Signed in as mike@brightwater.example', email: null })
  })

  test('remaining minutes round up and stop at zero', () => {
    expect(minutesLeft(imp.expiresAt, new Date('2026-11-11T11:00:00Z'))).toBe(60)
    expect(minutesLeft(imp.expiresAt, new Date('2026-11-11T11:59:01Z'))).toBe(1)
    expect(minutesLeft(imp.expiresAt, new Date('2026-11-11T12:00:30Z'))).toBe(0)
    expect([remainingText(60), remainingText(1), remainingText(0)]).toEqual(['60 min left', '1 min left', 'ending'])
  })

  test('the confirmation says what happens and how long', () => {
    expect(confirmText('Mike Brennan')).toBe(
      'You will see Linedesk exactly as Mike Brennan does. Everything you do is recorded as done by you on their behalf. Ends after 1 hour.',
    )
  })
})
