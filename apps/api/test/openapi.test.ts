import { expect, test } from 'vitest'
import { anonymous, request } from './helpers.ts'

test('GET /v1/openapi.json is public and lists the public actions only', async () => {
  const { status, body } = await request(anonymous, 'GET', '/v1/openapi.json')
  expect(status).toBe(200)
  expect(body.openapi).toBe('3.1.0')
  expect(body.paths['/v1/actions/call.markDone'].post.operationId).toBe('call.markDone')
  expect(body.paths['/v1/actions/call.start']).toBeUndefined()
})
