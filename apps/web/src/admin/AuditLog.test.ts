import { describe, expect, test } from 'vitest'
import { auditLabel } from './AuditLog.tsx'

const label = (what: string, input: unknown = {}, subject: string | null = null) =>
  auditLabel({ what, method: null, input, subject: subject ? { email: subject } : null })

describe('audit labels', () => {
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

  test('API keys and webhooks', () => {
    expect(label('apiKey.create', { name: 'Zapier', role: 'member' })).toBe('Created API key “Zapier”')
    expect(label('apiKey.revoke', { apiKeyId: 'k' })).toBe('Revoked an API key')
    expect(label('webhook.create', { url: 'https://hooks.example.com/x' })).toBe(
      'Added a webhook to https://hooks.example.com/x',
    )
    expect(label('webhook.update', { enabled: false })).toBe('Changed a webhook')
  })
})
