// Server admin › Workspaces › Partner… (LIN-530): what the dialog lists for each choice.
import { expect, test } from 'vitest'
import { i18n } from '../i18n/index.tsx'
import { clientPartnerLines } from './ClientPartner.tsx'

const t = ((...args: Parameters<ReturnType<typeof i18n>['t']>) => i18n().t(...args)) as never
const billed = (name: string) => ({ name, billingAccountId: `bill_${name}` })
const unbilled = (name: string) => ({ name, billingAccountId: null })

test('a move names both teams and the seat on the new bill', () => {
  expect(clientPartnerLines(t, billed('Old'), billed('New'))).toEqual([
    'The team of Old loses access.',
    'The team of New becomes an admin.',
    'Its seat moves to the bill of New.',
    'The owner, numbers and calls stay.',
  ])
})

test('adding names only the new team; without billing no bill line', () => {
  expect(clientPartnerLines(t, null, unbilled('New'))).toEqual([
    'The team of New becomes an admin.',
    'The owner, numbers and calls stay.',
  ])
})

test("taking it from its partner: the team leaves and the owner's own bill waits for a card", () => {
  expect(clientPartnerLines(t, billed('Old'), null)).toEqual([
    'The team of Old loses access.',
    'It moves to a new bill of its owner, who adds a card.',
    'The owner, numbers and calls stay.',
  ])
  expect(clientPartnerLines(t, unbilled('Old'), null)).toEqual([
    'The team of Old loses access.',
    'The owner, numbers and calls stay.',
  ])
})
