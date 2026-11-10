import type { Assistant } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { draftOf, draftProblem, isDirty, mergeDraft, profileOf } from './assistantDraft.ts'

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
