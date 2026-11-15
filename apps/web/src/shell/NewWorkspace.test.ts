import { expect, test } from 'vitest'
import { i18n } from '../i18n/index.tsx'
import { formErrors, ownerInput } from './NewWorkspace.tsx'

const t = (...args: Parameters<ReturnType<typeof i18n>['t']>) => i18n().t(...args)
const form = { name: 'Riverside Electric', owner: 'me' as const, ownerEmail: '', ownerName: '' }

test('owner Me needs only the business name', () => {
  expect(formErrors(form, t)).toEqual({})
  expect(formErrors({ ...form, name: '  ' }, t).name).toBe(t('shell.newWorkspace.nameMissing'))
})

test('owner by email needs a valid address; the name stays optional', () => {
  expect(formErrors({ ...form, owner: 'other' }, t).ownerEmail).toBeTruthy()
  expect(formErrors({ ...form, owner: 'other', ownerEmail: 'not-an-address' }, t).ownerEmail).toBeTruthy()
  expect(formErrors({ ...form, owner: 'other', ownerEmail: 'ana@riverside.example' }, t)).toEqual({})
})

test('the owner is sent trimmed, with a name only when one was given', () => {
  expect(ownerInput({ ownerEmail: ' ana@riverside.example ', ownerName: ' ' })).toEqual({
    email: 'ana@riverside.example',
  })
  expect(ownerInput({ ownerEmail: 'ana@riverside.example', ownerName: ' Ana Ruiz ' })).toEqual({
    email: 'ana@riverside.example',
    name: 'Ana Ruiz',
  })
})
