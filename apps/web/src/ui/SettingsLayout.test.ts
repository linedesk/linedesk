import { expect, test } from 'vitest'
import { knownSectionHash, sectionParts } from './SettingsLayout.tsx'

const sections = [
  { id: 'notifications', label: 'Notifications' },
  { id: 'phone', label: 'Phone numbers' },
]

test('a link to one thing in a section names that section and the thing', () => {
  expect(sectionParts('settings', '#settings/phone/pn_1')).toEqual({ section: 'phone', item: 'pn_1' })
  expect(sectionParts('settings', '#settings/phone?x=1')).toEqual({ section: 'phone', item: '' })
  expect(sectionParts('assistant/a1', '#assistant/a1/hours')).toEqual({ section: 'hours', item: '' })
  expect(sectionParts('settings', '#calls/you')).toEqual({ section: '', item: '' })
})

test('a link to one thing in a known section keeps its address', () => {
  expect(knownSectionHash('settings', sections, '#settings/phone/pn_1')).toBeNull()
  expect(knownSectionHash('settings', sections, '#settings/nope/pn_1')).toBe('#settings/notifications')
  expect(knownSectionHash('settings', sections, '#settings/nope?q=1')).toBe('#settings/notifications?q=1')
})
