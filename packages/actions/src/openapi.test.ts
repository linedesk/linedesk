import { describe, expect, test } from 'vitest'
import { actions } from './index.ts'
import { openApiDocument } from './openapi.ts'

describe('OpenAPI document', () => {
  const doc = openApiDocument(actions.values(), 'https://app.example.com')

  test('lists exactly the public actions', () => {
    const listed = Object.keys(doc.paths).filter(p => p.startsWith('/v1/actions/')).map(p => p.replace('/v1/actions/', ''))
    const published = [...actions.values()].filter(a => a.public).map(a => a.name)
    expect(listed.sort()).toEqual(published.sort())
    expect(listed).toContain('call.markDone')
    for (const internal of ['call.start', 'team.setRole', 'phoneNumber.setup', 'user.disable']) expect(listed).not.toContain(internal)
  })

  test('agent-only, team, settings and admin actions are never public', () => {
    for (const a of actions.values()) if (a.public) expect(['agent', 'instance:admin', 'team:write', 'settings:write']).not.toContain(a.permission)
  })

  test('deleting, cancelling, moving, blocking and filing as spam are marked destructive (MCP: admin keys only)', () => {
    const destructive = [...actions.values()].filter(a => a.destructive).map(a => a.name)
    expect(destructive.sort()).toEqual(['appointment.cancel', 'appointment.reschedule', 'call.delete', 'call.markSpam', 'contact.block', 'contact.delete'])
    for (const a of actions.values()) if (a.destructive) expect(a.public).toBe(true)
  })

  test("each operation carries the action's input schema and Bearer auth", () => {
    const remind = doc.paths['/v1/actions/call.remind']!.post!
    expect(remind.requestBody.content['application/json'].schema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['callId', 'at']),
      properties: { callId: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
    })
    expect(doc.paths['/v1/actions/calendar.findSlots']!.post!.parameters).toEqual([])
    expect(doc.security).toEqual([{ apiKey: [] }])
    expect(doc.servers).toEqual([{ url: 'https://app.example.com' }])
  })

  test("an assistant's three hooks are documented as webhooks: the caller asked about, a lookup, and the whole call", () => {
    type Props = { properties: Record<string, unknown> }
    const body = (hook: 'call_start' | 'during_call' | 'call_end') => doc.webhooks[hook].post.requestBody.content['application/json'].schema as Props
    expect(Object.keys(doc.webhooks).sort()).toEqual(['call_end', 'call_finished', 'call_start', 'call_started', 'during_call', 'during_call_lookup'])
    expect(Object.keys(body('during_call').properties)).toEqual(expect.arrayContaining(['hook', 'lookup', 'values', 'call_id', 'test']))
    expect(Object.keys(body('call_start').properties)).toEqual(expect.arrayContaining(['call_id', 'from_number', 'caller']))
    expect(Object.keys(body('call_end').properties)).toEqual(
      expect.arrayContaining(['call_id', 'summary', 'transcript', 'transcript_text', 'from_number', 'call_url', 'recording_url', 'caller_details']),
    )
  })

  test('the reads for integrations and the call a subscription gets are documented', () => {
    expect(Object.keys(doc.paths).filter(p => !p.startsWith('/v1/actions/')).sort()).toEqual([
      '/v1/api-key',
      '/v1/integrations/calls',
      '/v1/integrations/contacts',
      '/v1/integrations/options/{kind}',
      '/v1/integrations/samples/{event}',
    ])
    const call = doc.webhooks.call_finished.post.requestBody.content['application/json'].schema as { properties: Record<string, unknown> }
    expect(Object.keys(call.properties)).toEqual(expect.arrayContaining(['id', 'event', 'call_id', 'summary', 'caller_name', 'next_steps_text', 'booking_start_at']))
    expect(Object.keys(call.properties)).not.toContain('hook')
    const schema = (event: 'call_started' | 'during_call_lookup') =>
      doc.webhooks[event].post.requestBody.content['application/json'].schema as { properties: Record<string, unknown> }
    expect(Object.keys(schema('call_started').properties)).toEqual(expect.arrayContaining(['id', 'event', 'call_id', 'caller_name', 'caller_verified', 'caller_details']))
    expect(Object.keys(schema('during_call_lookup').properties)).toEqual(expect.arrayContaining(['id', 'event', 'lookup', 'values', 'values_text', 'answer', 'answered']))
    expect(Object.keys(schema('during_call_lookup').properties)).not.toContain('test')
  })
})
