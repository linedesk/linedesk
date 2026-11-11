import { describe, expect, test } from 'vitest'
import { actions } from './index.ts'
import { openApiDocument } from './openapi.ts'

describe('OpenAPI document', () => {
  const doc = openApiDocument(actions.values(), 'https://app.example.com')

  test('lists exactly the public actions', () => {
    const listed = Object.keys(doc.paths).map(p => p.replace('/v1/actions/', ''))
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
    expect(destructive.sort()).toEqual(['appointment.cancel', 'appointment.reschedule', 'call.delete', 'call.markSpam', 'contact.block', 'contact.delete', 'knowledge.removeDocument'])
    // knowledge.removeDocument is not public yet; the flag keeps it off MCP for non-admin keys once it is.
    for (const a of actions.values()) if (a.destructive && a.name !== 'knowledge.removeDocument') expect(a.public).toBe(true)
  })

  test("each operation carries the action's input schema and Bearer auth", () => {
    const remind = doc.paths['/v1/actions/call.remind']!.post
    expect(remind.requestBody.content['application/json'].schema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['callId', 'at']),
      properties: { callId: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
    })
    expect(doc.paths['/v1/actions/calendar.findSlots']!.post.parameters).toEqual([])
    expect(doc.security).toEqual([{ apiKey: [] }])
    expect(doc.servers).toEqual([{ url: 'https://app.example.com' }])
  })

  test('call events are documented as webhooks, with the lead, tag and custom fields', () => {
    const schema = doc.webhooks['call.completed'].post.requestBody.content['application/json'].schema as {
      properties: { data: { properties: { call: { properties: Record<string, unknown> } } } }
    }
    expect(Object.keys(schema.properties.data.properties.call.properties)).toEqual(expect.arrayContaining(['lead', 'tag', 'custom_fields']))
  })
})
