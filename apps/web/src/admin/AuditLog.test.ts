import { describe, expect, test } from 'vitest'
import { auditLabel, auditReason } from './AuditLog.tsx'

const label = (what: string, input: unknown = {}, subject: string | null = null) =>
  auditLabel({ what, method: null, input, subject: subject ? { email: subject } : null })
const transfers = (what: string, changes: { added?: string[]; changed?: string[]; removed?: string[] }) =>
  auditLabel({
    what,
    method: null,
    input: {},
    subject: null,
    transferChanges: { added: [], changed: [], removed: [], ...changes },
  })

describe('audit labels', () => {
  test('changes of transfer contacts say whom; the countries say which', () => {
    expect(transfers('assistant.update', { added: ['Sarah', 'Ana'], removed: ['Mike'] })).toBe(
      'Changed the transfer contacts (added Sarah and Ana, removed Mike)',
    )
    expect(transfers('assistant.update', {})).toBe('Changed the transfer contacts (new order)')
    expect(transfers('assistant.restoreVersion', { changed: ['Mike'] })).toBe(
      'Restored an earlier assistant version, which changed the transfer contacts (changed Mike)',
    )
    // A refused change has no result: its input had the contacts.
    expect(label('assistant.update', { transfers: [{ id: 'oncall', name: 'Mike', number: '…0199' }] })).toBe(
      'Changed the transfer contacts',
    )
    // An assistant change without one (done by an AI agent or while signed in as someone) keeps its name.
    expect(label('assistant.update', { greeting: 'Hi' })).toBe('assistant.update')
    expect(label('outboundCountries.set', { countries: ['CA', 'MX'] })).toBe('Allowed calls to other countries: CA, MX')
    expect(label('outboundCountries.set', { countries: [] })).toBe('Allowed no calls to other countries')
  })

  test('branding says when Powered by Linedesk was hidden', () => {
    expect(label('branding.set', { name: 'Front Desk', starPrompt: true, poweredBy: true })).toBe(
      'Changed the branding to “Front Desk”',
    )
    expect(label('branding.set', { name: 'Front Desk', starPrompt: true, poweredBy: false })).toBe(
      'Changed the branding to “Front Desk”, Powered by Linedesk hidden',
    )
  })

  test('team and membership changes say whom they were about', () => {
    expect(label('team.setRole', { memberId: 'm1', role: 'admin' }, 'ana@example.com')).toBe(
      'Made ana@example.com an admin',
    )
    expect(label('membership.setRole', { memberId: 'm1', role: 'owner' }, 'ana@example.com')).toBe(
      'Made ana@example.com owner',
    )
    expect(label('team.removeMember', { memberId: 'm1' }, 'ana@example.com')).toBe(
      'Removed ana@example.com from the workspace',
    )
    expect(label('membership.add', { role: 'owner' }, 'op@example.com')).toBe('Added op@example.com as owner')
    expect(label('team.revokeInvite', {}, 'new@example.com')).toBe('Revoked the invitation to new@example.com')
    expect(label('team.leave')).toBe('Left the workspace')
    // Entries recorded before the subject was kept still read as a sentence.
    expect(label('team.removeMember', { memberId: 'm1' })).toBe('Removed a member from the workspace')
  })

  test("an owner's or admin's changes to a teammate say whom and what", () => {
    expect(label('team.updateMemberProfile', { memberId: 'm1', name: 'Sam' }, 'sam@example.com')).toBe(
      'Changed the name of sam@example.com',
    )
    expect(label('team.setMemberAvatar', { memberId: 'm1', avatar: '[redacted]' }, 'sam@example.com')).toBe(
      'Changed the picture of sam@example.com',
    )
    expect(label('team.removeMemberAvatar', { memberId: 'm1' }, 'sam@example.com')).toBe(
      'Removed the picture of sam@example.com',
    )
    expect(
      label('team.updateMemberNotifications', { memberId: 'm1', email: false, setupEmails: true }, 'sam@example.com'),
    ).toBe('Changed the notifications of sam@example.com (email for every call, setup emails)')
  })

  test('Add user says whom, as what, and server admin', () => {
    expect(
      label('user.invite', { email: 'ana@example.com', workspaceId: 'w1', role: 'admin' }, 'ana@example.com'),
    ).toBe('Added ana@example.com as an admin')
    expect(label('user.invite', { email: 'op@example.com', admin: true, workspaceId: null })).toBe(
      'Added op@example.com as server admin',
    )
    expect(label('user.invite', { email: 'op@example.com', admin: true, workspaceId: 'w1', role: 'owner' })).toBe(
      'Added op@example.com as owner and server admin',
    )
    // Entries from before Add user had a workspace.
    expect(label('user.invite', { email: 'old@example.com' })).toBe('Added old@example.com')
  })

  test('API keys and webhooks', () => {
    expect(label('apiKey.create', { name: 'Zapier', role: 'member' })).toBe('Created API key “Zapier”')
    expect(label('apiKey.revoke', { apiKeyId: 'k' })).toBe('Revoked an API key')
    expect(label('agentSetup.endOwnAccess', {})).toBe('AI agent ended its own setup link')
    // Only the host: a webhook URL's path or query can carry a bearer token.
    expect(label('webhook.create', { url: 'https://hooks.example.com/x?token=secret' })).toBe(
      'Added a webhook to hooks.example.com',
    )
    expect(label('webhook.update', { enabled: false })).toBe('Changed a webhook')
  })
})

