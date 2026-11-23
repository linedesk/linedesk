// Server admin › Partners: what waits (partners to approve plus brands to review, one number) and when a partner row
// offers its AI keys switch.
import { expect, test } from 'vitest'
import { offersKeysSwitch, waitingBrands, waitingCount, waitingPartners } from './partnersModel.ts'

const partner = (status: 'pending' | 'approved' | 'suspended') => ({ status })
const brand = (state: 'none' | 'pending' | 'approved') => ({ state })

test('the waiting number counts partners to approve and brands to review', () => {
  const partners = [partner('pending'), partner('approved'), partner('suspended'), partner('pending')]
  const brands = [brand('none'), brand('approved'), brand('pending')]
  expect(waitingPartners(partners)).toHaveLength(2)
  // Never approved and changed since approval both wait; an approved brand does not.
  expect(waitingBrands(brands)).toEqual([brand('none'), brand('pending')])
  expect(waitingCount(partners, brands)).toBe(4)
  // A brand alone waits too: the count is not only partners (B2).
  expect(waitingCount([partner('approved')], [brand('pending')])).toBe(1)
  expect(waitingCount([], [])).toBe(0)
})

test('Turn off AI keys only for a partner with a bill and keys of its own, Turn on after it was turned off', () => {
  const at = new Date().toISOString()
  expect(offersKeysSwitch({ billingAccountId: 'bill', ownKeys: 0, ownKeysDisabled: null })).toBe(false)
  expect(offersKeysSwitch({ billingAccountId: 'bill', ownKeys: 2, ownKeysDisabled: null })).toBe(true)
  // Turned off, then the partner removed its keys: the way back stays.
  expect(offersKeysSwitch({ billingAccountId: 'bill', ownKeys: 0, ownKeysDisabled: { reason: 'x', at } })).toBe(true)
  // No bill: no own keys at all.
  expect(offersKeysSwitch({ billingAccountId: null, ownKeys: 3, ownKeysDisabled: null })).toBe(false)
})
