import type { Call, Contact } from '@callfront/db/types'
import { describe, expect, it } from 'vitest'
import { contactLabel, contactRows, filterContactRows, matchesContact } from './model.ts'

const contact = (over: Partial<Contact>) => ({
  id: 'k', name: null, company: null, phone: '+15035550142', email: null, address: null, note: null, created_at: '2026-11-01 10:00:00+00', ...over,
}) as Contact
const call = (over: Partial<Call>) => ({
  id: 'c', contact_id: 'k', inbox_state: 'open', deleted_at: null, started_at: '2026-11-10 10:00:00+00', action_items: [], ...over,
}) as Call

describe('contact rows', () => {
  it('sorts by the most recent call, contacts without calls last (newest first)', () => {
    const contacts = [
      contact({ id: 'quiet-old', created_at: '2026-11-01 10:00:00+00' }),
      contact({ id: 'yesterday' }),
      contact({ id: 'today' }),
      contact({ id: 'quiet-new', created_at: '2026-11-05 10:00:00+00' }),
    ]
    const calls = [
      call({ id: 'y', contact_id: 'yesterday', started_at: '2026-11-09 10:00:00+00' }),
      call({ id: 't1', contact_id: 'today', started_at: '2026-11-08 10:00:00+00' }),
      call({ id: 't2', contact_id: 'today', started_at: '2026-11-10 09:00:00+00' }),
    ]
    expect(contactRows(contacts, calls).map(r => r.contact.id)).toEqual(['today', 'yesterday', 'quiet-new', 'quiet-old'])
  })

  it('counts calls newest first and leaves out deleted and unlinked calls', () => {
    const calls = [
      call({ id: 'old', started_at: '2026-11-08 10:00:00+00' }),
      call({ id: 'new' }),
      call({ id: 'gone', deleted_at: '2026-11-10 11:00:00+00', started_at: '2026-11-10 11:00:00+00' }),
      call({ id: 'other', contact_id: null }),
    ]
    const [row] = contactRows([contact({})], calls)
    expect(row!.calls.map(c => c.id)).toEqual(['new', 'old'])
    expect(row!.lastCall?.id).toBe('new')
  })

  it('takes the next step from the newest call that is still open', () => {
    const calls = [
      call({ id: 'done', inbox_state: 'done', action_items: [{ text: 'Old step' }] }),
      call({ id: 'open', started_at: '2026-11-09 10:00:00+00', action_items: [{ text: 'Ticked', done: true }, { text: 'Call back about the boiler' }] }),
    ]
    expect(contactRows([contact({})], calls)[0]!.nextStep).toBe('Call back about the boiler')
    expect(contactRows([contact({})], [call({ inbox_state: 'done', action_items: [{ text: 'x' }] })])[0]!.nextStep).toBeNull()
  })

  it('labels a contact by name, else by the formatted number', () => {
    expect(contactLabel(contact({ name: 'Emily Carter' }))).toBe('Emily Carter')
    expect(contactLabel(contact({}))).toBe('+1 503 555 0142')
  })
})

describe('contact search', () => {
  const emily = contact({ name: 'Emily Carter', company: 'Carter Residence', email: 'emily@example.com', phone: '+15035550142' })

  it('matches name, company and email, ignoring case and spaces around the query', () => {
    expect(matchesContact(emily, 'emily')).toBe(true)
    expect(matchesContact(emily, ' RESIDENCE ')).toBe(true)
    expect(matchesContact(emily, 'example.com')).toBe(true)
    expect(matchesContact(emily, 'brennan')).toBe(false)
  })

  it('matches the phone number whatever the formatting', () => {
    for (const q of ['503-555', '(503) 555-0142', '+1 503 555 0142', '5035550142', '0142', '+1503']) expect(matchesContact(emily, q)).toBe(true)
    expect(matchesContact(emily, '999')).toBe(false)
  })

  it('does not match digits hidden in words', () => {
    expect(matchesContact(emily, 'a0142')).toBe(false)
  })

  it('returns every row for an empty query', () => {
    const rows = contactRows([emily, contact({ id: 'k2', name: 'Mike Brennan', phone: '+15035550100' })], [])
    expect(filterContactRows(rows, '  ')).toHaveLength(2)
    expect(filterContactRows(rows, 'mike').map(r => r.contact.name)).toEqual(['Mike Brennan'])
  })
})