// A copy of the keys of AUDITED_ACTIONS (apps/api/src/audit.ts): add a new audited action here and give it a label.
const AUDITED_ACTION_NAMES = [
  'provider.setKeys', 'provider.clearKeys', 'provider.setActive', 'provider.connectOneKey', 'carrier.set',
  'carrier.provisionTransferTrunk', 'voiceCloning.set', 'voicePipelinePolicy.set', 'setupEmails.set', 'user.invite',
  'user.disable', 'user.enable', 'workspace.disable', 'workspace.enable', 'workspace.delete', 'workspace.setSpendingCap',
  'instanceAdmin.grant', 'instanceAdmin.revoke', 'user.resetPasskeys', 'user.issuePasskeyEnrolment', 'branding.set',
  'user.impersonate', 'impersonation.stop', 'impersonationEmails.set', 'team.invite', 'team.resendInvite', 'team.revokeInvite', 'team.setRole',
  'team.transferOwnership', 'team.removeMember', 'team.leave', 'team.updateMemberProfile', 'team.setMemberAvatar',
  'team.removeMemberAvatar', 'team.updateMemberNotifications', 'workspace.deleteOwn', 'invitation.accept',
  'invitation.decline', 'membership.add', 'workspace.create', 'membership.setRole', 'membership.remove',
  'invitation.revoke', 'invitation.resend', 'apiKey.create', 'apiKey.revoke', 'webhook.create', 'webhook.update',
  'webhook.delete', 'webhook.test', 'calendar.connectFinish', 'calendar.disconnect', 'phoneNumber.setup',
  'phoneNumber.release', 'agentSetup.createKey', 'agentSetup.confirmPasskey', 'agentSetup.withdrawPasskey',
  'agentSetup.revoke', 'agentSetup.endOwnAccess', 'agentSetup.createWorkspaceKey', 'agentSetup.revokeWorkspace',
]

describe('every audited action reads as words', () => {
  test.each(AUDITED_ACTION_NAMES)('%s has a label', what => {
    expect(label(what)).not.toBe(what)
    expect(label(what, { name: 'Brightwater Plumbing & Heating' }, 'mike@example.com')).not.toBe(what)
  })

  test('server admin, setup link, calendar and number entries', () => {
    expect(label('instanceAdmin.grant', { userId: 'u1' })).toBe('Made someone a server admin')
    expect(label('user.disable', { userId: 'u1' })).toBe('Disabled a user')
    // Since E4 their handlers keep whom it was about.
    expect(label('instanceAdmin.grant', { userId: 'u1' }, 'mike@example.com')).toBe(
      'Made mike@example.com a server admin',
    )
    expect(label('instanceAdmin.revoke', { userId: 'u1' }, 'mike@example.com')).toBe(
      'Removed mike@example.com as server admin',
    )
    expect(label('user.disable', { userId: 'u1' }, 'mike@example.com')).toBe('Disabled mike@example.com')
    expect(label('user.enable', { userId: 'u1' }, 'mike@example.com')).toBe('Enabled mike@example.com')
    expect(label('workspace.setSpendingCap', { workspaceId: 'w1', capUsd: 50 })).toBe('Set the spending cap to $50')
    expect(label('workspace.setSpendingCap', { workspaceId: 'w1', capUsd: null })).toBe('Removed the spending cap')
    expect(label('workspace.create', { name: 'Brightwater Plumbing & Heating' }, 'mike@example.com')).toBe(
      'Created the workspace “Brightwater Plumbing & Heating” with owner mike@example.com',
    )
    expect(label('workspace.deleteOwn', { name: 'Brightwater Plumbing & Heating' })).toBe(
      'Owner deleted the workspace “Brightwater Plumbing & Heating”',
    )
    expect(label('agentSetup.createKey')).toBe('Created an AI agent setup link')
    expect(label('calendar.connectFinish', { provider: 'google', state: '[redacted]' })).toBe(
      'Connected a Google calendar',
    )
    expect(label('phoneNumber.setup', { areaCode: '503', purchase: true })).toBe('Bought a phone number')
    expect(label('phoneNumber.setup', { e164: '+15035550142', purchase: false })).toBe('Connected a phone number')
  })
})

