// The invitation page (AcceptInvite.tsx) for an invitation accepted already: its member opening the link again goes
// into the workspace instead of reading "This invitation is no longer valid" (UI cleanup U6). The server names the
// workspace only to the invited account signed in (security review of #1324, L-1); everyone else gets the bare status.
import { expect, test } from 'vitest'
import { acceptedInviteStep } from './AcceptInvite.tsx'

const accepted = { status: 'accepted' as const, workspaceId: 'ws_1' }
const acceptedBare = { status: 'accepted' as const }
const account = (email: string) => ({ email, emailVerified: true })

test('the member who accepted it opens the workspace the server named for them', () => {
  expect(acceptedInviteStep(accepted, account('jamie@brightwater.example'))).toBe('open')
})

test('signed out: the sign-in page, which leads back here', () => {
  expect(acceptedInviteStep(acceptedBare, null)).toBe('signIn')
  expect(acceptedInviteStep(accepted, null)).toBe('signIn')
})

test('another account (or a session the server did not take): no workspace named, the link is spent', () => {
  expect(acceptedInviteStep(acceptedBare, account('dana@brightwater.example'))).toBe('spent')
  // Even the invited address: what the server answered decides, never the address in the browser.
  expect(acceptedInviteStep(acceptedBare, account('jamie@brightwater.example'))).toBe('spent')
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
