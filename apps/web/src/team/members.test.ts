// A member's label (members.ts memberLabel): their name; without one their email where the screen knows it, else
// "A teammate".
import { expect, test } from 'vitest'
import { memberLabel } from './members.ts'

test('the name first, else the email, else A teammate', () => {
  expect(memberLabel({ name: 'Sam Lee' }, 'sam@acme.example')).toBe('Sam Lee')
  expect(memberLabel({ name: '  ' }, 'sam@acme.example')).toBe('sam@acme.example')
  expect(memberLabel({ name: '' })).toBe('A teammate')
  expect(memberLabel(undefined)).toBe('A teammate')
})
