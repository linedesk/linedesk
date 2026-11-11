import type { Assistant } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CALL_RULES, DEFAULT_SILENCE_CLOSING } from '@linedesk/actions'
import { callRulesToSave, disclosesAi, draftOf, isDefaultCallRules, draftProblem, foldProfile, isDirty, mergeDraft, normalized, profileOf, spokenLength, withDisclosure, withoutDisclosure, staleGreetingName, onCallProblem, transferToSave, silenceProblem, silenceSummary, silenceToSave, keypadProblem, keypadToSave, nextFreeKey } from './assistantDraft.ts'

const oldProfile = { description: 'Plumbing', services: ['Leak repair', ' ', 'Drains'], service_area: 'Portland', address: '1 Main St', hours: 'Mon–Fri', faqs: [{ q: 'Estimates?', a: 'Free.' }, { q: '', a: '' }] }
const assistant = (over: Partial<Assistant> = {}) => ({ id: 'as1', name: 'Maya', greeting: 'Hello', disclose_ai: true, business_profile: oldProfile, voice: { provider: 'elevenlabs', voice_id: '' }, ...over }) as Assistant

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

it('a renamed assistant whose greeting still says the old name is noticed', () => {
  expect(staleGreetingName('Thanks for calling. This is Maya, the AI assistant.', 'Maya', 'Ava')).toBe('Maya')
  expect(staleGreetingName('Thanks for calling. This is Ava.', 'Maya', 'Ava')).toBeNull()
  expect(staleGreetingName('This is Maya.', 'Maya', 'Maya')).toBeNull()
  expect(staleGreetingName('This is Maya.', 'Maya', '  ')).toBeNull()
})

describe('transfer', () => {
  const on = (number: string) => ({ ...draftOf(assistant()), transfer_urgent: true, transfer_number: number })
  it('shows the saved number formatted and saves what was typed as E.164', () => {
    const saved = draftOf(assistant({ transfer_urgent: true, transfer_number: '+15035550199', transfer_hours_only: true }))
    expect(saved).toMatchObject({ transfer_urgent: true, transfer_number: '+1 503 555 0199', transfer_hours_only: true })
    expect(transferToSave({ ...on('(503) 555-0199'), transfer_hours_only: false })).toEqual({ transfer_urgent: true, transfer_number: '+15035550199', transfer_hours_only: false })
    expect(transferToSave({ ...on(''), transfer_urgent: false })).toMatchObject({ transfer_urgent: false, transfer_number: null })
    expect(isDirty(on('(503) 555-0199'), on('+1 503 555 0199'))).toBe(false)
  })
  it('needs a number when on, and a callable US one when given', () => {
    expect(onCallProblem({ transfer_urgent: false, transfer_number: '' })).toBeNull()
    expect(onCallProblem({ transfer_urgent: true, transfer_number: '' })).toBe('Add the on-call number urgent calls go to.')
    expect(onCallProblem({ transfer_urgent: true, transfer_number: '555-0199' })).toMatch(/area code/)
    expect(onCallProblem({ transfer_urgent: false, transfer_number: '+1 900 555 0199' })).toMatch(/Premium-rate/)
    expect(draftProblem(on(''))).toBe('Add the on-call number urgent calls go to.')
    expect(draftProblem(on('503 555 0199'))).toBeNull()
  })
})

describe('silence on the line', () => {
  it('defaults on: 8 s, asked twice, the default closing line (saved as null)', () => {
    const d = draftOf(assistant())
    expect(d).toMatchObject({ silence_first_gap_s: '8', silence_reminders: '2', silence_closing: DEFAULT_SILENCE_CLOSING })
    expect(silenceProblem(d)).toBeNull()
    expect(silenceToSave(d)).toEqual({ silence_first_gap_s: 8, silence_reminders: 2, silence_closing: null })
    expect(silenceSummary(d)).toBe('Asks "Are you still there?" after 8, 24 seconds of silence, says the closing line and hangs up at 56 seconds. Never while a call is transferred.')
  })
  it('own values are kept and checked', () => {
    const d = draftOf(assistant({ silence_first_gap_s: 5, silence_reminders: 0, silence_closing: 'Bye for now.' } as Partial<Assistant>))
    expect(silenceToSave(d)).toEqual({ silence_first_gap_s: 5, silence_reminders: 0, silence_closing: 'Bye for now.' })
    expect(silenceSummary(d)).toMatch(/^After 5 seconds of silence the assistant says the closing line/)
    for (const bad of [{ silence_first_gap_s: '2' }, { silence_first_gap_s: 'ten' }, { silence_reminders: '9' }, { silence_closing: 'x'.repeat(201) }]) {
      expect(silenceProblem({ ...d, ...bad }), JSON.stringify(bad).slice(0, 40)).not.toBeNull()
      expect(draftProblem({ ...d, ...bad })).not.toBeNull()
    }
  })
})

describe('keypad menu', () => {
  const menu = { options: [{ key: '1', label: 'emergencies', action: 'transfer' as const }, { key: '3', label: 'billing', action: 'topic' as const }] }

  it('is off without a saved menu, and saves null while off', () => {
    const draft = draftOf(assistant({ keypad_menu: null }))
    expect(draft.keypad_on).toBe(false)
    expect(keypadToSave(draft)).toEqual({ keypad_menu: null })
    expect(keypadProblem(draft)).toBeNull()
  })

  it('reads a saved menu and saves it back with trimmed labels', () => {
    const draft = draftOf(assistant({ keypad_menu: menu }))
    expect(draft.keypad_on).toBe(true)
    const edited = { ...draft, keypad_options: [{ ...draft.keypad_options[0]!, label: ' emergencies ' }, draft.keypad_options[1]!] }
    expect(keypadToSave(edited)).toEqual({ keypad_menu: menu })
    expect(isDirty(edited, draft)).toBe(false)
    expect(nextFreeKey(menu.options)).toBe('2')
  })

  it('needs a label per key and each key once', () => {
    const draft = draftOf(assistant({ keypad_menu: menu }))
    expect(keypadProblem({ ...draft, keypad_options: [] })).toMatch(/at least one key/)
    expect(keypadProblem({ ...draft, keypad_options: [{ key: '1', label: ' ', action: 'topic' }] })).toMatch(/needs a label/)
    expect(keypadProblem({ ...draft, keypad_options: [menu.options[0]!, { ...menu.options[1]!, key: '1' }] })).toMatch(/used once/)
    expect(draftProblem({ ...draft, keypad_options: [] })).toMatch(/at least one key/)
  })
})
