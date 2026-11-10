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

export const isDirty = (draft: Draft, saved: Draft) => !same(draft, saved)

/** Why the draft cannot be saved yet, in words for the user; null when it can. */
export function draftProblem(draft: Draft): string | null {
  if (!draft.name.trim()) return 'The assistant needs a name.'
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
