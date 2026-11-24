import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { SignInLink, takeSignInLinkToken } from './SignInLink.tsx'

afterEach(() => vi.unstubAllGlobals())

function at(hash: string) {
  const replaceState = vi.fn()
  vi.stubGlobal('window', { location: { hash, pathname: '/', search: '' }, history: { replaceState } })
  return replaceState
}

test('the token is read once from the fragment and the address loses it at once', () => {
  const replaceState = at('#sign-in=abc_DEF-123')
  expect(takeSignInLinkToken()).toBe('abc_DEF-123')
  expect(replaceState).toHaveBeenCalledWith(null, '', '/')
})

test('on the sign-up page the address keeps its page and plan: Continue goes on there', () => {
  const replaceState = vi.fn()
  vi.stubGlobal('window', {
    location: { hash: '#sign-in=abc_DEF-123', pathname: '/signup', search: '?plan=partner' },
    history: { replaceState },
  })
  expect(takeSignInLinkToken()).toBe('abc_DEF-123')
  expect(replaceState).toHaveBeenCalledWith(null, '', '/signup?plan=partner')
})

test('any other address is no sign-in link and stays as it is', () => {
  const replaceState = at('#calls')
  expect(takeSignInLinkToken()).toBeNull()
  expect(replaceState).not.toHaveBeenCalled()
})

test('the page opens checking the link: a skeleton, nothing to click before the server answered', () => {
  const out = renderToStaticMarkup(<SignInLink token="t" onDone={async () => {}} onLeave={() => {}} />)
  expect(out).toContain('aria-busy="true"')
  expect(out).not.toContain('<button')
})
