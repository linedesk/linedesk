// The passkey prompt's one line why, by how this device signed in (AddPasskey.tsx useWhy): the email code, a named
// provider, or an SSO that kept the default label, whose name ("Single sign-on") says nothing.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { PasskeyCard } from './AddPasskey.tsx'
import { rememberSignInMethod } from './sign-in-methods.ts'

afterEach(() => vi.unstubAllGlobals())

const card = (signIn: () => void) => {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => memory.set(k, v),
    removeItem: (k: string) => memory.delete(k),
  })
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  signIn()
  return renderToStaticMarkup(
    <PasskeyCard account="u1" needsEnrolmentCode={false} onAdded={() => {}} onClose={() => {}} />,
  )
}

test('after the email code: no code next time', () => {
  expect(card(() => rememberSignInMethod('email'))).toContain('Sign in faster next time, with no code.')
})

test('after Google or a custom-named SSO: without that provider', () => {
  expect(card(() => rememberSignInMethod('google', 'Google'))).toContain(
    'Sign in with one touch next time, without Google.',
  )
  expect(card(() => rememberSignInMethod('oidc', 'Okta'))).toContain('Sign in with one touch next time, without Okta.')
})

test('after an SSO that kept its default label: no provider name', () => {
  const html = card(() => rememberSignInMethod('oidc', ''))
  expect(html).toContain('Sign in with one touch next time.')
  expect(html).not.toContain('without')
})
