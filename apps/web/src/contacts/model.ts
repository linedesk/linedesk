// The Contacts list is derived from the synced contacts and calls: who called, how often, when last and about what.
import type { Call, Contact } from '@callfront/db/types'
import { formatPhone } from '../inbox-model.ts'
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

/** Every contact with its calls, sorted by the most recent call; contacts without calls come last, newest first. */
export function contactRows(contacts: Iterable<Contact>, calls: Iterable<Call>): ContactRow[] {
  const byContact = new Map<string, Call[]>()
  for (const call of calls) {
    if (!call.contact_id || call.deleted_at) continue
    const list = byContact.get(call.contact_id) ?? []
    list.push(call)
    byContact.set(call.contact_id, list)
  }
  const rows = [...contacts].map(contact => {
    const own = (byContact.get(contact.id) ?? []).sort((a, b) => startedMs(b) - startedMs(a))
    return { contact, calls: own, lastCall: own[0], nextStep: nextStepOf(own) }
  })
  return rows.sort(byRecentCall)
}

function byRecentCall(a: ContactRow, b: ContactRow): number {
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
  const text = [contact.name, contact.company, contact.email, contact.phone, formatPhone(contact.phone)].filter(Boolean).join('\n').toLowerCase()
  if (text.includes(q)) return true
  const digits = digitsOf(q)
  return PHONE_QUERY.test(q) && digits.length > 0 && digitsOf(contact.phone).includes(digits)
}

export function filterContactRows(rows: ContactRow[], query: string): ContactRow[] {
  return query.trim() ? rows.filter(row => matchesContact(row.contact, query)) : rows
}
