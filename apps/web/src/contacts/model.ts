// The Contacts list is derived from the synced contacts and calls: who called, how often, when last and about what.
import { CONTACT_IMPORT_LIMITS } from '@linedesk/actions'
import type { Call, Contact } from '@linedesk/db/types'
import { formatPhone } from '../inbox-model.ts'
import { toE164 } from '../onboarding/flow.ts'
import { parseTs } from '../time.ts'

export type ContactRow = {
  contact: Contact
  /** The contact's calls, newest first (deleted calls left out). */
  calls: Call[]
  lastCall: Call | undefined
  /** The first open next step of the newest call that is not done yet. */
  nextStep: string | null
}

const startedMs = (call: Call) => parseTs(call.started_at).getTime()

export const contactLabel = (contact: Contact) => contact.name || formatPhone(contact.phone)

function nextStepOf(calls: Call[]): string | null {
  const open = calls.find(c => c.inbox_state === 'open')
  return open?.action_items.find(i => !i.done)?.text ?? null
}

/** Every contact with its calls, sorted by the most recent call that was about something (numbers that only hung up
 * come after them), then by the most recent call; contacts without calls come last, newest first. */
export function contactRows(contacts: Iterable<Contact>, calls: Iterable<Call>): ContactRow[] {
  const byContact = new Map<string, Call[]>()
  for (const call of calls) {
    if (!call.contact_id || call.deleted_at) continue
    const list = byContact.get(call.contact_id) ?? []
    list.push(call)
    byContact.set(call.contact_id, list)
  }
  const rows = [...contacts]
    .filter(contact => !contact.deleted_at)
    .map(contact => {
      const own = (byContact.get(contact.id) ?? []).sort((a, b) => startedMs(b) - startedMs(a))
      return { contact, calls: own, lastCall: own[0], nextStep: nextStepOf(own) }
    })
  return rows.sort(byRecentCall)
}

/** The newest call that was about something: hang-ups alone do not lift a contact to the top. */
const lastMeaningful = (row: ContactRow) => row.calls.find(c => c.outcome !== 'hangup')

function byRecentCall(a: ContactRow, b: ContactRow): number {
  const ma = lastMeaningful(a),
    mb = lastMeaningful(b)
  if (ma && mb) return startedMs(mb) - startedMs(ma)
  if (ma || mb) return ma ? -1 : 1
  if (a.lastCall && b.lastCall) return startedMs(b.lastCall) - startedMs(a.lastCall)
  if (a.lastCall || b.lastCall) return a.lastCall ? -1 : 1
  return parseTs(b.contact.created_at).getTime() - parseTs(a.contact.created_at).getTime()
}

const digitsOf = (text: string) => text.replace(/\D/g, '')
/** Queries made only of digits and phone punctuation also match the number with its formatting ignored. */
const PHONE_QUERY = /^[\d\s()+.-]+$/

/** Search over name, company, email and phone (digits only, so "503-555" finds +1 503 555 0142). */
export function matchesContact(contact: Contact, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const text = [contact.name, contact.company, contact.email, contact.phone, formatPhone(contact.phone)]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  if (text.includes(q)) return true
  const digits = digitsOf(q)
  return PHONE_QUERY.test(q) && digits.length > 0 && digitsOf(contact.phone).includes(digits)
}

export function filterContactRows(rows: ContactRow[], query: string): ContactRow[] {
  return query.trim() ? rows.filter(row => matchesContact(row.contact, query)) : rows
}

/** The fields a merge picks from either contact. */
export const MERGE_FIELDS = ['name', 'company', 'email', 'address', 'note'] as const
export type MergeField = (typeof MERGE_FIELDS)[number]

const emailKey = (email: string | null) => email?.trim().toLowerCase() || null

/**
 * Pairs of contacts that are probably one person: the same phone number (digits only) or the same
 * email (case ignored). Each pair once, the older contact first; deleted contacts are left out.
 */
export function duplicatePairs(contacts: Iterable<Contact>): [Contact, Contact][] {
  const live = [...contacts].filter(c => !c.deleted_at).sort((a, b) => parseTs(a.created_at).getTime() - parseTs(b.created_at).getTime())
  const pairs: [Contact, Contact][] = []
  const seen = new Set<string>()
  const byKey = new Map<string, Contact>()
  for (const contact of live) {
    for (const key of [`p:${digitsOf(contact.phone)}`, emailKey(contact.email) && `e:${emailKey(contact.email)}`]) {
      if (!key) continue
      const first = byKey.get(key)
      if (!first) {
        byKey.set(key, contact)
        continue
      }
      const id = `${first.id}|${contact.id}`
      if (!seen.has(id)) pairs.push([first, contact])
      seen.add(id)
    }
  }
  return pairs
}

/**
 * What a merge keeps by default: per field the kept contact's value, else the other one's. `choices`
 * lists only the fields where both have a different value, so the member picks just those.
 */
export function mergeDefaults(keep: Contact, other: Contact) {
  const values = {} as Record<MergeField, string | null>
  const choices: MergeField[] = []
  for (const field of MERGE_FIELDS) {
    const [a, b] = [keep[field]?.trim() || null, other[field]?.trim() || null]
    values[field] = a ?? b
    if (a && b && a !== b) choices.push(field)
  }
  return { values, choices }
}

/** Under a contact's note: who gets it (the assistant answering, when this contact is the caller). */
export function noteHint(assistantNames: string[]): string {
  const who =
    assistantNames.length === 1 ? assistantNames[0] : assistantNames.length ? 'Your assistants' : 'The assistant'
  return `${who} ${assistantNames.length > 1 ? 'see' : 'sees'} this note when this contact calls.`
}

/** The details a contact has besides name and phone, in the order the contact page shows them. New contact asks for the same. */
export const CONTACT_DETAIL_FIELDS = [
  { field: 'company', label: 'Company', placeholder: 'Add a company' },
  { field: 'email', label: 'Email', placeholder: 'name@example.com' },
  { field: 'address', label: 'Address', placeholder: 'Street, city' },
  { field: 'note', label: 'Note', placeholder: 'Anything to remember', multiline: true },
] as const

export type ContactDetailField = (typeof CONTACT_DETAIL_FIELDS)[number]['field']

/** Longest value each field of New contact takes, the same contact.create checks on the server. */
export const NEW_CONTACT_MAX_LENGTH = CONTACT_IMPORT_LIMITS

/** What is typed into New contact. */
export type NewContactForm = { name: string; phone: string } & Record<ContactDetailField, string>

export const EMPTY_NEW_CONTACT: NewContactForm = { name: '', phone: '', company: '', email: '', address: '', note: '' }

export type NewContactInput = { phone: string; name?: string } & Partial<Record<ContactDetailField, string>>

/**
 * contact.create's input from New contact, or the problem with the phone number (the one field that can be wrong):
 * empty, not a US number, or already in Contacts (`existing`, in E.164). Blank fields are left out.
 */
export function newContactInput(
  form: NewContactForm,
  existing: ReadonlySet<string>,
): { input: NewContactInput; problem?: undefined } | { problem: string; input?: undefined } {
  const e164 = toE164(form.phone)
  if (!form.phone.trim()) return { problem: 'Enter a phone number.' }
  if (!e164) return { problem: 'Enter a US phone number, like +1 503 555 0100.' }
  if (existing.has(e164)) return { problem: 'That number is already in Contacts.' }
  const input: NewContactInput = { phone: e164 }
  for (const field of ['name', ...CONTACT_DETAIL_FIELDS.map(f => f.field)] as const) {
    const value = form[field].trim()
    if (value) input[field] = value
  }
  return { input }
}
