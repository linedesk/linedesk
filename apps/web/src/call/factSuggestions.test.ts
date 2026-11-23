import { expect, test } from 'vitest'
import { factSuggestions } from './factSuggestions.ts'

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
