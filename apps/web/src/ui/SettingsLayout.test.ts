import { expect, test } from 'vitest'
import { knownSectionHash, sectionParts } from './SettingsLayout.tsx'

const sections = [
  { id: 'general', label: 'General' },
  { id: 'phone', label: 'Phone numbers' },
]

test('a link to one thing in a section names that section and the thing', () => {
  expect(sectionParts('workspace', '#workspace/phone/pn_1')).toEqual({ section: 'phone', item: 'pn_1' })
  expect(sectionParts('workspace', '#workspace/phone?x=1')).toEqual({ section: 'phone', item: '' })
  expect(sectionParts('assistant/a1', '#assistant/a1/hours')).toEqual({ section: 'hours', item: '' })
  expect(sectionParts('workspace', '#calls/you')).toEqual({ section: '', item: '' })
})

test('a link to one thing in a known section keeps its address', () => {
  expect(knownSectionHash('workspace', sections, '#workspace/phone/pn_1')).toBeNull()
  expect(knownSectionHash('workspace', sections, '#workspace/nope/pn_1')).toBe('#workspace/general')
  expect(knownSectionHash('workspace', sections, '#workspace/nope?q=1')).toBe('#workspace/general?q=1')
})
