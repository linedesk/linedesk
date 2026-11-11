// The editable copy of the assistant's settings: how it is read from the row, merged with
// changes that arrive through sync, checked and turned back into what assistant.update takes.
import {
  knownCallerGreetingProblem,
  CALL_RULES_MAX, type Faq, FAQS_MAX, INSTRUCTIONS_MAX, RING_SECONDS_DEFAULT, TRANSFER_CONDITION_MAX,
  TRANSFER_CONTACTS_MAX, type Service, SERVICES_MAX, servicesOf, TRANSFER_NAME_MAX, callRulesOf, usesDefaultCallRules, onCallNumberProblem,
  DEFAULT_SILENCE_CLOSING, SILENCE_CLOSING_MAX, SILENCE_FIRST_GAP_MAX_S, SILENCE_FIRST_GAP_MIN_S, SILENCE_REMINDERS_MAX,
  SILENCE_FIRST_GAP_DEFAULT_S, SILENCE_REMINDERS_DEFAULT, KEYPAD_MENU_MAX_OPTIONS, BEHAVIOURS, type BehaviourId, behaviourOn, type AiDisclosure, DEFAULT_AI_DISCLOSURE, type CommunicationStyle, DEFAULT_COMMUNICATION_STYLE, type AssistantLanguages, ENGLISH_ONLY, type Language, languageCodes, LANGUAGES, mainLanguageOf, swapDefault,
} from '@linedesk/actions'
import type { Assistant, BusinessProfile, KeypadMenuOption, TransferContact } from '@linedesk/db/types'
import { formatNumber, renameInGreeting, toE164 } from '../onboarding/flow.ts'

/** `greeting_outside`: used outside business hours; empty = the same as during hours. */
export type Draft = {
  name: string
  greeting: string
  /** Whether and when the assistant mentions it is an AI. */
  ai_disclosure: AiDisclosure
  /** The tone it uses. */
  communication_style: CommunicationStyle
  /** Greet a caller whose number matches a contact with a name by first name. */
  /** Said before the greeting to a caller who called before; `{first_name}` filled in; empty: nothing. */
  greeting_known_caller: string
  instructions: string
  call_rules: string
  greeting_outside: string
  /** Warm transfer: who callers are put through to, and when, in order. */
  transfers: TransferDraft[]
  /** Keypad menu after the greeting; the options are kept while it is off, but only saved when on. */
  keypad_on: boolean
  keypad_options: KeypadMenuOption[]
  /** The voice: provider and voice id (empty: the provider's default). */
  voice: { provider: string; voice_id: string }
  /** Knowledge: services with prices (empty price: quote only), FAQs, and the website last imported from. */
  services: Service[]
  faqs: Faq[]
  website: string
  /** Silence on the line, as typed: seconds before the first "Are you still there?", how many, the closing line. */
  silence_first_gap_s: string
  silence_reminders: string
  silence_closing: string
  /** The behaviour checklist, every switch with its value (the default where the owner set none). */
  behaviours: Record<BehaviourId, boolean>
  /** Languages besides English; the picked ones are kept while English only is chosen, but saved empty. */
  languages: AssistantLanguages
}

/** A transfer contact as edited: the number as typed (saved as E.164, empty: none yet). */
export type TransferDraft = Omit<TransferContact, 'number'> & { number: string }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const line = (label: string, value?: string) => (value?.trim() ? `${label}: ${value.trim()}` : null)

/**
 * The older structured fields as one text, in the shape the assistant used to read them.
 * Shown once for an assistant that has no instructions yet, so nothing it knew is lost. Services and
 * FAQs have their own lists.
 */
export function foldProfile(p: BusinessProfile): string {
  return [line('About', p.description), line('Service area', p.service_area), line('Address', p.address), line('Hours', p.hours)]
    .filter(Boolean)
    .join('\n')
}

