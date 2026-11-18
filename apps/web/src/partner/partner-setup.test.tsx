// A partner owner's guided setup and the partner area's first run (PartnerSetup.tsx, PartnerArea.tsx; 2026-11-18): the
// steps and where they open, White-label Cloud's real price, and the three states a new partner goes through: drafts
// before payment, waiting for approval (never a blocker: one info note in Brand) and approved.
import { type PartnerBrandData, type PartnerData, UNPAID_PARTNER_CLIENTS } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { Clients } from './PartnerArea.tsx'
import { BrandForm, ReviewNote } from './PartnerBrand.tsx'
import {
  ActivateStep,
  ClientsStep,
  PartnerTotal,
  partnerChargeCents,
  partnerSetupStart,
  partnerSetupSteps,
} from './PartnerSetup.tsx'

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
  bill: over.bill === null ? null : { status: over.bill ?? 'pending_payment', mine: over.mine ?? true, price, prices },
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
  expect(partnerSetupSteps(partnerData({}))).toEqual(['agency', 'clients', 'activate'])
  expect(partnerSetupSteps(partnerData({ mine: false }))).toEqual(['agency', 'clients'])
  expect(partnerSetupSteps(partnerData({ bill: 'active' }))).toEqual(['agency', 'clients'])
  expect(partnerSetupSteps(partnerData({ bill: null }))).toEqual(['agency', 'clients'])
})

test('the setup opens at the step the address names, else at the brand, then the clients', () => {
  const all = ['agency', 'clients', 'activate'] as const
  expect(partnerSetupStart('#partner/setup', all, { brand: false })).toBe('agency')
  expect(partnerSetupStart('#partner/setup', all, { brand: true })).toBe('clients')
  // Activate is the end of the setup, opened only on purpose (the Clients step, the agent page, the partner area).
  expect(partnerSetupStart('#partner/setup/activate', all, { brand: false })).toBe('activate')
  expect(partnerSetupStart('#partner/setup/agency', all, { brand: true })).toBe('agency')
  // A step this partner does not go through (paid already) is not opened by its address.
  expect(partnerSetupStart('#partner/setup/activate', ['agency', 'clients'], { brand: true })).toBe('clients')
})

test('what Checkout charges: the base fee and a seat per client workspace, for a year or a month', () => {
  expect(partnerChargeCents(price, 1)).toBe((1400 + 900) * 12)
  expect(partnerChargeCents(price, 0)).toBe(1400 * 12)
  expect(partnerChargeCents({ ...price, interval: 'month' }, 2)).toBe(1400 + 2 * 900)
})

const totalHtml = (interval: 'year' | 'month', clients: number) =>
  renderToStaticMarkup(<PartnerTotal price={{ ...price, interval }} prices={prices} clients={clients} />)

test('Activate: the shared plan card, the price a month leads, what Checkout charges today is the grey note', () => {
  expect(totalHtml('year', 2)).toContain(
    '<div class="price-line"><b><span class="plan-card-price">$14 a month</span> <span class="plan-card-unit">+ $9 a month × 2 client workspaces</span></b><span class="help">$384 billed yearly, charged today</span></div>',
  )
  // No drafts yet: what each client workspace will cost, the total of the base fee alone.
  expect(totalHtml('year', 0)).toContain(
    '<span class="plan-card-unit">+ $9 a month per client workspace</span></b><span class="help">$168 billed yearly, charged today</span>',
  )
  expect(totalHtml('month', 1)).toContain(
    '+ $9 a month × 1 client workspace</span></b><span class="help">$23 charged today, then every month</span>',
  )
  // No trial for a partner: the price leads; what each client workspace includes and "See all details", as everywhere.
  const html = totalHtml('year', 2)
  expect(html).not.toContain('days free')
  expect(html).toContain('Each client workspace includes:')
  expect(html).toContain('50 call minutes each month, then $0.05 a minute')
  expect(html).toContain('See all details')
})

const activateHtml = (clients: number) =>
  renderToStaticMarkup(<ActivateStep data={partnerData({ clients })} onBack={() => {}} />)

test('Activate is the end of the setup: each draft with Remove, the total, only Back and Activate', () => {
  const three = activateHtml(UNPAID_PARTNER_CLIENTS)
  expect(three.match(/>Remove</g)?.length).toBe(UNPAID_PARTNER_CLIENTS)
  for (let i = 0; i < UNPAID_PARTNER_CLIENTS; i++) expect(three).toContain(`Client ${i}`)
  expect(three).toContain(`× ${UNPAID_PARTNER_CLIENTS} client workspaces`)
  // Two buttons in the footer: Back and Activate; no "later" way off to the agent or a client.
  const foot = three.slice(three.indexOf('class="ob-foot"'))
  expect(foot.match(/<button/g)?.length).toBe(2)
  expect(foot).toContain('Back')
  expect(foot).toContain('Activate White-label Cloud')
  // As on the owner's Start your free trial step: the card is asked for on the next page, said next to the button.
  expect(foot).toContain('You add your card on the next page.')
  expect(three).not.toContain('first')
  const none = activateHtml(0)
  expect(none).not.toContain('>Remove<')
  expect(none).toContain('$14 a month</span> <span class="plan-card-unit">+ $9 a month per client workspace</span>')
})

