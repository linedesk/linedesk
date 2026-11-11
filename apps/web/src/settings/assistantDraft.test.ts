import type { Assistant } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CALL_RULES, DEFAULT_SILENCE_CLOSING, disclosesAi, withDisclosure, withoutDisclosure } from '@linedesk/actions'
import { callRulesToSave, draftOf, isDefaultCallRules, draftProblem, foldProfile, isDirty, mergeDraft, normalized, profileOf, spokenLength, staleGreetingName, transferProblem, transfersToSave, newTransferContact, moveTransfer, transferInactive, silenceProblem, silenceSummary, silenceToSave } from './assistantDraft.ts'

const oldProfile = { description: 'Plumbing', services: ['Leak repair', ' ', 'Drains'], service_area: 'Portland', address: '1 Main St', hours: 'Mon–Fri', faqs: [{ q: 'Estimates?', a: 'Free.' }, { q: '', a: '' }] }
const assistant = (over: Partial<Assistant> = {}) => ({ id: 'as1', name: 'Maya', greeting: 'Hello', disclose_ai: true, business_profile: oldProfile, voice: { provider: 'elevenlabs', voice_id: '' }, ...over }) as Assistant

describe('instructions', () => {
  it('folds the older fields into one text, once, in the shape the assistant read them', () => {
    expect(draftOf(assistant()).instructions).toBe('About: Plumbing\nService area: Portland\nAddress: 1 Main St\nHours: Mon–Fri')
    // services and FAQs have their own lists: older plain names become quote-only services
    expect(draftOf(assistant()).services).toEqual([
      { name: 'Leak repair', description: '', price: '' },
      { name: 'Drains', description: '', price: '' },
    ])
    expect(foldProfile({})).toBe('')
  })
  it('reads saved instructions as they are, even when older fields are still there', () => {
    expect(draftOf(assistant({ business_profile: { ...oldProfile, instructions: 'Be brief.' } })).instructions).toBe('Be brief.')
    // empty instructions: like the voice agent, the older fields still apply, so they are shown
    expect(draftOf(assistant({ business_profile: { ...oldProfile, instructions: '  ' } })).instructions).toContain('About: Plumbing')
    expect(draftOf(assistant({ business_profile: { instructions: '' } })).instructions).toBe('') // saved empty by this page: nothing left to fold
  })
  it('saves the instructions in place of the fields they came from', () => {
    expect(profileOf(normalized({ ...draftOf(assistant()), instructions: '  New text  ' }))).toEqual({
      instructions: 'New text',
      service_list: [
        { name: 'Leak repair', description: '', price: '' },
        { name: 'Drains', description: '', price: '' },
      ],
      faqs: [{ q: 'Estimates?', a: 'Free.' }],
    })
  })
  it('services need a name and FAQs both parts; empty rows are dropped', () => {
    const d = draftOf(assistant())
    expect(draftProblem({ ...d, services: [...d.services, { name: '', description: '', price: '' }] })).toBeNull()
    expect(draftProblem({ ...d, services: [{ name: ' ', description: '', price: '$90' }] })).toBe('Every service needs a name.')
    expect(draftProblem({ ...d, faqs: [{ q: 'Weekends?', a: '' }] })).toBe('Every FAQ needs a question and an answer.')
    expect(draftProblem({ ...d, faqs: Array.from({ length: 31 }, (_, i) => ({ q: `Q${i}`, a: 'A' })) })).toBe('At most 30 FAQs.')
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

describe('transfer contacts', () => {
  const mike = { id: 'oncall', name: 'Mike', number: '+15035550199', condition: 'Urgent: a burst pipe', hours_only: false, ring_seconds: 25, if_no_answer: 'message_urgent' as const, enabled: true }
  const withList = (transfers: ReturnType<typeof draftOf>['transfers']) => ({ ...draftOf(assistant()), transfers })
  it('shows saved numbers formatted and saves what was typed as E.164, empty as none', () => {
    const saved = draftOf(assistant({ transfers: [mike, { ...mike, id: 'person', name: 'Owner', number: null }] }))
    expect(saved.transfers.map(c => c.number)).toEqual(['+1 503 555 0199', ''])
    expect(transfersToSave(withList([{ ...saved.transfers[0]!, number: '(503) 555-0199', name: ' Mike ' }, saved.transfers[1]!]))).toEqual([
      mike,
      { ...mike, id: 'person', name: 'Owner', number: null },
    ])
    expect(isDirty(withList([{ ...saved.transfers[0]!, number: '(503) 555-0199' }]), withList([saved.transfers[0]!]))).toBe(false)
  })
  it('the order of a contact\'s fields (Postgres keeps jsonb keys in its own) is no change', () => {
    const reordered = Object.fromEntries(Object.entries(mike).reverse()) as typeof mike
    expect(isDirty(draftOf(assistant({ transfers: [reordered] })), draftOf(assistant({ transfers: [mike] })))).toBe(false)
  })
  it('an assistant from before the list has none', () => {
    expect(draftOf(assistant()).transfers).toEqual([])
  })
  it('points at the first contact and field with a problem', () => {
    const draft = (over: object) => withList([{ ...mike, number: '+1 503 555 0199' }, { ...mike, id: 'b', name: 'Office', number: '', ...over }])
    expect(transferProblem(draft({}))).toBeNull() // no number yet: fine, the contact waits for one
    expect(transferProblem(draft({ name: ' ' }))).toMatchObject({ index: 1, field: 'name' })
    expect(transferProblem(draft({ name: 'mike' }))).toMatchObject({ index: 1, field: 'name', message: 'Another contact is called "mike".' })
    expect(transferProblem(draft({ number: '555-0199' }))).toMatchObject({ index: 1, field: 'number', message: expect.stringMatching(/area code/) })
    expect(transferProblem(draft({ number: '+1 900 555 0199' }))).toMatchObject({ field: 'number', message: expect.stringMatching(/Premium-rate/) })
    expect(transferProblem(draft({ condition: '' }))).toMatchObject({ index: 1, field: 'condition' })
    expect(draftProblem(draft({ condition: '' }))).toBe('Say when calls go to this contact.')
  })
  it('adds presets with a free id and name, and moves contacts up and down', () => {
    const list = draftOf(assistant({ transfers: [{ ...mike, id: 'tc_2', name: 'Owner' }] })).transfers
    expect(newTransferContact(list, 'person')).toMatchObject({ id: 'tc_3', name: 'Owner 2', if_no_answer: 'message', ring_seconds: 25, number: '', enabled: true })
    expect(newTransferContact([], 'person')).toMatchObject({ id: 'tc_1', name: 'Owner', condition: 'The caller asks to speak to a person', hours_only: true })
    expect(moveTransfer(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveTransfer(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
  })
  it('says why a contact is not used', () => {
    expect(transferInactive({ enabled: false, number: '+1 503 555 0199' })).toBe('Off')
    expect(transferInactive({ enabled: true, number: ' ' })).toBe('Add a number to turn it on')
    expect(transferInactive({ enabled: true, number: '+1 503 555 0199' })).toBeNull()
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

describe('a keypad menu saved by an older release', () => {
  it('is ignored: the draft has no keypad fields and nothing changes', () => {
    const stale = { keypad_menu: { options: [{ key: '1', label: 'emergencies', action: 'transfer' }] } } as unknown as Partial<Assistant>
    const draft = draftOf(assistant(stale))
    expect(Object.keys(draft).some(k => k.startsWith('keypad'))).toBe(false)
    expect(isDirty(draft, draftOf(assistant()))).toBe(false)
    expect(draftProblem(draft)).toBeNull()
  })
})
