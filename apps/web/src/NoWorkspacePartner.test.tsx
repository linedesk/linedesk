// Signed in through a partner team invitation's link and left before Join (the passkey prompt, Not now): the page
// without a workspace lists the open partner invitation with Join, never only "Waiting for an invitation" (LIN-776, B5).
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { PartnerInvitationList } from './NoWorkspace.tsx'

test('an open partner team invitation is listed with its partner, the role and Join', () => {
  const html = renderToStaticMarkup(
    <PartnerInvitationList
      invitations={[
        { id: 'pinv_1', partnerName: 'Northfield Tech', role: 'owner', invitedBy: 'Mike Brennan' },
        { id: 'pinv_2', partnerName: 'Pinecrest IT', role: 'admin', invitedBy: null },
      ]}
      onJoined={() => {}}
    />,
  )
  expect(html).toContain('<b>Northfield Tech</b> invited you to its partner team as its owner.')
  expect(html).toContain('<b>Pinecrest IT</b> invited you to its partner team as an admin.')
  expect(html.match(/>Join the team</g)?.length).toBe(2)
})