const clientsStepHtml = (clients: number, bill?: Bill['status']) =>
  renderToStaticMarkup(
    <ClientsStep data={partnerData({ clients, bill })} last={bill === 'active'} onBack={() => {}} onNext={() => {}} />,
  )
const LEDE = 'Each client gets its own workspace, assistant and number.'

test('Clients: each draft set up with the agent (the default) or by hand; Add client up to the cap; none is fine', () => {
  const none = clientsStepHtml(0)
  expect(none).toContain('Add client')
  expect(none).not.toContain('With an AI agent')
  // None yet: Add client is the step's one primary, "Later" the quiet way on (never the main button), no Continue.
  expect(none).toMatch(/k-btn-primary[^>]*>(<[^>]+>)*Add client/)
  expect(none).toMatch(/k-btn-ghost[^>]*>(<[^>]+>)*Later/)
  expect(none).not.toContain('Continue')
  expect(none.match(/k-btn-primary/g)?.length).toBe(1)
  const one = clientsStepHtml(1)
  expect(one).toContain('Client 0')
  // With the agent is the filled button, by hand the quiet one.
  expect(one).toMatch(/k-btn-secondary[^>]*>(<[^>]+>)*With an AI agent/)
  expect(one).toMatch(/k-btn-ghost[^>]*>(<[^>]+>)*By hand/)
  expect(one).not.toMatch(/<span>Later<\/span>/)
  expect(one).toMatch(/k-btn-primary[^>]*>(<[^>]+>)*Continue/)
  expect(one).not.toContain('disabled=""')
  // The lede stays the step's own; the limit is only for the setup, said once as a fine note under Add client, and at
  // the cap Add client is greyed with the same words.
  expect(none).toContain(LEDE)
  expect(none).toContain(
    `<p class="ps-fine">Add up to ${UNPAID_PARTNER_CLIENTS} clients now. You can add more after you activate.</p>`,
  )
  const full = clientsStepHtml(UNPAID_PARTNER_CLIENTS)
  expect(full.match(/With an AI agent/g)?.length).toBe(UNPAID_PARTNER_CLIENTS)
  expect(full.match(/You can add more after you activate/g)?.length).toBe(2)
  expect(full).toMatch(/disabled=""[^>]*>(<[^>]+>)*Add client|title="Add up to[^"]*"[^>]*disabled=""/)
})

test('once White-label Cloud runs, a client row says who owns it and offers what is next: Invite owner', () => {
  const paid = clientsStepHtml(2, 'active')
  expect(paid).toContain(LEDE)
  expect(paid).not.toContain('You can add more after you activate')
  expect(paid.match(/No owner yet/g)?.length).toBe(2)
  expect(paid.match(/>Invite owner</g)?.length).toBe(2)
  expect(paid).not.toContain('With an AI agent')
  // The last step now: Done ends the setup.
  expect(paid).toMatch(/k-btn-primary[^>]*>(<[^>]+>)*Done/)
})

test('the partner area before payment: drafts are set up by hand or with the agent, and the setup can go on by hand', () => {
  const html = clientsHtml(partnerData({ clients: 1 }))
  expect(html).toContain('Continue setup by hand')
  // The list loads on its own (its rows wait for partner.listClients), so the card's own actions are what show here.
  expect(html).toContain('Activate White-label Cloud')
  expect(clientsHtml(partnerData({ bill: 'active', clients: 1 }))).not.toContain('Continue setup by hand')
})

test('before payment, no clients: one primary action (New client), Activate next to it with the real price', () => {
  const html = clientsHtml(partnerData({}))
  expect(html).toContain('No clients yet')
  // The price a month leads; the yearly totals are the grey note under it (ui/price.tsx).
  expect(html).toContain(
    '<b>$14 a month + $9 a month per client workspace</b><span class="help">$168 billed yearly + $108 a year per client workspace</span>',
  )
  expect(html.match(/k-btn-primary/g)?.length).toBe(1)
  expect(html).not.toContain('disabled=""')
})

test('before payment, drafts: New client still works; at the cap it says why it cannot', () => {
  const some = clientsHtml(partnerData({ clients: 1 }))
  expect(some).not.toContain('disabled=""')
  expect(some).toContain('Activate White-label Cloud')
  const full = clientsHtml(partnerData({ clients: UNPAID_PARTNER_CLIENTS }))
  expect(full).toContain('disabled=""')
  expect(full).toContain(`Add up to ${UNPAID_PARTNER_CLIENTS} clients now. You can add more after you activate.`)
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
