// During support access the agent setup links do not open (the server refuses them): the inbox says why.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

const useQuery = vi.fn((_key: string | null) => ({ data: [{ invitationId: 'i1' }], error: null, reload: async () => {} }))
vi.mock('./cachedQuery.ts', async original => ({ ...(await original<object>()), useQuery }))

const { unknownPageText } = await import('./supportAccess.ts')
const { useMyInvitations } = await import('./shell/invitations.ts')

test('the agent setup pages say they are not available during support access; other addresses do not exist', () => {
  const notAvailable = 'Not available while you are signed in as another user.'
  expect(unknownPageText('#setup-agent', true)).toBe(notAvailable)
  expect(unknownPageText('#setup-agent?allow=k1', true)).toBe(notAvailable)
  expect(unknownPageText('#change-with-agent/workspace', true)).toBe(notAvailable)
  expect(unknownPageText('#nowhere', true)).toBe('That page does not exist.')
  expect(unknownPageText('#setup-agent', false)).toBe('That page does not exist.')
})

function Invitations({ supportAccess }: { supportAccess: boolean }) {
  return <i>{useMyInvitations(supportAccess).invitations.length}</i>
}

test('the invitations are not asked for during support access (the server refuses them)', () => {
  expect(renderToStaticMarkup(<Invitations supportAccess />)).toBe('<i>0</i>')
  expect(useQuery).toHaveBeenLastCalledWith(null, expect.any(Function), { persist: true })
  expect(renderToStaticMarkup(<Invitations supportAccess={false} />)).toBe('<i>1</i>')
  expect(useQuery).toHaveBeenLastCalledWith('invitations', expect.any(Function), { persist: true })
})
