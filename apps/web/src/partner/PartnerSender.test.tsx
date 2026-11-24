// Partner › Email sender (S6): the address with its state, the records to add while it is not verified, the buttons
// for the owner only, and the Reply-To row that waits for the support email's code.
import type { PartnerSenderData } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { SenderBody, senderErrorText, senderLead, senderMark } from './PartnerSender.tsx'

const data = (over: Partial<PartnerSenderData> = {}): PartnerSenderData => ({
  available: true,
  locked: null,
  sender: null,
  removedByAdmin: null,
  fromLine: '"Cascade Desk" <no-reply@linedesk.ai>',
  support: { address: 'help@cascade.example', verified: false, draft: null },
  canEdit: true,
  ...over,
})
const pending = {
  address: 'notify@mail.cascade.example',
  domain: 'mail.cascade.example',
  status: 'pending' as const,
  records: [
    { type: 'TXT', name: 'resend._domainkey.mail', value: 'p=MIGf', priority: null, found: false },
    { type: 'MX', name: 'send.mail', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, found: true },
  ],
  lastCheckedAt: null,
  verifiedAt: null,
  failedAt: null,
}

const render = (d: PartnerSenderData) =>
  renderToStaticMarkup(
    <SenderBody
      data={d}
      busy={null}
      onAdd={() => {}}
      onCheck={() => {}}
      onTest={() => {}}
      onRemove={() => {}}
      onVerifySupport={() => {}}
    />,
  )

test('empty: one field and Continue for the owner, the From line now, Reply-To not confirmed', () => {
  const html = render(data())
  expect(html).toContain('Send from')
  expect(html).toContain('>Continue<')
  expect(html).toContain('no-reply@linedesk.ai')
  expect(html).toContain('once you confirm it')
  expect(html).toContain('Confirm…')
})

test('pending: the records with Copy buttons, Check now and Remove; no test email yet', () => {
  const html = render(data({ sender: pending }))
  expect(html).toContain('resend._domainkey.mail')
  expect(html).toContain('priority 10')
  expect(html).toContain('>Check now<')
  expect(html).toContain('Remove…')
  expect(html).not.toContain('Send a test email')
  expect(html.match(/>Copy value</g)).toHaveLength(2)
})

test('verified: no records, the test email; the team sees no buttons', () => {
  const verified = { ...pending, status: 'verified' as const }
  const html = render(
    data({ sender: verified, support: { address: 'help@cascade.example', verified: true, draft: null } }),
  )
  expect(html).not.toContain('resend._domainkey.mail')
  expect(html).toContain('Send a test email')
  expect(html).toContain('Replies go to help@cascade.example.')
  const team = render(data({ sender: verified, canEdit: false }))
  expect(team).not.toMatch(/>(Send a test email|Check now|Remove…|Confirm…)</)
  expect(team).toContain('Only the owner can change this.')
})

test('locked, unavailable, and a removal by a server admin', () => {
  expect(render(data({ locked: { brandApproved: false, paid: true } }))).toContain('once your brand is approved')
  expect(render(data({ locked: { brandApproved: true, paid: false } }))).toContain('first invoice is paid')
  expect(render(data({ available: false }))).toContain('not available on this server')
  expect(
    render(data({ removedByAdmin: { address: 'notify@x.example', reason: 'looks like a bank', at: '' } })),
  ).toContain('looks like a bank')
})

test('states and refusals in the page words', () => {
  expect(senderMark('verified')).toBe('works')
  expect(senderMark('pending')).toBe('checking')
  expect(senderLead('failed')).toBe('team.partner.sender.failedLead')
  expect(senderErrorText(Object.assign(new Error('x'), { code: 'domain_taken' }))).toBe(
    'This domain is already in use.',
  )
})
