// A partner owner's guided setup and the partner area's first run (PartnerSetup.tsx, PartnerArea.tsx; 2026-11-18): the
// steps and where they open, White-label Cloud's real price, and the three states a new partner goes through: drafts
// before payment, waiting for approval (never a blocker: one info note in Brand) and approved.
import {
  type PartnerBrandData,
  type PartnerClientRow,
  type PartnerData,
  UNPAID_PARTNER_CLIENTS,
} from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { setQueryData } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { ClientList } from './ClientTable.tsx'
import { Clients, partnerSections } from './PartnerArea.tsx'
import { BrandForm, ReviewNote } from './PartnerBrand.tsx'
import {
  ActivateStep,
  ClientsStep,
  PartnerTotal,
  partnerChargeCents,
  partnerSetupStart,
  partnerSetupSteps,
} from './PartnerSetup.tsx'
import { PARTNER_CLIENTS_QUERY } from './partner-api.ts'

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
  refused?: PartnerData['newClientRefused']
}): PartnerData => ({
  partner: { id: 'ptn_1', name: 'Northwind Digital', status: over.status ?? 'pending' },
  role: 'owner',
  members: [],
  invitations: [],
  clients: Array.from({ length: over.clients ?? 0 }, (_, i) => client(i)),
  bill: over.bill === null ? null : { status: over.bill ?? 'pending_payment', mine: over.mine ?? true, price, prices },
  newClientRefused: over.refused ?? null,
  offers: { domain: false, sender: false },
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
  renderToStaticMarkup(
    <PartnerTotal
      price={{ ...price, interval }}
      prices={prices}
      clients={Array.from({ length: clients }, (_, i) => client(i))}
    />,
  )

test('Activate: the real charge a month leads, one grey line says what it is made of and when it is charged', () => {
  // One draft: named in the line ("$11 for Maple Plumbing"); the headline is what is really charged a month.
  expect(totalHtml('month', 1)).toContain(
    '<div class="price-line"><b><span class="plan-card-price">$23 a month</span></b><span class="help">$14 White-label Cloud + $9 for Client 0. Charged today, then every month.</span></div>',
  )
  // Several: counted. Yearly: the month first, the year's total charged today in the line.
  expect(totalHtml('year', 2)).toContain(
    '<span class="plan-card-price">$32 a month</span></b><span class="help">$14 White-label Cloud + $18 for 2 client workspaces. $384 billed yearly, charged today.</span>',
  )
  // No drafts yet: the base fee, and what each client workspace will add.
  expect(totalHtml('month', 0)).toContain(
    '<span class="plan-card-price">$14 a month</span></b><span class="help">$14 White-label Cloud + $9 a month per client workspace. Charged today, then every month.</span>',
  )
  // No trial for a partner: the price leads; what each client workspace includes and "See all details", as everywhere.
  const html = totalHtml('year', 2)
  expect(html).not.toContain('days free')
  expect(html).not.toContain('plan-card-unit')
  expect(html).toContain('Each client workspace includes:')
  expect(html).toContain('50 call minutes each month, then $0.05 a minute')
  expect(html).toContain('See all details')
})

const activateHtml = (clients: number) =>
  renderToStaticMarkup(<ActivateStep data={partnerData({ clients })} onBack={() => {}} />)

test('Activate is the end of the setup: the total with the drafts, only Back and Activate, no client rows', () => {
  const three = activateHtml(UNPAID_PARTNER_CLIENTS)
  // Drafts are removed in the client list, not here: no rows with Remove above the price.
  expect(three).not.toContain('>Remove<')
  expect(three).toContain(`for ${UNPAID_PARTNER_CLIENTS} client workspaces`)
  // Two buttons in the footer: Back and Activate; no "later" way off to the agent or a client.
  const foot = three.slice(three.indexOf('class="ob-foot"'))
  expect(foot.match(/<button/g)?.length).toBe(2)
  expect(foot).toContain('Back')
  expect(foot).toContain('Activate White-label Cloud')
  // As on the owner's Start your free trial step: the card is asked for on the next page, said next to the button.
  expect(foot).toContain('You add your card on the next page.')
  expect(three).not.toContain('first')
  expect(activateHtml(0)).toContain(
    '$14 a month</span></b><span class="help">$14 White-label Cloud + $9 a month per client workspace.',
  )
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

test('the partner area before payment: one Activate with the real charge a month, no "Continue setup by hand"', () => {
  const html = clientsHtml(partnerData({ clients: 1 }))
  expect(html).not.toContain('Continue setup by hand')
  // The card: "$23 a month", then what it is made of and what starts once active; Activate is its one button.
  expect(html).toContain(
    '<b>$23 a month</b><span class="help">$14 White-label Cloud + $9 for Client 0. $276 billed yearly. Numbers, calls and client invitations start once you activate.</span>',
  )
  const card = html.slice(html.indexOf('pa-activate'), html.indexOf('</section>', html.indexOf('pa-activate')))
  expect(card.match(/<button/g)?.length).toBe(1)
  expect(clientsHtml(partnerData({ bill: 'active', clients: 1 }))).not.toContain('Activate White-label Cloud')
})

test('before payment, no clients: one primary action (New client), Activate next to it with the real price', () => {
  const html = clientsHtml(partnerData({}))
  expect(html).toContain('No clients yet')
  // The price a month leads; on the yearly plan the year's total is in the grey line (ui/price.tsx).
  expect(html).toContain(
    '<b>$14 a month</b><span class="help">$14 White-label Cloud + $9 a month per client workspace. $168 billed yearly. Numbers, calls and client invitations start once you activate.</span>',
  )
  expect(html.match(/k-btn-primary/g)?.length).toBe(1)
  expect(html).not.toContain('disabled=""')
})

test('before payment, drafts: New client still works; at the cap it says why it cannot', () => {
  const some = clientsHtml(partnerData({ clients: 1 }))
  expect(some).not.toContain('disabled=""')
  expect(some).not.toContain('You can add more after you activate')
  const full = clientsHtml(partnerData({ clients: UNPAID_PARTNER_CLIENTS }))
  expect(full).toContain('disabled=""')
  expect(full).toContain(`Add up to ${UNPAID_PARTNER_CLIENTS} clients now. You can add more after you activate.`)
})

test('Add client tells a partner without a plan before the form, not after it (B3)', () => {
  const html = clientsHtml(partnerData({ status: 'approved', bill: null, refused: 'client_needs_bill' }))
  expect(html).toContain('Client workspaces need a partner plan on this server')
  expect(html).toMatch(/disabled=""[^>]*>(<[^>]+>)*Add client|Add client[^"]*"[^>]*disabled=""/)
  const limit = clientsHtml(partnerData({ status: 'approved', bill: null, refused: 'client_limit', clients: 2 }))
  expect(limit).toContain('as many client workspaces as this server allows')
  expect(limit).toContain('disabled=""')
  // Nothing stops it: no reason, nothing greyed.
  const fine = clientsHtml(partnerData({ status: 'approved', bill: null, clients: 1 }))
  expect(fine).not.toContain('disabled=""')
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

test('Domain and Email sender only where this server offers them (or the partner has one already)', () => {
  const t = i18n().t
  const ids = (offers: PartnerData['offers'], keys = true) => partnerSections(t, true, keys, offers).map(s => s.id)
  expect(ids({ domain: false, sender: false })).toEqual(['clients', 'team', 'brand', 'keys', 'billing'])
  expect(ids({ domain: true, sender: true })).toEqual([
    'clients',
    'team',
    'brand',
    'domain',
    'email',
    'keys',
    'billing',
  ])
  // Email sender needs a partner bill as before, even where the server offers it.
  expect(ids({ domain: true, sender: true }, false)).toEqual(['clients', 'team', 'brand', 'domain', 'billing'])
})

const row = (over: Partial<PartnerClientRow>): PartnerClientRow => ({
  id: 'ws_0',
  name: 'Maple Plumbing',
  owner: null,
  number: null,
  numbers: 0,
  forwarding: null,
  lastRealCallAt: null,
  calls: 0,
  seconds: 0,
  costCents: null,
  limitCents: null,
  limitPercent: null,
  billed: true,
  ownKeys: false,
  clientCallQuality: false,
  ownCarrier: false,
  draft: true,
  setupStarted: false,
  problems: [],
  ...over,
})

const listHtml = (rows: PartnerClientRow[], data = partnerData({ clients: 1 })) => {
  setQueryData(PARTNER_CLIENTS_QUERY(data.partner.id), { period: null, clients: rows })
  return renderToStaticMarkup(
    <ClientList
      data={data}
      frozen={false}
      invitesWait
      opening={null}
      onOpen={() => {}}
      onSetUp={() => {}}
      onInvite={() => {}}
      onRelease={() => {}}
      onDelete={() => {}}
      onSettings={() => {}}
    />,
  )
}

test('a draft before activation is calm: a grey Draft badge, whether its setup started, one Set up menu', () => {
  const html = listHtml([row({ id: 'ws_0' })])
  expect(html).toContain('>Draft<')
  expect(html).toContain('Not set up yet')
  // Neutral, never the amber "No number" warning; no owner line it cannot have yet.
  expect(html).not.toContain('No number')
  expect(html).not.toContain('k-badge-warning')
  expect(html).not.toContain('No owner yet')
  // One menu button in place of "By hand" and "With an AI agent".
  expect(html).toMatch(/aria-haspopup="menu"[^>]*>(<[^>]+>)*Set up/)
  expect(html).not.toContain('With an AI agent')
  expect(listHtml([row({ id: 'ws_0', setupStarted: true })])).toContain('Setup started · goes live once you activate')
})
