// Settings during support access: read-only like a member's, API keys aside, with a note that says why.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { SupportAccessContext } from '../supportAccess.ts'
import { settingsAccess, useReadOnlyNote } from './readOnly.ts'

const imp = {
  by: { id: 'a', name: 'Mike Brennan', email: 'mike@linedesk.test' },
  user: { id: 'u', name: 'Mike Brennan', email: 'mike@brightwater.example' },
  expiresAt: '2100-01-01T00:00:00.000Z',
}
const owner = ['settings:write', 'team:write', 'workspace:own']

test('owners and admins change settings in their own session; during support access only API keys', () => {
  expect(settingsAccess({ permissions: owner, impersonation: null })).toEqual({ canEdit: true, canManageKeys: true })
  expect(settingsAccess({ permissions: owner, impersonation: imp })).toEqual({ canEdit: false, canManageKeys: true })
  expect(settingsAccess({ permissions: ['call:write'], impersonation: null })).toEqual({
    canEdit: false,
    canManageKeys: false,
  })
})

function Note() {
  return <p>{useReadOnlyNote()}</p>
}
const note = (supportAccess: boolean) =>
  renderToStaticMarkup(
    <SupportAccessContext.Provider value={supportAccess}>
      <Note />
    </SupportAccessContext.Provider>,
  )

test('the read-only note says why: support access, else only admins', () => {
  expect(note(false)).toBe('<p>Only admins can change this.</p>')
  expect(note(true)).toBe('<p>Read-only while you are signed in as another user.</p>')
})
