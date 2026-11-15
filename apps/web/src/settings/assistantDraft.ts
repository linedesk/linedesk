// The editable copy of the assistant's settings: how it is read from the row, merged with
// changes that arrive through sync, checked and turned back into what assistant.update takes.
import {
  INSTRUCTIONS_MAX,
  RING_SECONDS_DEFAULT,
  TRANSFER_CONDITION_MAX,
  TRANSFER_CONTACTS_MAX,
  TRANSFER_NAME_MAX,
  onCallNumberProblem,
  type OutboundCountries,
  outboundNumberProblem,
  phoneNumberProblem,
  DEFAULT_SILENCE_CLOSING,
  DEFAULT_SILENCE_REMINDER,
  localizedDefault,
  talkingSpeedPctOf,
  SILENCE_CLOSING_MAX,
  SILENCE_FIRST_GAP_MAX_S,
  SILENCE_FIRST_GAP_MIN_S,
  SILENCE_REMINDERS_MAX,
  SILENCE_FIRST_GAP_DEFAULT_S,
  SILENCE_REMINDERS_DEFAULT,
  SILENCE_HANG_UP_DEFAULT_S,
  SILENCE_HANG_UP_MAX_S,
  ASSISTANT_CALL_MAX_MINUTES,
  BEHAVIOURS,
  type BehaviourId,
  behaviourOn,
  type AiDisclosure,
  DEFAULT_AI_DISCLOSURE,
  type CommunicationStyle,
  DEFAULT_COMMUNICATION_STYLE,
  type AssistantLanguages,
  ENGLISH_ONLY,
  type Language,
  languageCodes,
  LANGUAGES,
  mainLanguageOf,
  swapDefault,
  type VoicePipeline,
} from '@linedesk/actions'
import type { Assistant, BusinessProfile, TransferContact } from '@linedesk/db/types'
import { formatNumber, outboundE164, renameInGreeting } from '../onboarding/flow.ts'

/** `greeting_outside`: used outside business hours; empty = the same as during hours. */
export type Draft = {
  name: string
  greeting: string
  /** Whether and when the assistant mentions it is an AI. */
  ai_disclosure: AiDisclosure
  /** The tone it uses. */
  communication_style: CommunicationStyle
  instructions: string
  greeting_outside: string
  /** Warm transfer: who callers are put through to, and when, in order. */
  transfers: TransferDraft[]
  /** The voice: provider and voice id (empty: the provider's default). */
  voice: { provider: string; voice_id: string }
  /** The website the About text was last drafted from. */
  website: string
  /** Silence on the line, as typed: seconds before the first "Are you still there?", how many, the closing line. */
  silence_first_gap_s: string
  silence_reminders: string
  silence_hang_up_s: string
  /** The longest the assistant stays on a call, in minutes, as typed. */
  max_call_minutes: string
  silence_closing: string
  /** Asked when the line is quiet; the default (in the main language) is saved as null. */
  silence_reminder: string
  /** How fast the assistant talks, in percent of the voice's own pace. */
  talking_speed_pct: number
  /** The behaviour checklist, every switch with its value (the default where the owner set none). */
  behaviours: Record<BehaviourId, boolean>
  /** Languages besides English; the picked ones are kept while English only is chosen, but saved empty. */
  languages: AssistantLanguages
  /** How calls are answered; null: the install default (the realtime model when one is set up). */
  voice_pipeline: VoicePipeline | null
}

/** A transfer contact as edited: the number as typed (saved as E.164, empty: none yet). */
export type TransferDraft = Omit<TransferContact, 'number'> & { number: string }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const line = (label: string, value?: string) => (value?.trim() ? `${label}: ${value.trim()}` : null)

/**
 * The older structured fields as one text, in the shape the assistant used to read them.
 * Shown once for an assistant that has no instructions yet, so nothing it knew is lost.
 */
