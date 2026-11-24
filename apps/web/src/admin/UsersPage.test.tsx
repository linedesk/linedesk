// Server admin › Users › a user (UsersPage.tsx UserDetail): the terms they accepted last (A9, LIN-420), or none.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { AdminUser } from './api.ts'
import { UserDetail } from './UsersPage.tsx'

const user: AdminUser = {
  id: 'u1',
  name: 'Mike Brennan',
  email: 'mike@brightwater.test',
  created_at: '2026-11-01T10:00:00.000Z',
  disabled_at: null,
  last_sign_in_at: null,
  instance_admin: false,
  instance_admin_by_env: false,
  workspaces: [],
  invitations: [],
}
const detail = (u: AdminUser) =>
  renderToStaticMarkup(
    <UserDetail user={u} workspaces={[]} currentUserId="admin" notify={() => {}} reload={async () => {}} />,
  )

test('the terms accepted last: the version and when', () => {
  const html = detail({
    ...user,
    terms: {
      terms_version: '2026-11-18',
      privacy_version: '2026-11-10',
      source: 'terms_update',
      accepted_at: '2026-11-18T09:30:00.000Z',
    },
  })
  expect(html).toContain('Terms accepted')
  expect(html).toContain('Version 2026-11-18')
})

test('none recorded (or an older API without the field)', () => {
  expect(detail({ ...user, terms: null })).toContain('None recorded')
  expect(detail(user)).toContain('None recorded')
})