export function draftOf(a: Assistant): Draft {
  const p = a.business_profile
  // Same rule as the voice agent: empty instructions mean the older fields still apply, so show those.
  return {
    name: a.name, greeting: a.greeting, ai_disclosure: a.ai_disclosure ?? (a.disclose_ai ? 'at_start' : DEFAULT_AI_DISCLOSURE), communication_style: a.communication_style ?? DEFAULT_COMMUNICATION_STYLE, greeting_known_caller: a.greeting_known_caller ?? '', instructions: p.instructions?.trim() ? p.instructions : foldProfile(p),
    call_rules: callRulesOf(a.call_rules), // none stored: the default rules, shown so they can be edited
    greeting_outside: a.greeting_outside ?? '',
    transfers: (a.transfers ?? []).map(c => transferDraftOf({ ...c, number: c.number ? formatNumber(c.number) : '' })),
    keypad_on: !!a.keypad_menu?.options?.length,
    keypad_options: a.keypad_menu?.options?.length ? a.keypad_menu.options.map(o => ({ ...o })) : DEFAULT_KEYPAD_OPTIONS,
    voice: { provider: a.voice.provider, voice_id: a.voice.voice_id },
    services: servicesOf(p).map(s => ({ ...s })),
    faqs: (p.faqs ?? []).map(f => ({ ...f })),
    website: p.website ?? '',
    // A row synced before these columns existed has none: the defaults.
    silence_first_gap_s: String(a.silence_first_gap_s ?? SILENCE_FIRST_GAP_DEFAULT_S),
    silence_reminders: String(a.silence_reminders ?? SILENCE_REMINDERS_DEFAULT),
    // None stored: the default line, shown so it can be edited (like the call rules).
    silence_closing: a.silence_closing ?? DEFAULT_SILENCE_CLOSING,
    behaviours: behavioursOf(a.behaviours),
    languages: languagesOf(a.languages),
  }
}

/** Every switch of the checklist, in list order: the stored choice or the default. */
const behavioursOf = (stored: Assistant['behaviours'] | undefined) =>
  Object.fromEntries(BEHAVIOURS.map(b => [b.id, behaviourOn(stored, b.id)])) as Record<BehaviourId, boolean>

/** Only the switches that differ from their default are stored, so a better default reaches the others. */
export const behavioursToSave = (d: Pick<Draft, 'behaviours'>): Partial<Record<BehaviourId, boolean>> =>
  Object.fromEntries(BEHAVIOURS.filter(b => d.behaviours[b.id] !== b.on).map(b => [b.id, d.behaviours[b.id]]))

/** The stored setting with only known codes; a row synced before the column existed: English only. */
function languagesOf(stored: Assistant['languages'] | undefined): AssistantLanguages {
  if (!stored) return ENGLISH_ONLY
  return { main: mainLanguageOf(stored), mode: stored.mode, allowed: languageCodes.filter(code => stored.allowed.includes(code)) }
}

export const mainOf = (d: Pick<Draft, 'languages'>): Language => d.languages.main ?? 'en'
/** The languages picked besides the main one. */
export const pickedOthers = (d: Pick<Draft, 'languages'>): Language[] => d.languages.allowed.filter(code => code !== mainOf(d))

/** Why the languages cannot be saved, or null. */
export function languagesProblem(d: Pick<Draft, 'languages'>): string | null {
  return d.languages.mode === 'allowed' && !pickedOthers(d).length
    ? `Pick at least one language besides ${LANGUAGES[mainOf(d)]}, or choose None.`
    : null
}

/** What assistant.update takes: no list unless the allow-list is used, never the main language in it. */
export const languagesToSave = (d: Draft) => ({
  languages: { main: mainOf(d), mode: d.languages.mode, allowed: d.languages.mode === 'allowed' ? pickedOthers(d) : [] },
})

/**
 * The draft with another main language: texts that are still the old language's default (greetings, the
 * returning-caller line, the closing line) become the new one's; texts the owner wrote stay.
 */
export function withMainLanguage(d: Draft, main: Language): Draft {
  const from = mainOf(d)
  const swap = (text: string) => (text.trim() ? swapDefault(text, from, main) : text)
  return {
    ...d,
    languages: { ...d.languages, main },
    greeting: swap(d.greeting),
    greeting_outside: swap(d.greeting_outside),
    greeting_known_caller: swap(d.greeting_known_caller),
    silence_closing: swap(d.silence_closing),
  }
}

/** After a synced change: fields the user has not touched follow the server, touched fields keep the user's edit. */
export function mergeDraft(draft: Draft, previousSaved: Draft, nextSaved: Draft): Draft {
  const merged = { ...draft } as Record<keyof Draft, unknown>
  for (const key of Object.keys(nextSaved) as (keyof Draft)[]) {
    if (same(draft[key], previousSaved[key])) merged[key] = nextSaved[key]
  }
  return merged as Draft
}

