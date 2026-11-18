// Account settings on a white-label partner's own address (host-sessions.ts on the API): sign-in methods, sessions and
// personal keys are managed at the install's own address, so those sections say where, with a link, and load nothing.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'

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
const useQuery = vi.fn((key: unknown) =>
  key === 'account' || (Array.isArray(key) && key[0] === 'account')
    ? { data: account, error: null, reload: async () => {} }
    : { data: undefined, error: null, reload: async () => {} },
)
vi.mock('../../cachedQuery.ts', async original => ({ ...(await original<object>()), useQuery }))

const { AccountSettings } = await import('./index.tsx')

const render = (hash: string) => {
  vi.stubGlobal('window', { location: { hash }, addEventListener: () => {}, removeEventListener: () => {} })
  return renderToStaticMarkup(<AccountSettings hasWorkspace workspaceName="Brightwater Plumbing & Heating" />)
}
afterEach(() => vi.unstubAllGlobals())

test.each(['security', 'sessions', 'apiKeys'])('%s: a note and a link to the install’s own address', section => {
  const html = render(`#account/${section}`)
  expect(html).toContain('Done at the standard sign-in page')
  expect(html).toContain(`href="https://app.linedesk.ai/#account/${section}"`)
  expect(html).toContain('Open app.linedesk.ai')
})
