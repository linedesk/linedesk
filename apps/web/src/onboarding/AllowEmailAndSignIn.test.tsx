import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { AllowedNote, AllowRequestDetails, AllowRequestNote } from './AllowEmailAndSignIn.tsx'

const key = {
  id: 'sk_1',
  prefix: 'lds_abcd1234',
  createdAt: '2026-11-14T10:00:00.000Z',
  expiresAt: '2026-11-15T10:00:00.000Z',
  lastUsedAt: null,
  emailAndSignIn: false,
  emailAndSignInUntil: null,
}

test('the request on the page is a warning note naming the link, with Allow with passkey as its primary button', () => {
  const html = renderToStaticMarkup(<AllowRequestNote linkKey={key} onOpen={() => {}} />)
  expect(html).toContain('k-note-warning')
  expect(html).toContain('Your agent asks to set up email and sign-in')
  expect(html).toContain('lds_abcd1234…')
  expect(html).toMatch(/k-btn-primary[^>]*>.*Allow with passkey/)
})

test('right after Allow: the result as a success note with Withdraw; later the quiet line', () => {
  const now = renderToStaticMarkup(<AllowedNote until={key.expiresAt} justNow busy={false} onWithdraw={() => {}} />)
  expect(now).toContain('k-note-success')
  expect(now).toContain('Your agent can now set up email and sign-in')
  expect(now).toContain('Withdraw')
  const later = renderToStaticMarkup(
    <AllowedNote until={key.expiresAt} justNow={false} busy={false} onWithdraw={() => {}} />,
  )
  expect(later).not.toContain('k-note')
  expect(later).toContain('This link can also change email and sign-in until')
})

test('the dialog shows what the agent asked for, from where and with which client, and when the link was last used', () => {
  const html = renderToStaticMarkup(
    <AllowRequestDetails
      linkKey={{
        ...key,
        lastUsedAt: '2026-11-14T10:05:00.000Z',
        request: {
          at: '2026-11-14T10:04:00.000Z',
          ip: '203.0.113.7',
          client: 'claude-code/2.1',
          what: 'Set up email with SMTP (server mail.example.com:465)',
        },
      }}
    />,
  )
  expect(html).toContain('Set up email with SMTP (server mail.example.com:465)')
  expect(html).toContain('from 203.0.113.7')
  expect(html).toContain('(claude-code/2.1)')
  expect(html).toContain('Link last used')
  expect(renderToStaticMarkup(<AllowRequestDetails linkKey={key} />)).toBe('')
})
