// Account settings during support access: the person's own data is never asked for (the server refuses it), the page
// says so calmly instead of "Your account could not be loaded … Try again".
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

const useQuery = vi.fn(() => ({ data: undefined, error: null, reload: async () => {} }))
vi.mock('../../cachedQuery.ts', async original => ({ ...(await original<object>()), useQuery }))
vi.mock('../../auth.ts', async original => ({
  ...(await original<object>()),
  auth: { useSession: () => ({ data: { user: { email: 'mike@brightwater.example' } } }) },
}))

const { AccountSettings } = await import('./index.tsx')
const { ImpersonatingContext } = await import('../../supportAccess.ts')

test('nothing of the account loads; a note says it is the person’s own', () => {
  vi.stubGlobal('window', { location: { hash: '#account/profile' }, addEventListener: () => {}, removeEventListener: () => {} })
  const html = renderToStaticMarkup(
    <ImpersonatingContext.Provider value>
      <AccountSettings hasWorkspace />
    </ImpersonatingContext.Provider>,
  )
  expect(useQuery).not.toHaveBeenCalled()
  expect(html).toContain('Not available while you are signed in as another user')
  expect(html).toContain('mike@brightwater.example')
  expect(html).not.toContain('Try again')
  vi.unstubAllGlobals()
})