/** What would be saved: trimmed. */
export const normalized = (d: Draft): Draft => ({
  ...d,
  name: d.name.trim(),
  greeting: d.greeting.trim(),
  instructions: d.instructions.trim(),
  call_rules: d.call_rules.trim(),
  greeting_outside: d.greeting_outside.trim(),
  greeting_known_caller: d.greeting_known_caller.trim(),
  transfers: d.transfers.map(c => transferDraftOf({ ...c, name: c.name.trim(), condition: c.condition.trim(), number: normalizedNumber(c.number) })),
  keypad_options: d.keypad_options.map(o => ({ ...o, label: o.label.trim() })),
  services: d.services
    .map(s => ({ name: s.name.trim(), description: s.description.trim(), price: s.price.trim() }))
    .filter(s => s.name || s.description || s.price),
  faqs: d.faqs.map(f => ({ q: f.q.trim(), a: f.a.trim() })).filter(f => f.q || f.a),
  website: d.website.trim(),
  silence_first_gap_s: d.silence_first_gap_s.trim(),
  silence_reminders: d.silence_reminders.trim(),
  silence_closing: d.silence_closing.trim(),
})

/** The contact with its fields in one fixed order: Postgres keeps jsonb keys in its own order, and drafts compare as JSON. */
const transferDraftOf = (c: TransferDraft): TransferDraft => ({
  id: c.id,
  name: c.name,
  number: c.number,
  condition: c.condition,
  hours_only: c.hours_only,
  ring_seconds: c.ring_seconds,
  if_no_answer: c.if_no_answer,
  enabled: c.enabled,
})

const wholeIn = (typed: string, min: number, max: number) => /^\d+$/.test(typed.trim()) && Number(typed) >= min && Number(typed) <= max

/** Why the silence settings cannot be saved, or null. */
export function silenceProblem(d: Pick<Draft, 'silence_first_gap_s' | 'silence_reminders' | 'silence_closing'>): string | null {
  if (!wholeIn(d.silence_first_gap_s, SILENCE_FIRST_GAP_MIN_S, SILENCE_FIRST_GAP_MAX_S)) return `The first wait is ${SILENCE_FIRST_GAP_MIN_S} to ${SILENCE_FIRST_GAP_MAX_S} seconds.`
  if (!wholeIn(d.silence_reminders, 0, SILENCE_REMINDERS_MAX)) return `Ask 0 to ${SILENCE_REMINDERS_MAX} times.`
  if (d.silence_closing.trim().length > SILENCE_CLOSING_MAX) return `The closing line is at most ${SILENCE_CLOSING_MAX} characters.`
  return null
}

/** The silence settings to save: the closing line is null when it is the default (or empty). */
export const silenceToSave = (d: Draft) => {
  const closing = d.silence_closing.trim()
  return {
    silence_first_gap_s: Number(d.silence_first_gap_s),
    silence_reminders: Number(d.silence_reminders),
    silence_closing: closing && closing !== DEFAULT_SILENCE_CLOSING ? closing : null,
  }
}

/** What the caller hears when the line stays silent, in words for the help line. */
export function silenceSummary(d: Pick<Draft, 'silence_first_gap_s' | 'silence_reminders'>): string {
  const gap = Number(d.silence_first_gap_s)
  const times = Number(d.silence_reminders)
  // Seconds of silence at each step: the first gap, then each wait twice the one before.
  const at: number[] = []
  for (let i = 0; i <= times; i++) at.push((at[i - 1] ?? 0) + gap * 2 ** i)
  const end = at.pop()!
  if (!times) return `After ${gap} seconds of silence the assistant says the closing line and hangs up. Never while a call is transferred.`
  return `Asks "Are you still there?" after ${at.join(', ')} seconds of silence, says the closing line and hangs up at ${end} seconds. Never while a call is transferred.`
}

/** What a new keypad menu starts with. */
export const DEFAULT_KEYPAD_OPTIONS: KeypadMenuOption[] = [
  { key: '1', label: 'emergencies', action: 'transfer' },
  { key: '2', label: 'everything else', action: 'topic' },
]

