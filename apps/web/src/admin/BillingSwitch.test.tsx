// Server admin › Providers › Billing during support access: read-only like every setting then, nothing loaded.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

const useQuery = vi.fn((_key: string | null) => ({ data: undefined, error: null, reload: async () => {} }))
vi.mock('../cachedQuery.ts', async original => ({ ...(await original<object>()), useQuery }))

const { BillingSwitch } = await import('./BillingSwitch.tsx')
const { SupportAccessContext } = await import('../supportAccess.ts')

test('during support access the switch is off limits and the billing state is not asked for', () => {
  const html = renderToStaticMarkup(
    <SupportAccessContext.Provider value>
      <BillingSwitch data={{} as never} />
    </SupportAccessContext.Provider>,
  )
  expect(useQuery).toHaveBeenLastCalledWith(null, expect.any(Function))
  expect(html).toContain('Read-only while you are signed in as another user.')
  expect(html).toMatch(/disabled/)
})
