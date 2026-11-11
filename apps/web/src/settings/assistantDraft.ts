// The editable copy of the assistant's settings: how it is read from the row, merged with
// changes that arrive through sync, checked and turned back into what assistant.update takes.
import { CALL_RULES_MAX, DEFAULT_CALL_RULES, INSTRUCTIONS_MAX, callRulesOf } from '@linedesk/actions'
import type { Assistant, BusinessProfile } from '@linedesk/db/types'
import { renameInGreeting } from '../onboarding/flow.ts'

/** `greeting_outside` and `instructions_outside`: used outside business hours; empty = the same as during hours. */
export type Draft = {
  name: string
  greeting: string
  disclose_ai: boolean
  instructions: string
  call_rules: string
  greeting_outside: string
  instructions_outside: string
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
    name: a.name, greeting: a.greeting, disclose_ai: a.disclose_ai, instructions: p.instructions?.trim() ? p.instructions : foldProfile(p),
    call_rules: callRulesOf(a.call_rules), // none stored: the default rules, shown so they can be edited
    greeting_outside: a.greeting_outside ?? '',
    instructions_outside: a.instructions_outside ?? '',
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
  return null
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
