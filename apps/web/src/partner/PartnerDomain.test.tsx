// Partner › Domain (S5): the address with its state, the records to add until it is live, the buttons for the owner
// only, and what the page says without a provider, while locked, and after a removal.
import type { PartnerDomainData } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { DomainBody, domainErrorText, domainLead, domainMark } from './PartnerDomain.tsx'

const data = (over: Partial<PartnerDomainData> = {}): PartnerDomainData => ({
  available: true,
  locked: null,
  domain: null,
  removed: null,
  canEdit: true,
  ...over,
})
const domain = (status: NonNullable<PartnerDomainData['domain']>['status'], over = {}) => ({
  hostname: 'app.cascade-it.example',
  origin: 'https://app.cascade-it.example',
  status,
  records: [
    {
      type: 'TXT',
      name: '_linedesk.app.cascade-it.example',
      value: 'linedesk-verify=abc',
      found: status !== 'pending',
    },
    { type: 'CNAME', name: 'app.cascade-it.example', value: 'partners.linedesk.ai', found: status === 'active' },
  ],
  failure: null,
  lastCheckedAt: null,
  activeAt: null,
  failedAt: null,
  ...over,
})

const render = (d: PartnerDomainData) =>
  renderToStaticMarkup(<DomainBody data={d} busy={null} onAdd={() => {}} onCheck={() => {}} onRemove={() => {}} />)

test('empty: one field and Continue for the owner; the team sees that there is none', () => {
  const html = render(data())
  expect(html).toContain('app.yourcompany.com')
  expect(html).toContain('>Continue<')
  expect(render(data({ canEdit: false }))).toContain('No own address yet.')
  expect(render(data({ canEdit: false }))).not.toContain('>Continue<')
})

test('pending: our TXT and the CNAME with Copy buttons, Check now and Remove', () => {
  const html = render(data({ domain: domain('pending') }))
  expect(html).toContain('_linedesk.app.cascade-it.example')
  expect(html).toContain('partners.linedesk.ai')
  expect(html.match(/>Copy value</g)).toHaveLength(2)
  expect(html).toContain('>Check now<')
  expect(html).toContain('Remove…')
  expect(html).toContain('Waiting for the records below.')
})

test('active: the address, no records, no Check now; the team sees no buttons', () => {
  const html = render(data({ domain: domain('active') }))
  expect(html).toContain('app.cascade-it.example')
  expect(html).toContain('Your clients sign in at this address.')
  expect(html).not.toContain('_linedesk.')
  expect(html).not.toContain('>Check now<')
  const team = render(data({ domain: domain('active'), canEdit: false }))
  expect(team).not.toMatch(/>(Check now|Remove…)</)
  expect(team).toContain('Only the owner can change this.')
})

test('locked, unavailable, removed by a server admin, and removed after 30 days', () => {
  expect(render(data({ locked: { brandApproved: false, paid: true } }))).toContain('once your brand is approved')
  expect(render(data({ locked: { brandApproved: true, paid: false } }))).toContain('first invoice is paid')
  expect(render(data({ available: false }))).toContain('not available on this server')
  const removed = { hostname: 'app.x.example', reason: 'imitates a bank', byAdmin: true, at: '' }
  expect(render(data({ removed }))).toContain('imitates a bank')
  expect(render(data({ removed: { ...removed, byAdmin: false, reason: 'expired' } }))).toContain('after 30 days')
})

test('states and refusals in the page words', () => {
  expect(domainMark('active')).toBe('works')
  expect(domainMark('verifying')).toBe('checking')
  expect(domainMark('failed')).toBe('failing')
  expect(domainMark('stopped')).toBe('off')
  expect(domainLead('failed', 'cert_failed')).toBe('team.partner.domain.failedCertLead')
  expect(domainLead('failed', 'moved')).toBe('team.partner.domain.failedLead')
  expect(domainErrorText(Object.assign(new Error('x'), { code: 'domain_taken' }))).toBe(
    'This address is already in use.',
  )
})
