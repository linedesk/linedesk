import type { Assistant } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CALL_RULES } from '@callfront/actions'
import { callRulesToSave, disclosesAi, draftOf, isDefaultCallRules, draftProblem, foldProfile, isDirty, mergeDraft, normalized, profileOf, spokenLength, withDisclosure, withoutDisclosure } from './assistantDraft.ts'

const oldProfile = { description: 'Plumbing', services: ['Leak repair', ' ', 'Drains'], service_area: 'Portland', address: '1 Main St', hours: 'Mon–Fri', faqs: [{ q: 'Estimates?', a: 'Free.' }, { q: '', a: '' }] }
const assistant = (over: Partial<Assistant> = {}) => ({ id: 'as1', name: 'Maya', greeting: 'Hello', disclose_ai: true, business_profile: oldProfile, ...over }) as Assistant

describe('instructions', () => {
  it('folds the older fields into one text, once, in the shape the assistant read them', () => {
    expect(draftOf(assistant()).instructions).toBe('About: Plumbing\nServices: Leak repair, Drains\nService area: Portland\nAddress: 1 Main St\nHours: Mon–Fri\nFrequently asked questions:\nQ: Estimates?\nA: Free.')
    expect(foldProfile({})).toBe('')
  })
  it('reads saved instructions as they are, even when older fields are still there', () => {
    expect(draftOf(assistant({ business_profile: { ...oldProfile, instructions: 'Be brief.' } })).instructions).toBe('Be brief.')
    // empty instructions: like the voice agent, the older fields still apply, so they are shown
    expect(draftOf(assistant({ business_profile: { ...oldProfile, instructions: '  ' } })).instructions).toContain('About: Plumbing')
    expect(draftOf(assistant({ business_profile: { instructions: '' } })).instructions).toBe('') // saved empty by this page: nothing left to fold
  })
  it('saves the instructions in place of the fields they came from', () => {
    expect(profileOf({ ...draftOf(assistant()), instructions: '  New text  ' })).toEqual({ instructions: 'New text' })
  })
  it('refuses instructions over the limit with a count', () => {
    expect(draftProblem({ ...draftOf(assistant()), instructions: 'x'.repeat(20_001) })).toBe('The instructions are too long: 20,001 of 20,000 characters.')
    expect(draftProblem({ ...draftOf(assistant()), instructions: 'x'.repeat(20_000) })).toBeNull()
  })
})

describe('draft', () => {
  const saved = draftOf(assistant())
  it('keeps touched fields and refreshes untouched ones when a change syncs in', () => {
    const editing = { ...saved, instructions: 'Mine' }
    const merged = mergeDraft(editing, saved, draftOf(assistant({ name: 'Mia' })))
    expect(merged).toMatchObject({ name: 'Mia', instructions: 'Mine' })
  })
  it('does not count spaces as a change, and is clean after a save', () => {
    expect(isDirty({ ...saved, name: ' Maya ', instructions: `${saved.instructions}\n` }, saved)).toBe(false)
    const edited = { ...saved, instructions: 'Hours: 24/7' }
    expect(isDirty(edited, saved)).toBe(true)
    const afterSave = draftOf(assistant({ business_profile: profileOf(normalized(edited)) }))
    expect(isDirty(normalized(edited), afterSave)).toBe(false)
  })
  it('requires a name and a greeting', () => {
    expect(draftProblem(saved)).toBeNull()
    expect(draftProblem({ ...saved, name: ' ' })).toBe('The assistant needs a name.')
    expect(draftProblem({ ...saved, greeting: '   ' })).toContain('greeting')
    expect(draftProblem({ ...saved, instructions: '' })).toBeNull()
  })
  it('says how long the greeting takes', () => {
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
    expect(withDisclosure(greeting, 'Maya')).toBe(greeting)
    expect(withoutDisclosure('Hi, this is Maya, a virtual assistant.')).toBe('Hi, this is Maya.')
  })
})

describe('call rules', () => {
  it('shows the default rules when none are stored and saves null for them, so a better default arrives later', () => {
    const draft = draftOf(assistant({ call_rules: null }))
    expect(draft.call_rules).toBe(DEFAULT_CALL_RULES)
    expect(isDefaultCallRules(draft)).toBe(true)
    expect(callRulesToSave({ ...draft, call_rules: `${DEFAULT_CALL_RULES}\n` })).toBeNull()
    expect(callRulesToSave({ ...draft, call_rules: '  ' })).toBeNull()
  })
  it('saves the owner\'s own rules, trimmed, and refuses them over the limit', () => {
    const draft = draftOf(assistant({ call_rules: 'Ask for the address.' }))
    expect(draft.call_rules).toBe('Ask for the address.')
    expect(callRulesToSave({ ...draft, call_rules: ' Ask twice. ' })).toBe('Ask twice.')
    expect(draftProblem({ ...draft, call_rules: 'x'.repeat(10_001) })).toBe('How to handle calls is too long: 10,001 of 10,000 characters.')
  })
})
