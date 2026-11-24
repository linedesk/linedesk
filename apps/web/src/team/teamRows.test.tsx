// Workspace settings › Team rows (UI cleanup S6): one action pattern for members and invitations, the role and then a
// ⋯ menu; no loose Edit, Resend, Revoke or trash buttons in the row; members see one read-only note.
import type { TeamData } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'

let team: TeamData
vi.mock('./team-api.ts', () => ({
  useTeam: () => ({ data: team, error: null, reload: async () => {} }),
  teamApi: {},
}))
vi.mock('../settings/Notifications.tsx', () => ({ NotificationDefaults: () => null }))
vi.mock('../shell/WorkspaceSwitcher.tsx', () => ({ useWorkspaces: () => [] }))

const { TeamSection } = await import('./TeamPage.tsx')

const member = (id: string, role: 'owner' | 'admin' | 'member', name: string) => ({
  memberId: `m_${id}`,
  userId: `u_${id}`,
  name,
  email: `${id}@brightwater.example`,
  role,
  joinedAt: '2026-11-18T08:00:00.000Z',
})
const data = (canManage: boolean, me = 'u_mike'): TeamData => ({
  members: [member('mike', 'owner', 'Mike Brennan'), member('sam', 'member', 'Sam Patel')],
  invitations: [
    {
      invitationId: 'inv_1',
      email: 'casey@brightwater.example',
      role: 'member',
      invitedBy: 'Mike Brennan',
      invitedById: 'u_mike',
      expiresAt: '2100-01-01T00:00:00.000Z',
      expired: false,
    },
  ],
  canManage,
  me,
  partner: null,
})

const render = () => renderToStaticMarkup(<TeamSection toast={() => {}} />)

test('owners and admins: every row ends in the role and one ⋯ menu, no loose action buttons', () => {
  team = data(true)
  const html = render()
  expect(html).toContain('aria-label="Actions for Sam Patel"')
  expect(html).toContain('aria-label="Actions for Mike Brennan"')
  expect(html).toContain('aria-label="Actions for casey@brightwater.example"')
  for (const loose of ['>Resend<', '>Revoke<', '>Edit<', '>Edit profile<', 'aria-label="Remove Sam Patel"'])
    expect(html).not.toContain(loose)
  // The invitation's role sits where a member's role does, not as a row aside.
  expect(html).not.toContain('k-row-aside')
  expect(html).not.toContain('Only admins can change')
})

test('members: one read-only note, the roles as text, a menu only on their own row', () => {
  team = data(false, 'u_sam')
  const html = render()
  expect(html.split('Only admins can change these settings.').length - 1).toBe(1)
  expect(html).toContain('aria-label="Actions for Sam Patel"')
  expect(html).not.toContain('aria-label="Actions for Mike Brennan"')
  expect(html).not.toContain('aria-label="Actions for casey@brightwater.example"')
})
