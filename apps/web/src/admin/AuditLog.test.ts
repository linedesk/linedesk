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
    // Only the host: a webhook URL's path or query can carry a bearer token.
    expect(label('webhook.create', { url: 'https://hooks.example.com/x?token=secret' })).toBe(
      'Added a webhook to hooks.example.com',
    )
    expect(label('webhook.update', { enabled: false })).toBe('Changed a webhook')
  })
})
