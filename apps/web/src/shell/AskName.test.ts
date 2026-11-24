// "What's your name?" (AskName.tsx): asked in the person's own workspace, never in a client workspace they are in
// through a white-label partner's team (the partner area asks them there).
import { expect, test } from 'vitest'
import { asksNameIn } from './AskName.tsx'

const workspace = { id: 'ws_1', name: 'Riverside Dental' }

test('asked in their own workspace, also a client workspace whose own people they are', () => {
  expect(asksNameIn({ workspace })).toBe(true)
  expect(asksNameIn({ workspace: { ...workspace, partnerManaged: true, viaPartner: false } })).toBe(true)
})

test('not in a client workspace they work in for the partner', () => {
  expect(asksNameIn({ workspace: { ...workspace, partnerManaged: true, viaPartner: true } })).toBe(false)
})