test('an invitation passed to the owner names the invited address (LIN-264)', () => {
  expect(auditLabel({ what: 'invitation_reassigned', method: 'new@example.com', input: null, subject: null })).toBe(
    "Invitation to new@example.com passed to the workspace owner: its sender's account was deleted",
  )
  // The owner it passed to, while that account exists (review F4).
  expect(auditLabel({ what: 'invitation_reassigned', method: 'new@example.com', input: null, subject: { email: 'mike@example.com' } })).toBe(
    "Invitation to new@example.com passed to the workspace owner mike@example.com: its sender's account was deleted",
  )
})

test("a removed member's invitation that the removal canceled (LIN-264 review F1)", () => {
  expect(auditLabel({ what: 'invitation_withdrawn', method: 'new@example.com', input: null, subject: null })).toBe(
    'Invitation to new@example.com canceled: its sender was removed from the workspace',
  )
})

test('entries without a name, an address or a host still read as a sentence', () => {
  expect(label('branding.set', { poweredBy: false })).toBe('Changed the branding, Powered by Linedesk hidden')
  expect(label('apiKey.create', {})).toBe('Created an API key')
  expect(label('workspace.create', {})).toBe('Created the workspace')
  expect(label('webhook.create', { url: 'not a url/' })).toBe('Added a webhook to a URL')
  expect(label('provider.setActive', { provider: 'deepgram', category: 'stt' })).toBe('Picked deepgram for stt')
  expect(label('provider.setActive', {})).toBe('Picked none for a category')
  expect(label('membership.add', { role: 'admin' })).toBe('Added a member as an admin')
  expect(label('team.updateMemberNotifications', { pushSummary: true })).toBe(
    'Changed the notifications of a member (push summary)',
  )
  expect(label('team.updateMemberNotifications', {})).toBe('Changed the notifications of a member (none)')
  expect(label('workspace.setSpendingCap', { capUsd: 12.5 })).toBe('Set the spending cap to $12.50')
  expect(auditLabel({ what: 'sign_in', method: 'email_code', input: null, subject: null })).toBe(
    'Signed in with email code',
  )
  expect(auditLabel({ what: 'provider_linked', method: 'github', input: null, subject: null })).toBe(
    'Added GitHub sign-in',
  )
})

describe('signing in as a user', () => {
  test('names whom it was and shows the reason; older entries without either still read', () => {
    expect(label('user.impersonate', { userId: 'u1', reason: 'Ticket 7' }, 'mike@example.com')).toBe(
      'Signed in as mike@example.com',
    )
    expect(label('user.impersonate', { userId: 'u1' })).toBe('Signed in as a user')
    expect(auditReason({ what: 'user.impersonate', input: { userId: 'u1', reason: ' Ticket 7 ' } })).toBe(
      'Reason: Ticket 7',
    )
    expect(auditReason({ what: 'user.impersonate', input: { userId: 'u1' } })).toBeNull()
    expect(auditReason({ what: 'team.invite', input: { reason: 'x' } })).toBeNull()
    expect(label('impersonationEmails.set', { on: true })).toBe('Turned on emails to users when an admin signs in as them')
  })
})
