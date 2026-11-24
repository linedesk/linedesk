// White-label Cloud set up before payment (PartnerArea.tsx; 2026-11-18): until the partner's Checkout the partner
// prepares up to UNPAID_PARTNER_CLIENTS draft client workspaces; invitations, numbers and calls wait for it.
import { type PartnerData, UNPAID_PARTNER_CLIENTS } from '@linedesk/actions'
import { expect, test } from 'vitest'
import { clientsFrozen, roomForClient, unpaidPartner } from './PartnerArea.tsx'

const price = { interval: 'year' as const, planCents: 1400, seatCents: 900 }
const prices = {
  includedNumbers: 1,
  includedMinutes: 50,
  includedCalls: 5,
  standardMicrosPerMinute: 50_000,
  premiumMicrosPerMinute: 100_000,
  ultraMicrosPerMinute: 200_000,
  extraNumberCents: 300,
}
const bill = (status: NonNullable<PartnerData['bill']>['status']) => ({ status, mine: true, price, prices })
const clients = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `ws_${i}` }) as PartnerData['clients'][number])

test('unpaid: drafts can be made up to the cap, then not; the partner area is not frozen', () => {
  const data = { bill: bill('pending_payment'), partner: { status: 'pending' }, clients: clients(0) }
  expect(unpaidPartner(data)).toBe(true)
  expect(clientsFrozen(data)).toBe(false)
  expect(roomForClient(data)).toBe(true)
  expect(roomForClient({ ...data, clients: clients(UNPAID_PARTNER_CLIENTS - 1) })).toBe(true)
  expect(roomForClient({ ...data, clients: clients(UNPAID_PARTNER_CLIENTS) })).toBe(false)
})

test('paid: no cap; a bill that does not run or a suspended partner freezes client workspaces', () => {
  const paid = { bill: bill('active'), partner: { status: 'approved' }, clients: clients(UNPAID_PARTNER_CLIENTS + 2) }
  expect(unpaidPartner(paid)).toBe(false)
  expect(roomForClient(paid)).toBe(true)
  expect(clientsFrozen(paid)).toBe(false)
  expect(clientsFrozen({ ...paid, bill: bill('canceled') })).toBe(true)
  expect(clientsFrozen({ ...paid, bill: bill('pending_payment'), partner: { status: 'suspended' } })).toBe(true)
})
