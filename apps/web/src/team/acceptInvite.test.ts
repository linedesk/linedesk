// The invitation page (AcceptInvite.tsx) for an invitation accepted already: its member opening the link again goes
// into the workspace instead of reading "This invitation is no longer valid" (UI cleanup U6).
import { expect, test } from 'vitest'
import { acceptedInviteStep } from './AcceptInvite.tsx'

const accepted = { status: 'accepted' as const, email: 'Jamie@Brightwater.example', workspaceId: 'ws_1' }
const account = (email: string) => ({ email, emailVerified: true })

test('the member who accepted it opens the workspace (the address in any case)', () => {
  expect(acceptedInviteStep(accepted, account('jamie@brightwater.example'))).toBe('open')
})

test('signed out: the sign-in page; another account: the link is spent', () => {
  expect(acceptedInviteStep(accepted, null)).toBe('signIn')
  expect(acceptedInviteStep(accepted, account('dana@brightwater.example'))).toBe('spent')
})

test('nothing to do before the session is known, or for an invitation that is not accepted', () => {
  expect(acceptedInviteStep(accepted, undefined)).toBeNull()
  expect(acceptedInviteStep({ status: 'gone' }, account('jamie@brightwater.example'))).toBeNull()
  expect(acceptedInviteStep(null, null)).toBeNull()
  const pending = {
    status: 'pending' as const,
    email: 'jamie@brightwater.example',
    workspaceName: 'Brightwater',
    invitedBy: 'Mike',
    role: 'member',
  }
  expect(acceptedInviteStep(pending, account('jamie@brightwater.example'))).toBeNull()
})
