// The editable copy of the assistant's settings: how it is read from the row, merged with
// changes that arrive through sync, checked and turned back into what assistant.update takes.
import type { Assistant, BusinessProfile } from '@callfront/db/types'

export type Faq = { q: string; a: string }
export type Draft = { name: string; greeting: string; disclose_ai: boolean; description: string; services: string[]; service_area: string; hours: string; faqs: Faq[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function draftOf(a: Assistant): Draft {
  const p = a.business_profile
  return {
    name: a.name, greeting: a.greeting, disclose_ai: a.disclose_ai, description: p.description ?? '',
    services: p.services ?? [], service_area: p.service_area ?? '', hours: p.hours ?? '', faqs: p.faqs ?? [],
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

/** What would be saved: trimmed, without empty services and empty questions. */
export function normalized(d: Draft): Draft {
  return {
    ...d, name: d.name.trim(), greeting: d.greeting.trim(), description: d.description.trim(), service_area: d.service_area.trim(), hours: d.hours.trim(),
    services: d.services.map(s => s.trim()).filter(Boolean),
    faqs: d.faqs.map(f => ({ q: f.q.trim(), a: f.a.trim() })).filter(f => f.q || f.a),
  }
}

/** Something to save: spaces around a value or an empty row added are not a change. */
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
  const half = draft.faqs.find(f => !!f.q.trim() !== !!f.a.trim())
  if (half) return half.q.trim() ? `Add an answer to “${half.q.trim()}” or remove the question.` : 'One answer has no question. Add the question or remove it.'
  return null
}

/** The profile to save: trimmed, without empty list entries, keeping fields this page does not edit. */
export function profileOf(d: Draft, current: BusinessProfile): BusinessProfile {
  return {
    ...current,
    description: d.description.trim(), service_area: d.service_area.trim(), hours: d.hours.trim(),
    services: d.services.map(s => s.trim()).filter(Boolean),
    faqs: d.faqs.map(f => ({ q: f.q.trim(), a: f.a.trim() })).filter(f => f.q && f.a),
  }
}
