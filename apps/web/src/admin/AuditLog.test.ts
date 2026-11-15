import { describe, expect, test } from 'vitest'
import { auditLabel } from './AuditLog.tsx'

const label = (what: string, input: unknown = {}, subject: string | null = null) =>
  auditLabel({ what, method: null, input, subject: subject ? { email: subject } : null })

describe('audit labels', () => {
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
  'user.impersonate', 'impersonation.stop', 'team.invite', 'team.resendInvite', 'team.revokeInvite', 'team.setRole',
  'team.transferOwnership', 'team.removeMember', 'team.leave', 'team.updateMemberProfile', 'team.setMemberAvatar',
  'team.removeMemberAvatar', 'team.updateMemberNotifications', 'workspace.deleteOwn', 'invitation.accept',
  'invitation.decline', 'membership.add', 'workspace.create', 'membership.setRole', 'membership.remove',
  'invitation.revoke', 'invitation.resend', 'apiKey.create', 'apiKey.revoke', 'webhook.create', 'webhook.update',
  'webhook.delete', 'webhook.test', 'calendar.connectFinish', 'calendar.disconnect', 'phoneNumber.setup',
  'phoneNumber.release', 'agentSetup.createKey', 'agentSetup.confirmPasskey', 'agentSetup.withdrawPasskey',
  'agentSetup.revoke', 'agentSetup.endOwnAccess',
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
