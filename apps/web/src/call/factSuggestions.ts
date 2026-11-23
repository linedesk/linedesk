// The call's key facts (calls.fields) that fill an empty field of the caller's contact: the side panel shows them in
// that field with "From this call · Keep" (LIN-766). The labels come from the after-call summary, in English or in
// the workspace's language, so a fact matches by its label (English or the field's own label in the UI language);
// an email also matches by its value.
import type { CallField, Contact } from '@linedesk/db/types'
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