/** Why the keypad menu cannot be saved, or null (nothing to check while it is off). */
export function keypadProblem(d: Pick<Draft, 'keypad_on' | 'keypad_options'>): string | null {
  if (!d.keypad_on) return null
  if (!d.keypad_options.length) return 'Add at least one key to the keypad menu, or turn it off.'
  if (d.keypad_options.length > KEYPAD_MENU_MAX_OPTIONS) return `The keypad menu has at most ${KEYPAD_MENU_MAX_OPTIONS} keys.`
  if (d.keypad_options.some(o => !o.label.trim())) return 'Each key in the keypad menu needs a label.'
  if (new Set(d.keypad_options.map(o => o.key)).size !== d.keypad_options.length) return 'Each key can be used once in the keypad menu.'
  return null
}

/** The keypad menu to save: null when it is off. */
export const keypadToSave = (d: Draft) => ({
  keypad_menu: d.keypad_on ? { options: d.keypad_options.map(o => ({ ...o, label: o.label.trim() })) } : null,
})

/** The first key 1–9 the menu does not use yet; null when all are taken. */
export const nextFreeKey = (options: KeypadMenuOption[]): string | null =>
  ['1', '2', '3', '4', '5', '6', '7', '8', '9'].find(k => !options.some(o => o.key === k)) ?? null

/** "(503) 555-0199" and "+1 503 555 0199" are the same number: both show as the latter. */
function normalizedNumber(typed: string): string {
  const e164 = toE164(typed)
  return e164 ? formatNumber(e164) : typed.trim()
}

/** Why a transfer contact's number cannot be used, or null (empty is fine: the contact waits for one). */
export function numberProblem(typed: string): string | null {
  if (!typed.trim()) return null
  const e164 = toE164(typed)
  return e164 ? onCallNumberProblem(e164) : 'Enter a US number with its area code, like +1 503 555 0100.'
}

export type TransferField = 'name' | 'number' | 'condition'
/** What is wrong with a contact, and in which field; the first problem of the list, or null. */
export type TransferProblem = { index: number; field: TransferField; message: string }

export function transferProblem(d: Pick<Draft, 'transfers'>): TransferProblem | null {
  const names = new Set<string>()
  for (const [index, c] of d.transfers.entries()) {
    const name = c.name.trim()
    if (!name) return { index, field: 'name', message: 'Give the contact a name.' }
    if (name.length > TRANSFER_NAME_MAX) return { index, field: 'name', message: `At most ${TRANSFER_NAME_MAX} characters.` }
    if (names.has(name.toLowerCase())) return { index, field: 'name', message: `Another contact is called "${name}".` }
    names.add(name.toLowerCase())
    const number = numberProblem(c.number)
    if (number) return { index, field: 'number', message: number }
    if (!c.condition.trim()) return { index, field: 'condition', message: 'Say when calls go to this contact.' }
    if (c.condition.trim().length > TRANSFER_CONDITION_MAX)
      return { index, field: 'condition', message: `At most ${TRANSFER_CONDITION_MAX} characters.` }
  }
  return null
}

/** The transfer contacts to save. */
export const transfersToSave = (d: Pick<Draft, 'transfers'>): TransferContact[] =>
  d.transfers.map(c => ({ ...c, name: c.name.trim(), condition: c.condition.trim(), number: toE164(c.number) }))

/** Starting points for a new contact: blank, or someone for callers who ask for a person. */
export type TransferPreset = 'blank' | 'person'
const PRESETS: Record<TransferPreset, Pick<TransferDraft, 'name' | 'condition' | 'hours_only' | 'if_no_answer'>> = {
  blank: { name: '', condition: '', hours_only: false, if_no_answer: 'message' },
  person: { name: 'Owner', condition: 'The caller asks to speak to a person', hours_only: true, if_no_answer: 'message' },
}

/** A new contact from a preset, with an id and a name no other contact of the list has. */
export function newTransferContact(list: readonly TransferDraft[], preset: TransferPreset): TransferDraft {
  const ids = new Set(list.map(c => c.id))
  let n = list.length + 1
  while (ids.has(`tc_${n}`)) n++
  const base = PRESETS[preset]
  const taken = new Set(list.map(c => c.name.trim().toLowerCase()))
  let name = base.name
  for (let i = 2; name && taken.has(name.toLowerCase()); i++) name = `${base.name} ${i}`
  return { id: `tc_${n}`, number: '', ring_seconds: RING_SECONDS_DEFAULT, enabled: true, ...base, name }
}

