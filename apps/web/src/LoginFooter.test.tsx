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

test('sign-up open: the footer links to the sign-up page, the support address stays', () => {
  const out = footer({ selfServeSignup: true })
  expect(out).toContain('No account? <a class="k-link" href="/signup">Start your free trial</a>')
  expect(out).not.toContain('Ask your workspace admin for an invitation')
  expect(out).toContain('Or write to <a class="k-link" href="mailto:support@brightwater.example">')
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
