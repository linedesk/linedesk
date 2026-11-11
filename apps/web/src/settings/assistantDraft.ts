// The editable copy of the assistant's settings: how it is read from the row, merged with
// changes that arrive through sync, checked and turned back into what assistant.update takes.
import {
  CALL_RULES_MAX, DEFAULT_CALL_RULES, INSTRUCTIONS_MAX, callRulesOf, onCallNumberProblem,
  DEFAULT_SILENCE_CLOSING, SILENCE_CLOSING_MAX, SILENCE_FIRST_GAP_MAX_S, SILENCE_FIRST_GAP_MIN_S, SILENCE_REMINDERS_MAX,
  SILENCE_FIRST_GAP_DEFAULT_S, SILENCE_REMINDERS_DEFAULT, KEYPAD_MENU_MAX_OPTIONS,
} from '@linedesk/actions'
import type { Assistant, BusinessProfile, KeypadMenuOption } from '@linedesk/db/types'
import { formatNumber, renameInGreeting, toE164 } from '../onboarding/flow.ts'

/** `greeting_outside` and `instructions_outside`: used outside business hours; empty = the same as during hours. */
export type Draft = {
  name: string
  greeting: string
  disclose_ai: boolean
  /** Greet a caller whose number matches a contact with a name by first name. */
  greet_by_name: boolean
  instructions: string
  call_rules: string
  greeting_outside: string
  instructions_outside: string
  /** Warm transfer: urgent calls go to the on-call number (as typed; saved as E.164). */
  transfer_urgent: boolean
  transfer_number: string
  transfer_hours_only: boolean
  /** Keypad menu after the greeting; the options are kept while it is off, but only saved when on. */
  keypad_on: boolean
  keypad_options: KeypadMenuOption[]
  /** The voice: provider and voice id (empty: the provider's default). */
  voice: { provider: string; voice_id: string }
  /** Silence on the line, as typed: seconds before the first "Are you still there?", how many, the closing line. */
  silence_first_gap_s: string
  silence_reminders: string
  silence_closing: string
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const line = (label: string, value?: string) => (value?.trim() ? `${label}: ${value.trim()}` : null)

/**
 * The older structured fields as one text, in the shape the assistant used to read them.
 * Shown once for an assistant that has no instructions yet, so nothing it knew is lost.
 */
export function foldProfile(p: BusinessProfile): string {
  const faqs = (p.faqs ?? []).filter(f => f.q.trim() && f.a.trim()).map(f => `Q: ${f.q.trim()}\nA: ${f.a.trim()}`).join('\n')
  return [
    line('About', p.description),
    line('Services', p.services?.filter(s => s.trim()).join(', ')),
    line('Service area', p.service_area),
    line('Address', p.address),
    line('Hours', p.hours),
    faqs ? `Frequently asked questions:\n${faqs}` : null,
  ].filter(Boolean).join('\n')
}

export function draftOf(a: Assistant): Draft {
  const p = a.business_profile
  // Same rule as the voice agent: empty instructions mean the older fields still apply, so show those.
  return {
    name: a.name, greeting: a.greeting, disclose_ai: a.disclose_ai, greet_by_name: a.greet_by_name, instructions: p.instructions?.trim() ? p.instructions : foldProfile(p),
    call_rules: callRulesOf(a.call_rules), // none stored: the default rules, shown so they can be edited
    greeting_outside: a.greeting_outside ?? '',
    instructions_outside: a.instructions_outside ?? '',
    transfer_urgent: a.transfer_urgent,
    transfer_number: a.transfer_number ? formatNumber(a.transfer_number) : '',
    transfer_hours_only: a.transfer_hours_only,
    keypad_on: !!a.keypad_menu?.options?.length,
    keypad_options: a.keypad_menu?.options?.length ? a.keypad_menu.options.map(o => ({ ...o })) : DEFAULT_KEYPAD_OPTIONS,
    voice: { provider: a.voice.provider, voice_id: a.voice.voice_id },
    // A row synced before these columns existed has none: the defaults.
    silence_first_gap_s: String(a.silence_first_gap_s ?? SILENCE_FIRST_GAP_DEFAULT_S),
    silence_reminders: String(a.silence_reminders ?? SILENCE_REMINDERS_DEFAULT),
    // None stored: the default line, shown so it can be edited (like the call rules).
    silence_closing: a.silence_closing ?? DEFAULT_SILENCE_CLOSING,
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
  instructions_outside: d.instructions_outside.trim(),
  transfer_number: normalizedNumber(d.transfer_number),
  keypad_options: d.keypad_options.map(o => ({ ...o, label: o.label.trim() })),
  silence_first_gap_s: d.silence_first_gap_s.trim(),
  silence_reminders: d.silence_reminders.trim(),
  silence_closing: d.silence_closing.trim(),
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

/** Why the on-call number cannot be used, or null (an empty number is fine while transfer is off). */
export function onCallProblem(d: Pick<Draft, 'transfer_urgent' | 'transfer_number'>): string | null {
  const typed = d.transfer_number.trim()
  if (!typed) return d.transfer_urgent ? 'Add the on-call number urgent calls go to.' : null
  const e164 = toE164(typed)
  return e164 ? onCallNumberProblem(e164) : 'Enter a US number with its area code, like +1 503 555 0100.'
}

/** The transfer settings to save. */
export const transferToSave = (d: Draft) => ({
  transfer_urgent: d.transfer_urgent,
  transfer_number: toE164(d.transfer_number),
  transfer_hours_only: d.transfer_hours_only,
})

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

const DISCLOSURE = /,?\s*(?:the|an|your|a)\s+(?:virtual|AI)\s+assistant\b/i
export const disclosesAi = (greeting: string) => DISCLOSURE.test(greeting)

/** The greeting with "…, the AI assistant" after the assistant's name, or a sentence that says it. */
export function withDisclosure(greeting: string, name: string): string {
  if (disclosesAi(greeting)) return greeting
  const who = name.trim() || 'the assistant'
  const named = new RegExp(`(\\bthis is ${who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i')
  if (named.test(greeting)) return greeting.replace(named, '$1, the AI assistant')
  const sentence = `This is ${who}, the AI assistant.`
  const firstEnd = greeting.search(/[.!?]\s/)
  if (firstEnd < 0) return greeting.trim() ? `${greeting.trim()} ${sentence}` : sentence
  return `${greeting.slice(0, firstEnd + 1)} ${sentence}${greeting.slice(firstEnd + 1)}`
}

/** The greeting without the AI disclosure. */
export const withoutDisclosure = (greeting: string) => greeting.replace(DISCLOSURE, '')

/** Why the draft cannot be saved yet, in words for the user; null when it can. */
export function draftProblem(draft: Draft): string | null {
  if (!draft.name.trim()) return 'The assistant needs a name.'
  if (!draft.greeting.trim()) return 'The greeting cannot be empty: it is the first thing callers hear.'
  const length = Math.max(draft.instructions.trim().length, draft.instructions_outside.trim().length)
  if (length > INSTRUCTIONS_MAX) return `The instructions are too long: ${length.toLocaleString('en-US')} of ${INSTRUCTIONS_MAX.toLocaleString('en-US')} characters.`
  const rules = draft.call_rules.trim().length
  if (rules > CALL_RULES_MAX) return `How to handle calls is too long: ${rules.toLocaleString('en-US')} of ${CALL_RULES_MAX.toLocaleString('en-US')} characters.`
  return onCallProblem(draft) ?? silenceProblem(draft) ?? keypadProblem(draft)
}

/** The profile to save: the instructions replace the older fields they were folded from. */
export const profileOf = (d: Draft): BusinessProfile => ({ instructions: d.instructions.trim() })

/** The rules to save: null when they are the default (or empty), so a better default reaches this assistant later. */
export const callRulesToSave = (d: Draft): string | null => {
  const rules = d.call_rules.trim()
  return rules && rules !== DEFAULT_CALL_RULES ? rules : null
}

export const isDefaultCallRules = (d: Draft) => callRulesToSave(d) === null

/** The outside-hours variants to save: null when empty (the same as during hours). */
export const outsideToSave = (d: Draft) => ({
  greeting_outside: d.greeting_outside.trim() || null,
  instructions_outside: d.instructions_outside.trim() || null,
})

/** The greeting still names the assistant by its saved name after a rename ("This is Maya" → Ava). */
export function staleGreetingName(greeting: string, savedName: string, name: string): string | null {
  const next = name.trim()
  if (!next || !savedName || next === savedName) return null
  return renameInGreeting(greeting, savedName, next) === greeting ? null : savedName
}
