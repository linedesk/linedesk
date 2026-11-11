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
})
