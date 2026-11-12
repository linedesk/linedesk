import { describe, expect, it } from 'vitest'
import { REDACTED, redactInput, rolePermissions } from './define.ts'
import { applyLocally, type LocalTables } from './index.ts'
import {
  CALLER_DETAILS_MAX_KEYS,
  CALLER_DETAILS_MAX_VALUE,
  callerDetailsFrom,
  callLookUpCaller,
  fillTemplate,
  newWebhookSecret,
  templateNames,
  webhookCreate,
  webhookDeliveries,
  webhookDelete,
  webhookSecretPattern,
  webhookTest,
  webhookUpdate,
} from './webhooks.ts'

describe('webhook actions', () => {
  it('are for owners and admins only; the caller look-up is for the voice agent', () => {
    for (const def of [webhookCreate, webhookUpdate, webhookDelete, webhookTest, webhookDeliveries]) expect(def.permission).toBe('settings:write')
    expect(rolePermissions.member).not.toContain('settings:write')
    expect(callLookUpCaller.permission).toBe('agent')
    expect(callLookUpCaller.readOnly).toBe(true)
  })

  it('are set per assistant with the hooks they get; the command log never keeps the secret', () => {
    const secret = newWebhookSecret()
    expect(secret).toMatch(webhookSecretPattern)
    expect(newWebhookSecret()).not.toBe(secret)
    const input = { endpointId: 'whe1', assistantId: 'as1', url: 'https://example.com/hook', hooks: ['call_start', 'call_end'], secret }
    expect(webhookCreate.input.parse(input)).toEqual(input)
    expect(redactInput(webhookCreate, input)).toEqual({ ...input, secret: REDACTED })
    expect(webhookCreate.input.safeParse({ ...input, hooks: ['call.completed'] }).success).toBe(false)
    expect(webhookCreate.input.parse({ ...input, hooks: [] }).hooks).toEqual([])
    expect(webhookCreate.input.safeParse({ ...input, assistantId: undefined }).success).toBe(false)
  })

  it('switch a webhook off and on locally; on again clears the failures', () => {
    const row = { id: 'whe1', status: 'disabled', disabled_reason: 'Switched off after 5 failed deliveries', failure_count: 5 }
    const local = { webhook_endpoints: new Map([['whe1', row]]) } as unknown as LocalTables
    applyLocally(local, webhookUpdate, { endpointId: 'whe1', enabled: true }, '2026-11-11T12:00:00.000Z')
    expect(local.webhook_endpoints.get('whe1')).toMatchObject({ status: 'active', disabled_reason: null, failure_count: 0 })
    applyLocally(local, webhookUpdate, { endpointId: 'whe1', url: 'https://example.com/other' }, '2026-11-11T12:01:00.000Z')
    expect(local.webhook_endpoints.get('whe1')).toMatchObject({ url: 'https://example.com/other', status: 'active' })
    applyLocally(local, webhookUpdate, { endpointId: 'whe1', hooks: ['call_end', 'call_end'] }, '2026-11-11T12:02:00.000Z')
    expect(local.webhook_endpoints.get('whe1')).toMatchObject({ hooks: ['call_end'] })
  })
})

describe('caller details from a call-start answer', () => {
  it('keeps top-level names with text, number or true/false values', () => {
    expect(callerDetailsFrom({ name: 'Sam', visits: 3, vip: true, plan_2: 'Premium' })).toEqual({ name: 'Sam', visits: 3, vip: true, plan_2: 'Premium' })
  })

  it('leaves out nested values, nulls, odd names and empty texts; null when nothing is left', () => {
    expect(callerDetailsFrom({ name: 'Sam', address: { city: 'Portland' }, tags: ['a'], gone: null, 'bad name': 'x', _x: 'y', blank: '  ', n: Number.NaN })).toEqual({ name: 'Sam' })
    for (const reply of [null, undefined, 'Sam', 42, [], ['a'], {}, { x: null }]) expect(callerDetailsFrom(reply)).toBeNull()
  })

  it('puts texts on one line and cuts them; keeps at most the first names', () => {
    expect(callerDetailsFrom({ note: 'line one\nline\ttwo\u0000 ' })).toEqual({ note: 'line one line two' })
    expect((callerDetailsFrom({ note: 'x'.repeat(500) })!.note as string).length).toBe(CALLER_DETAILS_MAX_VALUE)
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(callerDetailsFrom(many)!)).toHaveLength(CALLER_DETAILS_MAX_KEYS)
  })
})

describe('greeting templates', () => {
  it('lists the caller details a text uses', () => {
    expect(templateNames('Hi {{name}}, {{ name }} again, on {{plan|your plan}}')).toEqual(['name', 'plan'])
    expect(templateNames('Thanks for calling Brightwater.')).toEqual([])
  })

  it('fills in the details, else the fallback, else nothing, and tidies what is left', () => {
    const greeting = 'Hi {{name}}, thanks for calling Brightwater!'
    expect(fillTemplate(greeting, { name: 'Sam' })).toBe('Hi Sam, thanks for calling Brightwater!')
    expect(fillTemplate(greeting, null)).toBe('Hi, thanks for calling Brightwater!')
    expect(fillTemplate('Hello {{name|there}}!', {})).toBe('Hello there!')
    expect(fillTemplate('Welcome back {{name}}.', { name: '' })).toBe('Welcome back.')
    expect(fillTemplate('You have {{visits}} visits.', { visits: 3 })).toBe('You have 3 visits.')
  })

  it('leaves a text without placeholders exactly as it is', () => {
    expect(fillTemplate('Thanks  for calling , Brightwater.', { name: 'Sam' })).toBe('Thanks  for calling , Brightwater.')
  })
})
