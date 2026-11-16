import type { Assistant } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SILENCE_CLOSING, disclosesAi, withDisclosure, withoutDisclosure } from '@linedesk/actions'
import { draftOf, draftProblem, languagesToSave, offeredLanguages, foldProfile, isDirty, mergeDraft, normalized, profileOf, spokenLength, staleGreetingName, transferProblem, transfersToSave, newTransferContact, moveTransfer, transferInactive, hangUpSummary, silenceProblem, silenceSummary, silenceToSave } from './assistantDraft.ts'

const oldProfile = { description: 'Plumbing', services: ['Leak repair', ' ', 'Drains'], service_area: 'Portland', address: '1 Main St', hours: 'Mon–Fri', faqs: [{ q: 'Estimates?', a: 'Free.' }, { q: '', a: '' }] }
const assistant = (over: Partial<Assistant> = {}) => ({ id: 'as1', name: 'Maya', greeting: 'Hello', disclose_ai: true, business_profile: oldProfile, voice: { provider: 'elevenlabs', voice_id: '' }, ...over }) as Assistant

describe('instructions', () => {
  it('folds the older fields into one text, once, in the shape the assistant read them', () => {
    expect(draftOf(assistant()).instructions).toBe('About: Plumbing\nServices: Leak repair, Drains\nService area: Portland\nAddress: 1 Main St\nHours: Mon–Fri')
    expect(foldProfile({})).toBe('')
  })
  it('reads saved instructions as they are, even when older fields are still there', () => {
    expect(draftOf(assistant({ business_profile: { ...oldProfile, instructions: 'Be brief.' } })).instructions).toBe('Be brief.')
    // empty instructions: like the voice agent, the older fields still apply, so they are shown
    expect(draftOf(assistant({ business_profile: { ...oldProfile, instructions: '  ' } })).instructions).toContain('About: Plumbing')
    expect(draftOf(assistant({ business_profile: { instructions: '' } })).instructions).toBe('') // saved empty by this page: nothing left to fold
  })
  it('saves the instructions in place of the fields they came from', () => {
    // Services and FAQs are no longer saved: what was stored is left out.
    expect(profileOf(normalized({ ...draftOf(assistant()), instructions: '  New text  ' }))).toEqual({ instructions: 'New text' })
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
  it('is clean after saving "Also speak: None" with languages still ticked from before', () => {
    const picked = draftOf(assistant({ languages: { main: 'en', mode: 'allowed', allowed: ['es'] } }))
    const none = { ...picked, languages: { ...picked.languages, mode: 'english' as const } }
    const afterSave = draftOf(assistant(languagesToSave(none)))
    expect(isDirty(normalized(none), afterSave)).toBe(false)
  })
  it('requires a name and a greeting', () => {
    expect(draftProblem(saved)).toBeNull()
    expect(draftProblem({ ...saved, name: ' ' })).toBe('Enter a name. Callers hear it.')
    expect(draftProblem({ ...saved, name: 'x'.repeat(61) })).toBe('At most 60 characters.')
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

it('a renamed assistant whose greeting still says the old name is noticed', () => {
  expect(staleGreetingName('Thanks for calling. This is Maya, the AI assistant.', 'Maya', 'Ava')).toBe('Maya')
  expect(staleGreetingName('Thanks for calling. This is Ava.', 'Maya', 'Ava')).toBeNull()
  expect(staleGreetingName('This is Maya.', 'Maya', 'Maya')).toBeNull()
  expect(staleGreetingName('This is Maya.', 'Maya', '  ')).toBeNull()
})

describe('transfer contacts', () => {
  const mike = { id: 'oncall', name: 'Mike', number: '+15035550199', condition: 'Urgent: a burst pipe', hours_only: false, ring_seconds: 25, if_no_answer: 'message' as const, enabled: true }
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
    // The phone field's value (E.164 as far as typed): unfinished says so for its country; another country is not taken
    expect(transferProblem(draft({ number: '+1503555' }))).toMatchObject({
      field: 'number',
      message: "This number doesn't look complete for the United States.",
    })
    // Another country: only when the workspace may call it (its numbers' countries, plus the install's).
    expect(transferProblem(draft({ number: '+4930123456' }), ['US'])).toMatchObject({
      field: 'number',
      message: expect.stringMatching(/^Only numbers in the United States/),
    })
    expect(transferProblem(draft({ number: '+4930123456' }), ['DE', 'US'])).toBeNull()
    expect(transferProblem(draft({ number: '+4980012345678' }), ['DE', 'US'])).toMatchObject({
      index: 1,
      message: expect.stringMatching(/Toll-free/),
    })
    expect(transferProblem(draft({ number: '+15035550199' }))).toBeNull()
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
    expect(transferInactive({ enabled: true, number: ' ' })).toBe('Add a number to use it')
    expect(transferInactive({ enabled: true, number: '+1 503 555 0199' })).toBeNull()
  })
})

describe('silence on the line', () => {
  it('defaults on: asks at 5 and 10 s, hangs up at 15 s and after 20 minutes, the default lines (saved as null)', () => {
    const d = draftOf(assistant())
    expect(d).toMatchObject({ silence_first_gap_s: '5', silence_reminders: '2', silence_hang_up_s: '15', max_call_minutes: '20', silence_closing: DEFAULT_SILENCE_CLOSING })
    expect(silenceProblem(d)).toBeNull()
    expect(silenceToSave(d)).toEqual({ silence_first_gap_s: 5, silence_reminders: 2, silence_hang_up_s: 15, max_call_minutes: 20, silence_reminder: null, silence_closing: null })
    expect(silenceSummary(d)).toBe('Asks "Are you still there?" after 5 and 10 seconds of silence. Never while a call is transferred.')
    expect(hangUpSummary(d)).toBe('Says this and hangs up at 15 seconds of silence. At 20 minutes it says goodbye and hangs up. A call put through to a person goes on.')
  })
  it('own values are kept and checked', () => {
    const d = draftOf(assistant({ silence_first_gap_s: 8, silence_reminders: 0, silence_hang_up_s: 20, max_call_minutes: 10, silence_closing: 'Bye for now.' } as Partial<Assistant>))
    expect(silenceToSave(d)).toEqual({ silence_first_gap_s: 8, silence_reminders: 0, silence_hang_up_s: 20, max_call_minutes: 10, silence_reminder: null, silence_closing: 'Bye for now.' })
    expect(silenceToSave({ ...d, silence_reminder: ' Hello? ' }).silence_reminder).toBe('Hello?')
    expect(silenceSummary(d)).toBe('Never asks: it only hangs up after the silence below.')
    expect(silenceSummary({ ...d, silence_reminders: '1', silence_reminder: 'Hello?' })).toMatch(/^Asks "Hello\?" after 8 seconds/)
    const bad = [{ silence_first_gap_s: '2' }, { silence_first_gap_s: 'ten' }, { silence_reminders: '9' }, { silence_hang_up_s: '500' }, { max_call_minutes: '0' }, { max_call_minutes: '31' }, { silence_reminders: '3', silence_hang_up_s: '24' }, { silence_closing: 'x'.repeat(201) }, { silence_reminder: 'x'.repeat(201) }]
    for (const change of bad) {
      expect(silenceProblem({ ...d, ...change }), JSON.stringify(change).slice(0, 40)).not.toBeNull()
      expect(draftProblem({ ...d, ...change })).not.toBeNull()
    }
    expect(silenceProblem({ ...d, silence_reminders: '3', silence_hang_up_s: '24' })).toBe('Hang up after the last question: more than 24 seconds.')
  })
  it('the default reminder in the main language is saved as null, so a call says it in the language spoken', () => {
    const german = draftOf(assistant({ languages: { main: 'de', mode: 'english', allowed: [] } } as Partial<Assistant>))
    expect(german.silence_reminder).not.toBe('Are you still there?')
    expect(silenceToSave(german).silence_reminder).toBeNull()
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

describe('offeredLanguages', () => {
  it('offers the languages the install can answer calls in, and keeps the ones already picked', () => {
    const d = { languages: { main: 'en' as const, mode: 'allowed' as const, allowed: ['vi' as const] } }
    expect(offeredLanguages(['en', 'es', 'ko'], d)).toEqual(['en', 'es', 'ko', 'vi'])
    expect(offeredLanguages(['en', 'es', 'ko'], { languages: { main: 'hu', mode: 'english', allowed: [] } })).toEqual(['en', 'es', 'ko', 'hu'])
  })
  it('offers every language when an older API does not say', () => {
    expect(offeredLanguages(undefined, { languages: { main: 'en', mode: 'english', allowed: [] } })).toContain('pl')
  })
})
