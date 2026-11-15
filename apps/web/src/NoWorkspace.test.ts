import { describe, expect, it } from 'vitest'
import type { Me } from './auth.ts'
import { mayCreateWorkspace, pendingInvitations } from './NoWorkspace.tsx'

const now = new Date('2026-11-11T12:00:00Z')
const row = (
  over: Partial<{ id: string; organizationName: string; role: string; status: string; expiresAt: string }>,
) => ({
  id: 'inv_1',
  organizationName: 'Alpha Plumbing',
  role: 'member',
  status: 'pending',
  expiresAt: '2026-11-12T12:00:00Z',
  ...over,
})
const me = (permissions: string[], adminSecondFactor: Me['adminSecondFactor'] = null): Me => ({
  actorId: 'u1',
  role: 'member',
  permissions,
  workspace: null,
  onboarding: null,
  phoneSetup: null,
  impersonation: null,
  adminSecondFactor,
})

describe('someone without a workspace', () => {
  it('sees the invitations they can still answer, also one they skipped with "Not now"', () => {
    const rows = [
      row({ id: 'inv_open' }),
      row({ id: 'inv_old', expiresAt: '2026-11-10T12:00:00Z' }),
      row({ id: 'inv_done', status: 'accepted' }),
      row({ id: 'inv_gone', status: 'canceled' }),
    ]
    expect(pendingInvitations(rows, now)).toEqual([{ id: 'inv_open', workspaceName: 'Alpha Plumbing', role: 'member' }])
  })

  it('names a business only as a server admin, also with sign-up open; everyone else waits for an invitation', () => {
    expect(mayCreateWorkspace(null)).toBe(false)
    expect(mayCreateWorkspace(me([]))).toBe(false)
    expect(mayCreateWorkspace(me(['instance:admin']))).toBe(true)
    expect(mayCreateWorkspace(me([], 'confirm'))).toBe(true) // before the passkey prompt
  })
})
