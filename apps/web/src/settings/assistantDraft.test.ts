import type { Assistant } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { disclosesAi, draftOf, draftProblem, isDirty, mergeDraft, normalized, profileOf, spokenLength, withDisclosure, withoutDisclosure } from './assistantDraft.ts'

const assistant = (over: Partial<Assistant> = {}) => ({
  id: 'as1', name: 'Maya', greeting: 'Hello', disclose_ai: true,
  business_profile: { description: 'Plumbing', services: ['Leak repair'], service_area: 'Portland', address: '1 Main St', hours: 'Mon–Fri', faqs: [{ q: 'Estimates?', a: 'Free.' }] },
  ...over,
}) as Assistant

describe('assistant draft', () => {
  it('reads the row, with empty defaults for a new assistant', () => {
    expect(draftOf(assistant())).toMatchObject({ name: 'Maya', services: ['Leak repair'], hours: 'Mon–Fri', faqs: [{ q: 'Estimates?', a: 'Free.' }] })
    expect(draftOf(assistant({ business_profile: {} }))).toMatchObject({ description: '', services: [], service_area: '', hours: '', faqs: [] })
  })
  it('keeps touched fields and refreshes untouched ones when a change syncs in', () => {
    const saved = draftOf(assistant())
    const editing = { ...saved, greeting: 'Hi there', services: ['Leak repair', 'Drains'] }
    const fromElsewhere = draftOf(assistant({ name: 'Mia', greeting: 'Good day' }))
    const merged = mergeDraft(editing, saved, fromElsewhere)
    expect(merged.name).toBe('Mia') // untouched: follows the server
    expect(merged.greeting).toBe('Hi there') // touched: the edit stays
    expect(merged.services).toEqual(['Leak repair', 'Drains'])
    expect(isDirty(merged, fromElsewhere)).toBe(true)
    expect(isDirty(mergeDraft(saved, saved, fromElsewhere), fromElsewhere)).toBe(false)
  })
  it('trims, drops empty rows and keeps profile fields the page does not edit', () => {
    const draft = { ...draftOf(assistant()), description: ' Plumbing and heating ', services: ['Leak repair', '  ', ' Drains '], faqs: [{ q: ' Estimates? ', a: ' Free. ' }, { q: '', a: '' }] }
    expect(profileOf(draft, assistant().business_profile)).toEqual({
      description: 'Plumbing and heating', services: ['Leak repair', 'Drains'], service_area: 'Portland', address: '1 Main St', hours: 'Mon–Fri',
      faqs: [{ q: 'Estimates?', a: 'Free.' }],
    })
  })
  it('refuses to save a question without an answer instead of dropping it', () => {
    const base = draftOf(assistant())
    expect(draftProblem(base)).toBeNull()
    expect(draftProblem({ ...base, faqs: [{ q: 'Do you do gas?', a: ' ' }] })).toContain('Do you do gas?')
    expect(draftProblem({ ...base, faqs: [{ q: '', a: 'Yes.' }] })).toContain('no question')
    expect(draftProblem({ ...base, faqs: [{ q: '', a: '' }] })).toBeNull() // an empty row is just dropped
    expect(draftProblem({ ...base, name: ' ' })).toBe('The assistant needs a name.')
  })
})

describe('saving the assistant', () => {
  const saved = draftOf(assistant())
  it('does not count spaces or an empty row as a change, and is clean after a save', () => {
    expect(isDirty({ ...saved, services: [...saved.services, ''] }, saved)).toBe(false)
    expect(isDirty({ ...saved, name: ' Maya ' }, saved)).toBe(false)
    expect(isDirty({ ...saved, faqs: [...saved.faqs, { q: '', a: '' }] }, saved)).toBe(false)
    const edited = { ...saved, services: [...saved.services, '  QA test service  '] }
    expect(isDirty(edited, saved)).toBe(true)
    const afterSave = draftOf(assistant({ business_profile: profileOf(normalized(edited), assistant().business_profile) }))
    expect(isDirty(normalized(edited), afterSave)).toBe(false)
  })
  it('requires a greeting and says one second, not "1 seconds"', () => {
    expect(draftProblem({ ...saved, greeting: '   ' })).toContain('greeting')
    expect(spokenLength('Hi.')).toBe('about 1 second spoken')
    expect(spokenLength('  ')).toBe('nothing to say yet')
    expect(spokenLength('Thanks for calling Brightwater, this is Maya. How can I help?')).toBe('about 4 seconds spoken')
  })
})

describe('AI disclosure in the greeting', () => {
  const greeting = 'Thanks for calling Brightwater Plumbing & Heating. This is Maya, the AI assistant. How can I help?'
  it('removes and adds it back where the name is', () => {
    const off = withoutDisclosure(greeting)
    expect(off).toBe('Thanks for calling Brightwater Plumbing & Heating. This is Maya. How can I help?')
    expect(disclosesAi(off)).toBe(false)
    expect(withDisclosure(off, 'Maya')).toBe(greeting)
  })
  it('adds a sentence when the greeting does not name the assistant', () => {
    expect(withDisclosure('Thanks for calling. How can I help?', 'Maya')).toBe('Thanks for calling. This is Maya, the AI assistant. How can I help?')
    expect(withDisclosure('', 'Maya')).toBe('This is Maya, the AI assistant.')
    expect(withDisclosure(greeting, 'Maya')).toBe(greeting) // already says it
    expect(withoutDisclosure('Hi, this is Maya, a virtual assistant.')).toBe('Hi, this is Maya.')
  })
})
