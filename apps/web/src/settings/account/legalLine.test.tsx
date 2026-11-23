// Terms · Privacy at the foot of Account settings (2026-11-18): not rows of the workspace menu, but reachable in the app,
// with the install's links, or a white-label partner's in its client workspace.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const account = {
  user: { name: 'Mike', email: 'mike@brightwater.example', emailVerified: true, locale: null },
  accounts: [],
  methods: {
    password: false,
    emailCode: true,
    passkey: false,
    sso: [],
    links: {},
    mainOrigin: 'https://app.linedesk.ai',
  },
  avatarUrl: null,
  profileChangedBy: null,
}
let links: { terms: string | null; privacy: string | null; supportEmail: string | null } | null = null
const useQuery = vi.fn((key: unknown) =>
  key === 'account' || (Array.isArray(key) && key[0] === 'account')
    ? { data: account, error: null, reload: async () => {} }
    : key === 'auth-methods'
      ? { data: links ? { links } : undefined, error: null, reload: async () => {} }
      : { data: undefined, error: null, reload: async () => {} },
)
vi.mock('../../cachedQuery.ts', async original => ({ ...(await original<object>()), useQuery }))
let partner: { terms: string | null; privacy: string | null; supportEmail: string | null } | undefined
vi.mock('../../brand.ts', async original => ({
  ...(await original<object>()),
  useBrand: () => ({ partner }),
}))

const { AccountSettings } = await import('./index.tsx')

// On a partner's own address (mainOrigin) the sign-in sections load nothing of their own: only the page is rendered.
const render = (hash = '#account/security') => {
  vi.stubGlobal('window', { location: { hash }, addEventListener: () => {}, removeEventListener: () => {} })
  return renderToStaticMarkup(<AccountSettings hasWorkspace />)
}
beforeEach(() => {
  links = null
  partner = undefined
})
afterEach(() => vi.unstubAllGlobals())

test.each(['security', 'sessions', 'apiKeys'])('%s: Terms · Privacy at the foot, each in a new tab', section => {
  links = { terms: 'https://linedesk.ai/terms', privacy: 'https://linedesk.ai/privacy', supportEmail: null }
  const html = render(`#account/${section}`)
  expect(html).toContain('<nav class="auth-legal ac-legal" aria-label="Terms and privacy">')
  expect(html).toContain('<a href="https://linedesk.ai/terms" target="_blank" rel="noreferrer">Terms</a>')
  expect(html).toContain('<a href="https://linedesk.ai/privacy" target="_blank" rel="noreferrer">Privacy</a>')
})

test('only the links the install has; no line while none are known or set', () => {
  links = { terms: 'https://linedesk.ai/terms', privacy: null, supportEmail: null }
  const one = render()
  expect(one).toContain('>Terms</a>')
  expect(one).not.toContain('>Privacy</a>')
  links = null
  expect(render()).not.toContain('ac-legal')
  links = { terms: null, privacy: null, supportEmail: 'help@linedesk.ai' }
  expect(render()).not.toContain('ac-legal')
})

test('a white-label partner’s client workspace: the partner’s links, never the install’s', () => {
  links = { terms: 'https://linedesk.ai/terms', privacy: 'https://linedesk.ai/privacy', supportEmail: null }
  partner = { terms: 'https://acme.example/terms', privacy: 'https://acme.example/privacy', supportEmail: null }
  const html = render()
  expect(html).toContain('href="https://acme.example/terms"')
  expect(html).toContain('href="https://acme.example/privacy"')
  expect(html).not.toContain('linedesk.ai/terms')
})
