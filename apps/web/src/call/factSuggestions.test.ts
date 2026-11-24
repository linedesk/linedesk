import { expect, test } from 'vitest'
import type { Call } from '@linedesk/db/types'
import { callsFactSuggestions, factSuggestions, foldedFields } from './factSuggestions.ts'

const empty = { address: null, email: null, company: null }

test('a key fact fills the empty contact field it names', () => {
  const fields = [
    { label: 'Address', value: ' 3127 SE Division St, Portland ' },
    { label: 'Problem', value: 'Burst pipe' },
    { label: 'E-mail', value: 'sarah@example.com' },
  ]
  expect(factSuggestions(fields, empty)).toEqual({
    address: '3127 SE Division St, Portland',
    email: 'sarah@example.com',
  })
})

test('never over a value the contact has, never an email that is not one, the first fact wins', () => {
  const fields = [
    { label: 'Service address', value: '1 A St' },
    { label: 'Address', value: '2 B St' },
    { label: 'Email', value: 'ask her later' },
    { label: 'Business name', value: 'Acme' },
  ]
  expect(factSuggestions(fields, { ...empty, company: 'Acme Inc' })).toEqual({ address: '1 A St' })
})

test('an email under any label', () => {
  expect(factSuggestions([{ label: 'Contact', value: 'p@example.com' }], empty)).toEqual({ email: 'p@example.com' })
})

const call = (id: string, fields: { label: string; value: string }[]) => ({ id, fields }) as unknown as Call

test("the contact page: each empty field gets the newest call's fact, with that call", () => {
  const calls = [
    call('newest', [{ label: 'Problem', value: 'Leak' }]),
    call('middle', [{ label: 'Address', value: '3127 SE Division St' }]),
    call('oldest', [
      { label: 'Address', value: '1 Old Rd' },
      { label: 'Company', value: 'Acme' },
    ]),
  ]
  const out = callsFactSuggestions(calls, empty)
  expect(out.address).toEqual({ value: '3127 SE Division St', call: calls[1] })
  expect(out.company).toEqual({ value: 'Acme', call: calls[2] })
  expect(out.email).toBeUndefined()
  // Never over what the contact has.
  expect(callsFactSuggestions(calls, { ...empty, address: '9 Kept St' }).address).toBeUndefined()
})

test('both contact views fold the same fields: empty, with no suggestion, in their order', () => {
  const contact = { company: null, email: ' ', address: null, note: 'Gate code 42' }
  expect(foldedFields(['company', 'email', 'address', 'note'] as const, contact, { address: '1 A St' })).toEqual([
    'company',
    'email',
  ])
  expect(foldedFields(['company', 'email', 'address'] as const, { ...contact, company: 'Acme' }, {})).toEqual([
    'email',
    'address',
  ])
})
