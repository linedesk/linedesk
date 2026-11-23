// The call's key facts (calls.fields) that fill an empty field of the caller's contact: the call view's side panel
// shows them in that field with "From this call · Keep" (LIN-766), the contact page with "From the call on <date> ·
// Keep" (the newest of the contact's calls that has one). The labels come from the after-call summary, in English or in
// the workspace's language, so a fact matches by its label (English or the field's own label in the UI language);
// an email also matches by its value.
import type { Call, CallField, Contact } from '@linedesk/db/types'
import { i18n } from '../i18n/index.tsx'

export type SuggestedField = 'address' | 'email' | 'company'
export type FactSuggestions = Partial<Record<SuggestedField, string>>

const normal = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** The summary's English labels for each field: matched against data, never shown. */
const ENGLISH: Record<SuggestedField, readonly string[]> = {
  address: ['address', 'service address', 'street address', 'home address'],
  email: ['email', 'e mail', 'email address'],
  company: ['company', 'company name', 'business', 'business name'],
}
const OWN_LABEL = {
  address: 'call.contact.address',
  email: 'call.contact.email',
  company: 'call.contact.company',
} as const satisfies Record<SuggestedField, string>
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function fieldOf(fact: CallField): SuggestedField | null {
  const label = normal(fact.label)
  for (const field of Object.keys(ENGLISH) as SuggestedField[])
    if (ENGLISH[field].includes(label) || label === normal(i18n().t(OWN_LABEL[field]))) return field
  return EMAIL.test(fact.value.trim()) ? 'email' : null
}

/** The first fact for each field the contact has empty; an email only when it looks like one. */
export function factSuggestions(fields: readonly CallField[], contact: Pick<Contact, SuggestedField>): FactSuggestions {
  const out: FactSuggestions = {}
  for (const fact of fields) {
    const value = fact.value.trim()
    const field = value ? fieldOf(fact) : null
    if (!field || out[field] || contact[field]?.trim()) continue
    if (field === 'email' && !EMAIL.test(value)) continue
    out[field] = value
  }
  return out
}

/** A suggestion from one of the contact's calls, with the call it came from. */
export type CallFactSuggestions = Partial<Record<SuggestedField, { value: string; call: Call }>>

/** For each field the contact has empty, the fact of the newest call that has one (`calls` newest first). */
export function callsFactSuggestions(
  calls: readonly Call[],
  contact: Pick<Contact, SuggestedField>,
): CallFactSuggestions {
  const out: CallFactSuggestions = {}
  for (const call of calls)
    for (const [field, value] of Object.entries(factSuggestions(call.fields, contact)) as [SuggestedField, string][])
      out[field] ??= { value, call }
  return out
}

/**
 * The fields that fold into one "+ Company, email" button: empty on the contact and with no suggestion from a call,
 * in the order given. Both contact views fold the same way; `fields` says which of their fields may fold.
 */
export function foldedFields<F extends string>(
  fields: readonly F[],
  contact: Partial<Record<F, string | null>>,
  suggested: Partial<Record<string, unknown>>,
): F[] {
  return fields.filter(field => !contact[field]?.trim() && !suggested[field])
}
