// Cross-site requests (csrf.ts): a write under /v1 signed in by the cookie runs only from the web
// app's origin and as JSON; Bearer callers (API keys, the agent) are not affected.
import { describe, expect, test } from 'vitest'
import { crossSiteRefusal } from '../src/csrf.ts'
import { agent, appRequest, createWorkspace, getCall, request, type User } from './helpers.ts'

const WEB = 'http://localhost:5173'

/** A POST as a page on another origin (or the same site's other subdomain) could send it: no preflight needed. */
const forged = (who: User, path: string, init: { origin?: string | null; contentType?: string; body?: string } = {}) => {
  const headers: Record<string, string> = { cookie: who.headers.cookie! }
  if (init.origin !== null) headers.origin = init.origin ?? 'https://evil.localhost'
  headers['content-type'] = init.contentType ?? 'text/plain'
  return appRequest(path, { method: 'POST', headers, body: init.body ?? '{}' })
}

describe('cookie-signed writes under /v1', () => {
  test('from another origin, without one, or not as JSON: 403 before anything runs', async () => {
    const ws = await createWorkspace('CSRF Plumbing')
    const body = JSON.stringify({ callId: ws.call.id })
    const cases = [
      forged(ws.owner, '/v1/actions/call.markDone', { body }),
      forged(ws.owner, '/v1/actions/call.markDone', { body, contentType: 'application/json' }),
      forged(ws.owner, '/v1/actions/call.markDone', { body, origin: null, contentType: 'application/json' }),
      forged(ws.owner, '/v1/actions/call.markDone', { body, origin: WEB }),
      forged(ws.owner, '/v1/actions/call.markDone', { body, origin: WEB, contentType: 'application/x-www-form-urlencoded' }),
      forged(ws.owner, '/v1/actions/instanceAdmin.grant', { body: JSON.stringify({ userId: ws.owner.userId }) }),
      forged(ws.owner, '/v1/workspaces', { body: JSON.stringify({ name: 'Forged' }) }),
      forged(ws.owner, '/v1/impersonation/start', { body: JSON.stringify({ userId: 'someone' }) }),
      forged(ws.owner, '/v1/impersonation/stop'),
      forged(ws.owner, '/v1/account/password', { body: JSON.stringify({ newPassword: 'forged-password-123' }) }),
    ]
    for (const res of await Promise.all(cases)) {
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ code: 'cross_site_refused' })
    }
    expect((await getCall(ws.call.id))?.inbox_state).not.toBe('done')
    // The same write from the web app, as JSON, runs.
    expect((await request(ws.owner, 'POST', '/v1/actions/call.markDone', { callId: ws.call.id })).status).toBe(200)
    expect((await getCall(ws.call.id))?.inbox_state).toBe('done')
  })

  test('reads are not affected, and the JSON content type may carry a charset', async () => {
    const ws = await createWorkspace('CSRF Reads')
    expect((await request(ws.owner, 'GET', '/v1/me', undefined, { origin: 'https://evil.localhost' })).status).toBe(200)
    const res = await forged(ws.owner, '/v1/actions/call.markRead', {
      origin: WEB,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ callId: ws.call.id }),
    })
    expect(res.status).toBe(200)
  })

  test('Bearer callers (agent, API keys) need neither an Origin nor a cookie check; no cookie means the usual 401', async () => {
    const ws = await createWorkspace('CSRF Agent')
    expect((await request(agent(ws.id), 'POST', '/v1/actions/call.markRead', { callId: ws.call.id })).status).not.toBe(403)
    const anonymous = await appRequest('/v1/actions/call.markDone', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
    expect(anonymous.status).toBe(401)
  })
})

test('the rule (unit)', () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, header: (n: string) => headers[n] })
  const trusted = [WEB]
  const cookie = { cookie: 'session=1' }
  expect(crossSiteRefusal(req('GET', cookie), trusted)).toBeNull()
  expect(crossSiteRefusal(req('POST', { ...cookie, origin: WEB, 'content-type': 'application/json' }), trusted)).toBeNull()
  expect(crossSiteRefusal(req('POST', { ...cookie, origin: `${WEB}.evil.example`, 'content-type': 'application/json' }), trusted)).not.toBeNull()
  expect(crossSiteRefusal(req('DELETE', { ...cookie, origin: WEB }), trusted)).not.toBeNull()
  expect(crossSiteRefusal(req('POST', { ...cookie, authorization: 'Bearer ld_key' }), trusted)).toBeNull()
  expect(crossSiteRefusal(req('POST', {}), trusted)).toBeNull()
})
