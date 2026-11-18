// A partner owner's guided setup and the partner area's first run (PartnerSetup.tsx, PartnerArea.tsx; 2026-11-18): the
// steps and where they open, White-label Cloud's real price, and the three states a new partner goes through: drafts
// before payment, waiting for approval (never a blocker: one info note in Brand) and approved.
import { type PartnerBrandData, type PartnerData, UNPAID_PARTNER_CLIENTS } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Clients } from './PartnerArea.tsx'
import { BrandForm, ReviewNote } from './PartnerBrand.tsx'
import { partnerChargeCents, partnerSetupStart, partnerSetupSteps } from './PartnerSetup.tsx'

const price = { interval: 'year' as const, planCents: 1400, seatCents: 900 }
type Bill = NonNullable<PartnerData['bill']>

const client = (i: number): PartnerData['clients'][number] => ({
  id: `ws_${i}`,
  name: `Client ${i}`,
  createdAt: new Date(2026, 10, i + 1).toISOString(),
  owner: null,
  otherMembers: [],
  invitedByTeam: [],
})

const partnerData = (over: {
  status?: PartnerData['partner']['status']
  bill?: Bill['status'] | null
  clients?: number
  mine?: boolean
}): PartnerData => ({
  partner: { id: 'ptn_1', name: 'Northwind Digital', status: over.status ?? 'pending' },
  role: 'owner',
  members: [],
  invitations: [],
  clients: Array.from({ length: over.clients ?? 0 }, (_, i) => client(i)),
  bill: over.bill === null ? null : { status: over.bill ?? 'pending_payment', mine: over.mine ?? true, price },
})

const clientsHtml = (data: PartnerData, frozen = false) =>
  renderToStaticMarkup(<Clients data={data} frozen={frozen} toast={() => {}} />)

const brandHtml = (approved: boolean) => {
  const data: PartnerBrandData = {
    brand: null,
    review: { state: 'none', approved: null, approvedAt: null },
    emails: { active: false, approved, paid: true },
    canEdit: true,
  }
  return renderToStaticMarkup(<BrandForm partnerId="ptn_1" partnerName="Northwind" data={data} onSaved={() => {}} />)
}

const APPROVAL = 'Your branding goes live in client emails once we approve your account'

test('the steps: Activate only while White-label Cloud waits for its owner’s Checkout', () => {
  expect(partnerSetupSteps(partnerData({}))).toEqual(['agency', 'client', 'activate'])
  expect(partnerSetupSteps(partnerData({ mine: false }))).toEqual(['agency', 'client'])
  expect(partnerSetupSteps(partnerData({ bill: 'active' }))).toEqual(['agency', 'client'])
  expect(partnerSetupSteps(partnerData({ bill: null }))).toEqual(['agency', 'client'])
})

test('the setup opens at the step the address names, else at the first one not done', () => {
  const all = ['agency', 'client', 'activate'] as const
  expect(partnerSetupStart('#partner/setup', all, { brand: false, clients: 0 })).toBe('agency')
  expect(partnerSetupStart('#partner/setup', all, { brand: true, clients: 0 })).toBe('client')
  expect(partnerSetupStart('#partner/setup', all, { brand: true, clients: 1 })).toBe('activate')
  expect(partnerSetupStart('#partner/setup', ['agency', 'client'], { brand: true, clients: 1 })).toBe('client')
  expect(partnerSetupStart('#partner/setup/agency', all, { brand: true, clients: 1 })).toBe('agency')
  // A step this partner does not go through (paid already) is not opened by its address.
  expect(partnerSetupStart('#partner/setup/activate', ['agency', 'client'], { brand: true, clients: 1 })).toBe('client')
})

test('what Checkout charges: the base fee and a seat per client workspace, for a year or a month', () => {
  expect(partnerChargeCents(price, 1)).toBe((1400 + 900) * 12)
  expect(partnerChargeCents(price, 0)).toBe(1400 * 12)
  expect(partnerChargeCents({ ...price, interval: 'month' }, 2)).toBe(1400 + 2 * 900)
})

test('before payment, no clients: one primary action (New client), Activate next to it with the real price', () => {
  const html = clientsHtml(partnerData({}))
  expect(html).toContain('No clients yet')
  expect(html).toContain('$14 a month + $9 a month per client workspace, billed yearly.')
  expect(html.match(/k-btn-primary/g)?.length).toBe(1)
  expect(html).not.toContain('disabled=""')
})

test('before payment, drafts: New client still works; at the cap it says why it cannot', () => {
  const some = clientsHtml(partnerData({ clients: 1 }))
  expect(some).not.toContain('disabled=""')
  expect(some).toContain('Activate White-label Cloud')
  const full = clientsHtml(partnerData({ clients: UNPAID_PARTNER_CLIENTS }))
  expect(full).toContain('disabled=""')
  expect(full).toContain(`Activate White-label Cloud to add more than ${UNPAID_PARTNER_CLIENTS} client workspaces`)
})

test('waiting for approval blocks nothing where billing is on: no note in Clients, one info note in Brand', () => {
  const pending = clientsHtml(partnerData({ status: 'pending', bill: 'active', clients: 1 }))
  expect(pending).not.toContain('approv')
  expect(pending).not.toContain('disabled=""')
  expect(brandHtml(false)).toContain(APPROVAL)
})

test('approved and paid: no Activate card, no approval line', () => {
  const html = clientsHtml(partnerData({ status: 'approved', bill: 'active', clients: 1 }))
  expect(html).not.toContain('Activate White-label Cloud')
  expect(brandHtml(true)).not.toContain(APPROVAL)
})

test('without billing, approval is what client workspaces wait for: said next to New client', () => {
  const html = clientsHtml(partnerData({ status: 'pending', bill: null }), true)
  expect(html).toContain('client workspaces follow once it is approved')
})

const BRAND = {
  name: 'Northwind Voice',
  color: null,
  logoUrl: null,
  supportEmail: null,
  termsUrl: null,
  privacyUrl: null,
}
const reviewHtml = (state: PartnerBrandData['review']['state'], approved: boolean) =>
  renderToStaticMarkup(
    <ReviewNote
      data={{
        brand: BRAND,
        review: { state, approved: state === 'none' ? null : BRAND, approvedAt: null },
        emails: { active: false, approved, paid: false },
        canEdit: true,
      }}
    />,
  )

test('Brand says where the brand stands in one note, never a second line about approval', () => {
  // Not reviewed yet: the review note already says clients see this server's name; the approval line would repeat it.
  const unreviewed = reviewHtml('none', false)
  expect(unreviewed.match(/role="note"/g)?.length).toBe(1)
  expect(unreviewed).toContain('A server admin reviews your brand')
  expect(unreviewed).not.toContain(APPROVAL)
  // Reviewed, the partner not approved yet: the approval is the one thing left, as the info note.
  const reviewed = reviewHtml('approved', false)
  expect(reviewed.match(/role="note"/g)?.length).toBe(1)
  expect(reviewed).toContain(APPROVAL)
  expect(reviewed).toContain('k-note-info')
})
