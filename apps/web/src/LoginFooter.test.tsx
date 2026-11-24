import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { AuthMethods } from './auth.ts'
import { AuthFooter, CodeStep, signupLinkFor } from './Login.tsx'
import { noAccountText } from './sign-in-code.ts'
import { AuthError } from './ui/AuthError.tsx'

const methods = (over: Partial<AuthMethods> = {}): AuthMethods => ({
  password: true,
  emailCode: true,
  passkey: true,
  sso: [],
  links: { terms: null, privacy: null, supportEmail: 'support@brightwater.example' },
  ...over,
})
const footer = (over: Partial<AuthMethods> = {}) => renderToStaticMarkup(<AuthFooter methods={methods(over)} />)

test('sign-up open: the footer links to the sign-up page; the support address is its own line', () => {
  const out = footer({ selfServeSignup: true })
  expect(out).toContain(
    '<p class="auth-note">No account? <a class="k-link" href="/signup">Start your free trial</a></p><p class="auth-note">Need help? Write to <a class="k-link" href="mailto:support@brightwater.example">support@brightwater.example</a></p>',
  )
  expect(out).not.toContain('Ask your workspace admin for an invitation')
  expect(out).not.toContain('Or write to')
})

test('the links under the card: Terms and Privacy only, no Help (the support line above has the address)', () => {
  const out = footer({
    links: {
      terms: 'https://x.example/terms',
      privacy: 'https://x.example/privacy',
      supportEmail: 'support@brightwater.example',
    },
  })
  const legal = out.slice(out.indexOf('<nav class="auth-legal"'), out.indexOf('</nav>'))
  expect(legal).toContain('>Terms<')
  expect(legal).toContain('>Privacy<')
  expect(legal).not.toContain('mailto:')
  expect(legal).not.toContain('Help')
})

test('sign-up closed (or an older API without the flag): the footer sends people to ask for an invitation', () => {
  for (const out of [footer({ selfServeSignup: false }), footer()]) {
    expect(out).toContain('No account? Ask your workspace admin for an invitation.')
    expect(out).not.toContain('/signup')
  }
})

test('"No account for this email" links to the sign-up page only while sign-up is open', () => {
  expect(signupLinkFor(noAccountText(), true)).toEqual({ href: '/signup', label: 'Or start your free trial' })
  expect(signupLinkFor(noAccountText(), false)).toBeUndefined()
  expect(signupLinkFor(noAccountText(), undefined)).toBeUndefined()
  // Any other error gets no sign-up link.
  expect(signupLinkFor('That code is not right. Check the email and try again.', true)).toBeUndefined()
  expect(signupLinkFor(null, true)).toBeUndefined()
  const out = renderToStaticMarkup(<AuthError message={noAccountText()} link={signupLinkFor(noAccountText(), true)} />)
  expect(out).toContain('Ask your workspace admin for an invitation.')
  expect(out).toContain('<a href="/signup">Or start your free trial</a>')
})

test('the code step takes the flag along (no error is shown before a try)', () => {
  const out = renderToStaticMarkup(
    <CodeStep email="dana@brightwater.example" selfServeSignup onDone={async () => {}} onDifferentEmail={() => {}} />,
  )
  expect(out).not.toContain('/signup')
})
