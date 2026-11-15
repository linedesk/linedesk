import type { Call, Contact } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import {
  CONTACT_DETAIL_FIELDS,
  contactLabel,
  contactRows,
  duplicatePairs,
  EMPTY_NEW_CONTACT,
  filterContactRows,
  isTestCallContact,
  matchesContact,
  mergeDefaults,
  NEW_CONTACT_MAX_LENGTH,
  newContactInput,
  noteHint,
} from './model.ts'

const contact = (over: Partial<Contact>) =>
  ({
    id: 'k',
    name: null,
    company: null,
    phone: '+15035550142',
    email: null,
    address: null,
    note: null,
    created_at: '2026-11-01 10:00:00+00',
    ...over,
  }) as Contact
const call = (over: Partial<Call>) =>
  ({
    id: 'c',
    contact_id: 'k',
    inbox_state: 'open',
    deleted_at: null,
    started_at: '2026-11-10 10:00:00+00',
    action_items: [],
    ...over,
  }) as Call

describe('contact rows', () => {
  it('leaves deleted contacts out', () => {
    const rows = contactRows(
      [contact({ id: 'kept' }), contact({ id: 'gone', deleted_at: '2026-11-10 10:00:00+00' })],
      [],
    )
    expect(rows.map(r => r.contact.id)).toEqual(['kept'])
  })
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
    expect(contactRows(contacts, calls).map(r => r.contact.id)).toEqual([
      'today',
      'yesterday',
      'quiet-new',
      'quiet-old',
    ])
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
      call({
        id: 'open',
        started_at: '2026-11-09 10:00:00+00',
        action_items: [{ text: 'Ticked', done: true }, { text: 'Call back about the boiler' }],
      }),
    ]
    expect(contactRows([contact({})], calls)[0]!.nextStep).toBe('Call back about the boiler')
    expect(
      contactRows([contact({})], [call({ inbox_state: 'done', action_items: [{ text: 'x' }] })])[0]!.nextStep,
    ).toBeNull()
  })

  it('labels a contact by name, else by the formatted number', () => {
    expect(contactLabel(contact({ name: 'Emily Carter' }))).toBe('Emily Carter')
    expect(contactLabel(contact({}))).toBe('+1 503 555 0142')
  })
})