export const canAddTransfer = (d: Pick<Draft, 'transfers'>) => d.transfers.length < TRANSFER_CONTACTS_MAX

/** The list with the contact at `index` moved one place up (-1) or down (+1). */
export function moveTransfer<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by
  if (to < 0 || to >= list.length) return [...list]
  const next = [...list]
  ;[next[index], next[to]] = [next[to]!, next[index]!]
  return next
}

/** Why a contact is not used on calls right now, in a few words; null when it is. */
export function transferInactive(c: Pick<TransferDraft, 'enabled' | 'number'>): string | null {
  if (!c.enabled) return 'Off'
  if (!c.number.trim()) return 'Add a number to turn it on'
  return null
}

/** Something to save: spaces around a value are not a change. */
export const isDirty = (draft: Draft, saved: Draft) => !same(normalized(draft), normalized(saved))

/** Unsaved drafts by assistant, kept while the page is closed so leaving it does not drop an edit. */
const kept = new Map<string, Draft>()
export const keptDraft = (assistantId: string) => kept.get(assistantId)
export function keepDraft(assistantId: string, draft: Draft | null) {
  if (draft) kept.set(assistantId, draft)
  else kept.delete(assistantId)
}

/** How long the greeting takes to say, as words for the help line. */
export function spokenLength(greeting: string): string {
  const words = greeting.trim().split(/\s+/).filter(Boolean).length
  if (!words) return 'nothing to say yet'
  const seconds = Math.max(1, Math.round(words / 2.5))
  return `about ${seconds} ${seconds === 1 ? 'second' : 'seconds'} spoken`
}



/** Why the draft cannot be saved yet, in words for the user; null when it can. */
export function draftProblem(draft: Draft): string | null {
  if (!draft.name.trim()) return 'The assistant needs a name.'
  if (!draft.greeting.trim()) return 'The greeting cannot be empty: it is the first thing callers hear.'
  const known = knownCallerGreetingProblem(draft.greeting_known_caller)
  if (known) return known
  const length = draft.instructions.trim().length
  if (length > INSTRUCTIONS_MAX) return `The instructions are too long: ${length.toLocaleString('en-US')} of ${INSTRUCTIONS_MAX.toLocaleString('en-US')} characters.`
  const rules = draft.call_rules.trim().length
  if (rules > CALL_RULES_MAX) return `How to handle calls is too long: ${rules.toLocaleString('en-US')} of ${CALL_RULES_MAX.toLocaleString('en-US')} characters.`
  return knowledgeProblem(normalized(draft)) ?? transferProblem(draft)?.message ?? silenceProblem(draft) ?? keypadProblem(draft) ?? languagesProblem(draft)
}

/** Why the services or FAQs cannot be saved; null when they can. Expects a normalized draft. */
export function knowledgeProblem(d: Pick<Draft, 'services' | 'faqs'>): string | null {
  if (d.services.length > SERVICES_MAX) return `At most ${SERVICES_MAX} services.`
  if (d.services.some(s => !s.name)) return 'Every service needs a name.'
  if (d.faqs.length > FAQS_MAX) return `At most ${FAQS_MAX} FAQs.`
  if (d.faqs.some(f => !f.q || !f.a)) return 'Every FAQ needs a question and an answer.'
  return null
}

/** The profile to save: the instructions replace the older fields they were folded from. Expects a normalized draft. */
export const profileOf = (d: Draft): BusinessProfile => ({
  instructions: d.instructions.trim(),
  service_list: d.services,
  faqs: d.faqs,
  ...(d.website ? { website: d.website } : {}),
})

/** The rules to save: null when they are the default (or empty), so a better default reaches this assistant later. */
export const callRulesToSave = (d: Draft): string | null => {
  const rules = d.call_rules.trim()
  return usesDefaultCallRules(rules) ? null : rules
}

export const isDefaultCallRules = (d: Draft) => callRulesToSave(d) === null

/** The outside-hours variants to save: null when empty (the same as during hours). */
export const outsideToSave = (d: Draft) => ({
  greeting_outside: d.greeting_outside.trim() || null,
})

/** The greeting still names the assistant by its saved name after a rename ("This is Maya" → Ava). */
export function staleGreetingName(greeting: string, savedName: string, name: string): string | null {
  const next = name.trim()
  if (!next || !savedName || next === savedName) return null
  return renameInGreeting(greeting, savedName, next) === greeting ? null : savedName
}