export function foldProfile(p: BusinessProfile): string {
  return [
    line('About', p.description),
    line('Services', p.services?.filter(s => s.trim()).join(', ')),
    line('Service area', p.service_area),
    line('Address', p.address),
    line('Hours', p.hours),
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * `workspaceLanguage`: the workspace language (Workspace settings › General). An assistant without a main language of
 * its own speaks it when calls can be answered in it, as the voice agent does: shown as its main language, with the
 * default greeting and closing line in it.
 */
export function draftOf(a: Assistant, workspaceLanguage?: string | null): Draft {
  const p = a.business_profile
  const main = mainLanguageOf(a.languages, workspaceLanguage)
  const inherited = !a.languages?.main && main !== 'en'
  const local = (text: string) => (inherited && text.trim() ? swapDefault(text, 'en', main) : text)
  // Same rule as the voice agent: empty instructions mean the older fields still apply, so show those.
  return {
    name: a.name,
    greeting: local(a.greeting),
    ai_disclosure: a.ai_disclosure ?? (a.disclose_ai ? 'at_start' : DEFAULT_AI_DISCLOSURE),
    communication_style: a.communication_style ?? DEFAULT_COMMUNICATION_STYLE,
    instructions: p.instructions?.trim() ? p.instructions : foldProfile(p),
    greeting_outside: local(a.greeting_outside ?? ''),
    transfers: (a.transfers ?? []).map(c => transferDraftOf({ ...c, number: c.number ? formatNumber(c.number) : '' })),
    voice: { provider: a.voice.provider, voice_id: a.voice.voice_id },
    website: p.website ?? '',
    // A row synced before these columns existed has none: the defaults.
    silence_first_gap_s: String(a.silence_first_gap_s ?? SILENCE_FIRST_GAP_DEFAULT_S),
    silence_reminders: String(a.silence_reminders ?? SILENCE_REMINDERS_DEFAULT),
    silence_hang_up_s: String(a.silence_hang_up_s ?? SILENCE_HANG_UP_DEFAULT_S),
    max_call_minutes: String(a.max_call_minutes ?? ASSISTANT_CALL_MAX_MINUTES),
    // None stored: the default line, shown so it can be edited.
    silence_closing: local(a.silence_closing ?? DEFAULT_SILENCE_CLOSING),
    silence_reminder: a.silence_reminder ?? localizedDefault(DEFAULT_SILENCE_REMINDER, main),
    talking_speed_pct: talkingSpeedPctOf(a),
    behaviours: behavioursOf(a.behaviours),
    languages: languagesOf(a.languages, workspaceLanguage),
    // A row synced before the column existed has none: the install default.
    voice_pipeline: a.voice_pipeline ?? null,
  }
}

/** Every switch of the checklist, in list order: the stored choice or the default. */
const behavioursOf = (stored: Assistant['behaviours'] | undefined) =>
  Object.fromEntries(BEHAVIOURS.map(b => [b.id, behaviourOn(stored, b.id)])) as Record<BehaviourId, boolean>

/** Only the switches that differ from their default are stored, so a better default reaches the others. */
export const behavioursToSave = (d: Pick<Draft, 'behaviours'>): Partial<Record<BehaviourId, boolean>> =>
  Object.fromEntries(BEHAVIOURS.filter(b => d.behaviours[b.id] !== b.on).map(b => [b.id, d.behaviours[b.id]]))

/**
 * The stored setting with only known codes; without a main language, the workspace language when calls can be
 * answered in it. A row synced before the column existed: the main language only.
 */
function languagesOf(stored: Assistant['languages'] | undefined, workspaceLanguage?: string | null): AssistantLanguages {
  if (!stored) return { ...ENGLISH_ONLY, main: mainLanguageOf(null, workspaceLanguage) }
  return {
    main: mainLanguageOf(stored, workspaceLanguage),
    mode: stored.mode,
    allowed: languageCodes.filter(code => stored.allowed.includes(code)),
  }
}

export const mainOf = (d: Pick<Draft, 'languages'>): Language => d.languages.main ?? 'en'
/** The languages picked besides the main one. */
export const pickedOthers = (d: Pick<Draft, 'languages'>): Language[] =>
  d.languages.allowed.filter(code => code !== mainOf(d))

/** Why the languages cannot be saved, or null. */
export function languagesProblem(d: Pick<Draft, 'languages'>): string | null {
  return d.languages.mode === 'allowed' && !pickedOthers(d).length
    ? `Pick at least one language besides ${LANGUAGES[mainOf(d)]}, or choose None.`
    : null
}

/** What assistant.update takes: no list unless the allow-list is used, never the main language in it. */
export const languagesToSave = (d: Draft) => ({
  languages: {
    main: mainOf(d),
    mode: d.languages.mode,
    allowed: d.languages.mode === 'allowed' ? pickedOthers(d) : [],
  },
})

/**
 * The draft with another main language: texts that are still the old language's default (greetings, the
 * closing line) become the new one's; texts the owner wrote stay.
 */
export function withMainLanguage(d: Draft, main: Language): Draft {
  const from = mainOf(d)
  const swap = (text: string) => (text.trim() ? swapDefault(text, from, main) : text)
  return {
    ...d,
    languages: { ...d.languages, main },
    greeting: swap(d.greeting),
    greeting_outside: swap(d.greeting_outside),
    silence_closing: swap(d.silence_closing),
    silence_reminder: swap(d.silence_reminder),
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
  greeting_outside: d.greeting_outside.trim(),
  transfers: d.transfers.map(c =>
    transferDraftOf({ ...c, name: c.name.trim(), condition: c.condition.trim(), number: normalizedNumber(c.number) }),
  ),
  website: d.website.trim(),
  silence_first_gap_s: d.silence_first_gap_s.trim(),
  silence_reminders: d.silence_reminders.trim(),
  silence_hang_up_s: d.silence_hang_up_s.trim(),
  max_call_minutes: d.max_call_minutes.trim(),
  silence_closing: d.silence_closing.trim(),
  silence_reminder: d.silence_reminder.trim(),
  // As saved: no picked languages unless "These languages", so switching back to None is clean after Save.
  languages: languagesToSave(d).languages,
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

const wholeIn = (typed: string, min: number, max: number) =>
  /^\d+$/.test(typed.trim()) && Number(typed) >= min && Number(typed) <= max

/** Why the silence settings cannot be saved, or null. */
export function silenceProblem(
  d: Pick<
    Draft,
    | 'silence_first_gap_s'
    | 'silence_reminders'
    | 'silence_hang_up_s'
    | 'max_call_minutes'
    | 'silence_closing'
    | 'silence_reminder'
  >,
): string | null {
  if (!wholeIn(d.silence_first_gap_s, SILENCE_FIRST_GAP_MIN_S, SILENCE_FIRST_GAP_MAX_S))
    return `The first wait is ${SILENCE_FIRST_GAP_MIN_S} to ${SILENCE_FIRST_GAP_MAX_S} seconds.`
  if (!wholeIn(d.silence_reminders, 0, SILENCE_REMINDERS_MAX)) return `Ask 0 to ${SILENCE_REMINDERS_MAX} times.`
  const lastAsk = Number(d.silence_first_gap_s) * Number(d.silence_reminders)
  if (!wholeIn(d.silence_hang_up_s, SILENCE_FIRST_GAP_MIN_S, SILENCE_HANG_UP_MAX_S))
    return `Hang up after ${SILENCE_FIRST_GAP_MIN_S} to ${SILENCE_HANG_UP_MAX_S} seconds.`
  if (Number(d.silence_hang_up_s) <= lastAsk) return `Hang up after the last question: more than ${lastAsk} seconds.`
  if (!wholeIn(d.max_call_minutes, 1, ASSISTANT_CALL_MAX_MINUTES))
    return `The longest call is 1 to ${ASSISTANT_CALL_MAX_MINUTES} minutes.`
  if (d.silence_reminder.trim().length > SILENCE_CLOSING_MAX)
    return `The reminder is at most ${SILENCE_CLOSING_MAX} characters.`
  if (d.silence_closing.trim().length > SILENCE_CLOSING_MAX)
    return `The closing line is at most ${SILENCE_CLOSING_MAX} characters.`
  return null
}

/**
 * The silence settings to save: the closing line is null when it is the default (or empty); the reminder too, also
 * when it is the main language's default, so a call says it in the language spoken at that moment.
 */
export const silenceToSave = (d: Draft) => {
  const closing = d.silence_closing.trim()
  const reminder = d.silence_reminder.trim()
  const defaultReminder =
    reminder === DEFAULT_SILENCE_REMINDER || reminder === localizedDefault(DEFAULT_SILENCE_REMINDER, mainOf(d))
  return {
    silence_first_gap_s: Number(d.silence_first_gap_s),
    silence_reminders: Number(d.silence_reminders),
    silence_hang_up_s: Number(d.silence_hang_up_s),
    max_call_minutes: Number(d.max_call_minutes),
    silence_reminder: reminder && !defaultReminder ? reminder : null,
    silence_closing: closing && closing !== DEFAULT_SILENCE_CLOSING ? closing : null,
  }
}

/** When the assistant asks whether the caller is still there, in words for the help line. */
export function silenceSummary(
  d: Pick<Draft, 'silence_first_gap_s' | 'silence_reminders' | 'silence_reminder'>,
): string {
  const gap = Number(d.silence_first_gap_s)
  const asks = Array.from({ length: Number(d.silence_reminders) }, (_, i) => gap * (i + 1))
  if (!asks.length) return 'Never asks: it only hangs up after the silence below.'
  const when = asks.length > 1 ? `${asks.slice(0, -1).join(', ')} and ${asks.at(-1)}` : `${asks[0]}`
  return `Asks "${d.silence_reminder.trim() || DEFAULT_SILENCE_REMINDER}" after ${when} seconds of silence. Never while a call is transferred.`
}

/** When the assistant ends a call itself, in words for the help line. */
export function hangUpSummary(d: Pick<Draft, 'silence_hang_up_s' | 'max_call_minutes'>): string {
  return `Says this and hangs up at ${Number(d.silence_hang_up_s)} seconds of silence. At ${Number(d.max_call_minutes)} minutes it says goodbye and hangs up. A call put through to a person goes on.`
}

/** "(503) 555-0199" and "+1 503 555 0199" are the same number: both show as the latter. */
function normalizedNumber(typed: string): string {
  const e164 = outboundE164(typed)
  return e164 ? formatNumber(e164) : typed.trim()
}

/**
 * Why a transfer contact's number cannot be used, or null (empty is fine: the contact waits for one). `countries`: the
 * ones the workspace may call (outbound.countries); `any` until it has a number (the server checks the dial).
 */
export function numberProblem(typed: string, countries: OutboundCountries = 'any'): string | null {
  if (!typed.trim()) return null
  const e164 = outboundE164(typed)
  if (e164) return onCallNumberProblem(e164, countries)
  // The phone field's value (E.164 as typed): an unfinished number says so for its country.
  const unfinished = typed.trim().startsWith('+') ? phoneNumberProblem(typed) : null
  return unfinished ?? 'Enter the number with its country code and area code, like +1 503 555 0100.'
}

/** Whether the contact's number is refused only for its country: shown at once, also on a contact saved earlier. */
export const refusedForCountry = (typed: string, countries: OutboundCountries) => {
  const e164 = outboundE164(typed)
  return !!e164 && outboundNumberProblem(e164, countries)?.reason === 'country'
}

export type TransferField = 'name' | 'number' | 'condition'
/** What is wrong with a contact, and in which field; the first problem of the list, or null. */
export type TransferProblem = { index: number; field: TransferField; message: string }

export function transferProblem(
  d: Pick<Draft, 'transfers'>,
  countries: OutboundCountries = 'any',
): TransferProblem | null {
  const names = new Set<string>()
  for (const [index, c] of d.transfers.entries()) {
    const name = c.name.trim()
    if (!name) return { index, field: 'name', message: 'Give the contact a name.' }
    if (name.length > TRANSFER_NAME_MAX)
      return { index, field: 'name', message: `At most ${TRANSFER_NAME_MAX} characters.` }
    if (names.has(name.toLowerCase())) return { index, field: 'name', message: `Another contact is called "${name}".` }
    names.add(name.toLowerCase())
    const number = numberProblem(c.number, countries)
    if (number) return { index, field: 'number', message: number }
    if (!c.condition.trim()) return { index, field: 'condition', message: 'Say when calls go to this contact.' }
    if (c.condition.trim().length > TRANSFER_CONDITION_MAX)
      return { index, field: 'condition', message: `At most ${TRANSFER_CONDITION_MAX} characters.` }
  }
  return null
}

/** The transfer contacts to save. */
export const transfersToSave = (d: Pick<Draft, 'transfers'>): TransferContact[] =>
  d.transfers.map(c => ({ ...c, name: c.name.trim(), condition: c.condition.trim(), number: outboundE164(c.number) }))

/** Starting points for a new contact: blank, or someone for callers who ask for a person. */
export type TransferPreset = 'blank' | 'person'
const PRESETS: Record<TransferPreset, Pick<TransferDraft, 'name' | 'condition' | 'hours_only' | 'if_no_answer'>> = {
  blank: { name: '', condition: '', hours_only: false, if_no_answer: 'message' },
  person: {
    name: 'Owner',
    condition: 'The caller asks to speak to a person',
    hours_only: true,
    if_no_answer: 'message',
  },
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
  if (!c.number.trim()) return 'Add a number to use it'
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

export const ASSISTANT_NAME_MAX = 60

/** Why the assistant's name cannot be saved, in words for the user; null when it can. */
export function nameProblem(name: string): string | null {
  if (!name.trim()) return 'Enter a name. Callers hear it.'
  return name.trim().length > ASSISTANT_NAME_MAX ? `At most ${ASSISTANT_NAME_MAX} characters.` : null
}

/** Why the draft cannot be saved yet, in words for the user; null when it can. */
export function draftProblem(draft: Draft, countries: OutboundCountries = 'any'): string | null {
  const name = nameProblem(draft.name)
  if (name) return name
  if (!draft.greeting.trim()) return 'The greeting cannot be empty: it is the first thing callers hear.'
  const length = draft.instructions.trim().length
  if (length > INSTRUCTIONS_MAX)
    return `The instructions are too long: ${length.toLocaleString('en-US')} of ${INSTRUCTIONS_MAX.toLocaleString('en-US')} characters.`
  return transferProblem(draft, countries)?.message ?? silenceProblem(draft) ?? languagesProblem(draft)
}

/** The profile to save: the instructions replace the older fields they were folded from. Expects a normalized draft. */
export const profileOf = (d: Draft): BusinessProfile => ({
  instructions: d.instructions.trim(),
  ...(d.website ? { website: d.website } : {}),
})

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
