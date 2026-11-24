import { expect, test } from 'vitest'
import { callerPrivacyNotice, recordingKind } from './callerPrivacyNotice.ts'

test('the recording sentence follows the workspace settings', () => {
  expect(recordingKind({ on: true, days: 30 })).toBe('days')
  expect(recordingKind({ on: true, days: null })).toBe('forever')
  expect(recordingKind({ on: true, days: 0 })).toBe('none')
  // Recording off on the server: nothing is recorded, whatever the saved retention says.
  expect(recordingKind({ on: false, days: 30 })).toBe('none')

  expect(callerPrivacyNotice({ on: true, days: 30 }, 'Linedesk')).toContain('delete the recordings after 30 days.')
  expect(callerPrivacyNotice({ on: true, days: 1 }, 'Linedesk')).toContain('after 1 day.')
  expect(callerPrivacyNotice({ on: true, days: null }, 'Linedesk')).toContain(
    'keep the recordings until we delete the call.',
  )
  expect(callerPrivacyNotice({ on: false, days: 30 }, 'Linedesk')).toContain(
    'We do not keep audio recordings of calls.',
  )
})

test('covers controller, processor, rights and contact, with the parts to fill in marked', () => {
  const text = callerPrivacyNotice({ on: true, days: 90 }, 'Acme Voice')
  expect(text).toContain('“controller”')
  expect(text).toContain('Acme Voice runs the assistant for us as our processor.')
  expect(text).toContain('Standard Contractual Clauses')
  expect(text).toContain('We do not sell your data')
  expect(text).toContain('data protection authority')
  expect(text).toContain('California residents')
  expect(text).toContain('[email or phone]')
  expect(text).toContain('[period]')
  // Plain paragraphs: no ICU leftovers, split by blank lines.
  expect(text).not.toMatch(/[{}]/)
  expect(text.split('\n\n')).toHaveLength(8)
})
