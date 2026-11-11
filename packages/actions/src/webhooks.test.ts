import type { WebhookEndpoint } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { REDACTED, redactInput, rolePermissions } from './define.ts'
import { applyLocally, type LocalTables } from './index.ts'
import { newWebhookSecret, webhookCreate, webhookDeliveries, webhookDelete, webhookSecretPattern, webhookTest, webhookUpdate } from './webhooks.ts'

describe('webhook actions', () => {
  it('are for owners and admins only', () => {
    for (const def of [webhookCreate, webhookUpdate, webhookDelete, webhookTest, webhookDeliveries]) expect(def.permission).toBe('settings:write')
    expect(rolePermissions.member).not.toContain('settings:write')
  })

  it('make a secret of 32 random bytes, and the command log never keeps it', () => {
    const secret = newWebhookSecret()
    expect(secret).toMatch(webhookSecretPattern)
    expect(newWebhookSecret()).not.toBe(secret)
    const input = { endpointId: 'whe1', url: 'https://example.com/hook', events: ['call.completed'], secret }
    expect(redactInput(webhookCreate, input)).toEqual({ ...input, secret: REDACTED })
  })

  it('switch an endpoint off and on locally; on again clears the failures', () => {
    const row = { id: 'whe1', status: 'disabled', disabled_reason: 'Switched off after 5 failed deliveries', failure_count: 5, events: ['call.completed'] }
    const local = { webhook_endpoints: new Map([['whe1', row]]) } as unknown as LocalTables
    applyLocally(local, webhookUpdate, { endpointId: 'whe1', enabled: true }, '2026-11-11T12:00:00.000Z')
    expect(local.webhook_endpoints.get('whe1')).toMatchObject({ status: 'active', disabled_reason: null, failure_count: 0 })
    applyLocally(local, webhookUpdate, { endpointId: 'whe1', events: ['booking.created'] }, '2026-11-11T12:01:00.000Z')
    expect((local.webhook_endpoints.get('whe1') as WebhookEndpoint).events).toEqual(['booking.created'])
    expect((local.webhook_endpoints.get('whe1') as WebhookEndpoint).status).toBe('active')
  })
})