describe('contact search', () => {
  const emily = contact({
    name: 'Emily Carter',
    company: 'Carter Residence',
    email: 'emily@example.com',
    phone: '+15035550142',
  })

  it('matches name, company and email, ignoring case and spaces around the query', () => {
    expect(matchesContact(emily, 'emily')).toBe(true)
    expect(matchesContact(emily, ' RESIDENCE ')).toBe(true)
    expect(matchesContact(emily, 'example.com')).toBe(true)
    expect(matchesContact(emily, 'brennan')).toBe(false)
  })

  it('matches the phone number whatever the formatting', () => {
    for (const q of ['503-555', '(503) 555-0142', '+1 503 555 0142', '5035550142', '0142', '+1503'])
      expect(matchesContact(emily, q)).toBe(true)
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

describe('duplicates', () => {
  it('pairs contacts with the same number or email (case ignored), older first, each pair once, deleted ones left out', () => {
    const a = contact({ id: 'a', phone: '+15035550142', email: 'Sam@Example.com', created_at: '2026-11-01 10:00:00+00' })
    const b = contact({ id: 'b', phone: '+15035550199', email: 'sam@example.com ', created_at: '2026-11-02 10:00:00+00' })
    const c = contact({ id: 'c', phone: '+15035550142', created_at: '2026-11-03 10:00:00+00' })
    const gone = contact({ id: 'gone', phone: '+15035550142', deleted_at: '2026-11-04 10:00:00+00' })
    const alone = contact({ id: 'alone', phone: '+15035550100', email: 'other@example.com' })
    expect(duplicatePairs([c, gone, b, alone, a]).map(([x, y]) => `${x.id}+${y.id}`)).toEqual(['a+b', 'a+c'])
  })

  it('keeps each field from the kept contact, fills empty ones from the other, and asks only where both differ', () => {
    const keep = contact({ name: 'Sam', company: null, email: 'sam@example.com', note: 'Gate code 1234' })
    const other = contact({ name: 'Sam Patel', company: 'Patel Bakery', email: 'sam@example.com', note: null })
    expect(mergeDefaults(keep, other)).toEqual({
      values: { name: 'Sam', company: 'Patel Bakery', email: 'sam@example.com', address: null, note: 'Gate code 1234' },
      choices: ['name'],
    })
  })
})

describe('noteHint', () => {
  it('names the assistant that gets the note when this contact calls', () => {
    expect(noteHint(['Maya'])).toBe('Maya sees this note when this contact calls.')
    expect(noteHint(['Maya', 'Night line'])).toBe('Your assistants see this note when this contact calls.')
    expect(noteHint([])).toBe('The assistant sees this note when this contact calls.')
  })
})

describe('New contact', () => {
  const form = (over: Partial<typeof EMPTY_NEW_CONTACT>) => ({ ...EMPTY_NEW_CONTACT, ...over })
  const none = new Set<string>()

  it('asks for every detail the contact page shows, in its order', () => {
    expect(CONTACT_DETAIL_FIELDS.map(f => f.field)).toEqual(['company', 'email', 'address', 'note'])
    for (const field of ['name', 'company', 'email', 'address', 'note'] as const)
      expect(NEW_CONTACT_MAX_LENGTH[field]).toBeGreaterThan(0)
  })

  it('sends every field filled in, trimmed, with the number in E.164', () => {
    const typed = form({
      name: ' Dana Ortiz ',
      phone: '+15035550100',
      company: 'Ortiz Bakery',
      email: ' dana@ortiz.example ',
      address: '12 Oak St, Portland',
      note: 'Gate code 4411\nDog in the yard',
    })
    expect(newContactInput(typed, none)).toEqual({
      input: {
        phone: '+15035550100',
        name: 'Dana Ortiz',
        company: 'Ortiz Bakery',
        email: 'dana@ortiz.example',
        address: '12 Oak St, Portland',
        note: 'Gate code 4411\nDog in the yard',
      },
    })
  })

  it('leaves out blank fields: a number alone is enough', () => {
    expect(newContactInput(form({ phone: '+15035550100', email: '   ', note: '' }), none)).toEqual({
      input: { phone: '+15035550100' },
    })
  })

  it('takes numbers of every country', () => {
    expect(newContactInput(form({ phone: '+4930123456' }), none)).toEqual({ input: { phone: '+4930123456' } })
    expect(newContactInput(form({ phone: '+447946095800' }), none).problem).toBeUndefined()
  })

  it('says what is wrong with the number: empty, incomplete for its country, or already in Contacts', () => {
    expect(newContactInput(form({ name: 'Dana' }), none)).toEqual({ problem: 'Enter a phone number.' })
    expect(newContactInput(form({ phone: '+1503555' }), none)).toEqual({
      problem: "This number doesn't look complete for the United States.",
    })
    expect(newContactInput(form({ phone: '+4930' }), none)).toEqual({
      problem: "This number doesn't look complete for Germany.",
    })
    expect(newContactInput(form({ phone: '+15035550100', email: 'a@b.example' }), new Set(['+15035550100']))).toEqual({
      problem: 'That number is already in Contacts.',
    })
  })
})

describe('the shared test-call contact (B16)', () => {
  it('is left out of the list, and so of search and merge', () => {
    const test = contact({ id: 't', phone: 'test', name: 'Test call' })
    const mike = contact({ id: 'm', name: 'Mike' })
    const rows = contactRows([test, mike], [call({ id: 'c1', contact_id: 't' })])
    expect(rows.map(r => r.contact.id)).toEqual(['m'])
    expect(filterContactRows(rows, 'test')).toEqual([])
    expect(isTestCallContact(test)).toBe(true)
    expect(isTestCallContact(mike)).toBe(false)
  })
})
