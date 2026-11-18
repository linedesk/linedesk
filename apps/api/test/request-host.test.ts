// White-label partners' own addresses, PR 5.1 (request-host.ts, docs/white-label.md "Own address"): which address a
// request came in on, 421 for an address that is not set up, 404 for what belongs to the install's own address on a
// partner's, and the trusted origins per host (Better Auth, csrf.ts, the sign-in link page). Writes partner addresses,
// which turn the host check on for the whole install: an instance-wide file (vitest.config.ts).
import { instance_settings, organization, partner_domains, partners, user } from '@linedesk/db'
import { eq, isNotNull } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import {
  forgetHosts,
  HOST_CHECK_KEY,
  hostProbePassed,
  mainHostOnlyAction,
  normaliseHost,
  reloadHosts,
  rememberRequestHost,
  requestHostOf,
  resolveHost,
  trustedOriginsFor,
} from '../src/request-host.ts'
import { actions } from '@linedesk/actions'
import { crossSiteRefusal } from '../src/csrf.ts'
import { auth, trustedOrigins } from '../src/auth.ts'
import { signWithSecretsKey } from '../src/secrets.ts'
import { act, appRequest, asServerAdmin, createWorkspace, request, signUp, type User } from './helpers.ts'
import { addDomain, makeClient, makePartner, onHost, setStatus, signInOn } from './partner-hosts.ts'

/**
 * Runs once in the middle of the next request, after the host middleware and before the /v1 guard reads the caller:
 * for the map changing while a request is under way (security review of #1172, L-1).
 */
const midRequest = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }))
vi.mock('../src/context.ts', async original => {
  const real = await original<typeof import('../src/context.ts')>()
  return {
    ...real,
    resolveCaller: async (...args: Parameters<typeof real.resolveCaller>) => {
      const hook = midRequest.hook
      midRequest.hook = null
      if (hook) await hook()
      return real.resolveCaller(...args)
    },
  }
})

const MAIN = 'http://localhost:5173'
/** The trusted origins on a request to `host` as the map resolves it now. */
const originsOn = (host: string) => trustedOriginsFor([MAIN], resolveHost(host))
/** A fresh probe challenge. */
const nonce = () => crypto.randomUUID().replaceAll('-', '')
describe('an install that never had a partner address (ships dark)', () => {
  // The first test of the file: no row in partner_domains yet in this file's own database.
  test('every host is the install’s own, as before', async () => {
    forgetHosts()
    expect(await db.select().from(partner_domains)).toEqual([])
    await reloadHosts()
    for (const host of ['desk.example.com', '203.0.113.7', '203.0.113.7:8080', 'localhost:3100'])
      expect(resolveHost(host)).toEqual({ kind: 'main' })
    expect((await onHost('desk.example.com', '/v1/auth-methods')).status).toBe(200)
    expect((await onHost('203.0.113.7', '/v1/health')).status).not.toBe(421)
    expect((await onHost('desk.example.com', `/v1/health/host?nonce=${nonce()}`)).status).toBe(404)
    expect(originsOn('desk.example.com')).toEqual([MAIN])
    // Nothing recorded the host check as on.
    expect(await db.select().from(instance_settings).where(eq(instance_settings.key, HOST_CHECK_KEY))).toEqual([])
  })
})

describe('resolveHost', () => {
  let partnerId: string
  let domainId: string
  beforeAll(async () => {
    partnerId = await makePartner()
    domainId = await addDomain(partnerId, 'app.resolve-agency.test', 'active')
  })

  test('normalises case, port and one trailing dot', () => {
    expect(normaliseHost('APP.Resolve-Agency.TEST')).toBe('app.resolve-agency.test')
    expect(normaliseHost('app.resolve-agency.test:443')).toBe('app.resolve-agency.test')
    expect(normaliseHost('app.resolve-agency.test.')).toBe('app.resolve-agency.test')
    expect(normaliseHost('app.resolve-agency.test.:8443')).toBe('app.resolve-agency.test')
    expect(normaliseHost('[::1]:3100')).toBe('[::1]')
    for (const bad of [
      '',
      'app..test',
      'app.test..',
      'app.test:http',
      'a b.test',
      'app.test/x',
      '[::1',
      '[zz]',
      'user@app.test',
    ])
      expect(normaliseHost(bad)).toBeNull()
    for (const host of ['APP.Resolve-Agency.TEST', 'app.resolve-agency.test:443', 'app.resolve-agency.test.'])
      expect(resolveHost(host)).toEqual({
        kind: 'partner',
        partnerId,
        domainId,
        hostname: 'app.resolve-agency.test',
        origin: 'https://app.resolve-agency.test',
      })
  })

  test('the install’s own hosts are main, with any port', () => {
    expect(resolveHost('localhost:5173')).toEqual({ kind: 'main' })
    expect(resolveHost('LOCALHOST')).toEqual({ kind: 'main' })
  })

  test('an unknown host, a malformed one, none and an IP address are unknown once the install has partner addresses', async () => {
    for (const host of [
      'other.resolve-agency.test',
      'resolve-agency.test',
      'app.resolve-agency.test.evil.test',
      'app..x',
      '',
      undefined,
      null,
      '203.0.113.7',
    ])
      expect(resolveHost(host)).toEqual({ kind: 'unknown' })
    // An IP address never counts as a partner's, even as a row.
    await addDomain(await makePartner(), '198.51.100.9', 'active')
    expect(resolveHost('198.51.100.9')).toEqual({ kind: 'unknown' })
  })

  test('only an active address of a partner that is not suspended', async () => {
    const statuses = ['pending', 'verifying', 'failed', 'stopped', 'removed'] as const
    for (const status of statuses) {
      const host = `${status}.resolve-agency.test`
      await addDomain(await makePartner(), host, status)
      expect(resolveHost(host)).toEqual({ kind: 'unknown' })
    }
    // A partner that was never approved (pending) does not resolve either (security review of #1172, L-3).
    const pending = await makePartner('pending')
    await addDomain(pending, 'app.pending-agency.test', 'active')
    expect(resolveHost('app.pending-agency.test')).toEqual({ kind: 'unknown' })
    expect((await onHost('app.pending-agency.test', '/v1/auth-methods')).status).toBe(421)
    const suspended = await makePartner('suspended')
    await addDomain(suspended, 'app.suspended-agency.test', 'active')
    expect(resolveHost('app.suspended-agency.test')).toEqual({ kind: 'unknown' })
    // Approved again: back at once (the map's next load, here right away).
    await db.update(partners).set({ status: 'approved', suspended_at: null }).where(eq(partners.id, suspended))
    await reloadHosts()
    expect(resolveHost('app.suspended-agency.test')).toMatchObject({ kind: 'partner', partnerId: suspended })
  })
})

describe('421 for an address that is not set up', () => {
  beforeAll(async () => {
    await addDomain(await makePartner(), 'app.listed-agency.test', 'active')
  })

  test('on every API path, before anything runs', async () => {
    const paths: [string, string][] = [
      ['GET', '/v1/branding'],
      ['GET', '/v1/me'],
      ['GET', '/v1/auth-methods'],
      ['GET', '/v1/health'],
      ['POST', '/v1/actions/call.markRead'],
      ['POST', '/api/auth/sign-in/email'],
      ['GET', '/api/auth/get-session'],
      ['POST', '/mcp'],
      ['POST', '/oauth/token'],
      ['GET', '/.well-known/oauth-protected-resource'],
      ['GET', '/.well-known/oauth-authorization-server'],
      ['POST', '/v1/sign-in-link/check'],
      ['GET', '/api/unsubscribe/setup'],
    ]
    for (const host of ['unknown.example.com', 'resolve.listed-agency.test', '203.0.113.7']) {
      for (const [method, path] of paths) {
        const res = await onHost(host, path, {
          method,
          ...(method === 'POST' ? { body: {}, origin: `https://${host}` } : {}),
        })
        expect(res.status, `${method} ${path} on ${host}`).toBe(421)
        expect(await res.json()).toMatchObject({ ok: false, code: 'unknown_host', mainOrigin: MAIN })
      }
    }
  })

  test('the API’s own liveness check stays (no host check)', async () => {
    expect((await onHost('unknown.example.com', '/healthz')).status).toBe(200)
  })

  test('the internal entry (the voice agent through the proxy) skips the check', async () => {
    const internal = { 'x-linedesk-entry': 'internal' }
    expect((await onHost('proxy:3100', '/v1/health', { headers: internal })).status).not.toBe(421)
    expect((await onHost('unknown.example.com', '/v1/auth-methods', { headers: internal })).status).toBe(200)
    // Marked public, it is checked as any other.
    expect((await onHost('proxy:3100', '/v1/health', { headers: { 'x-linedesk-entry': 'public' } })).status).toBe(421)
  })

  test('the install’s own address is unchanged', async () => {
    expect((await onHost('localhost:5173', '/v1/auth-methods')).status).toBe(200)
    const ws = await createWorkspace('Main Host Plumbing')
    expect((await request(ws.owner, 'GET', '/v1/me')).status).toBe(200)
    expect((await act(ws.owner, 'call.markRead', { callId: ws.call.id })).status).toBe(200)
  })
})

describe('on a partner’s live address', () => {
  const HOST = 'app.live-agency.test'
  const ORIGIN = `https://${HOST}`
  let ws: Awaited<ReturnType<typeof createWorkspace>>
  let admin: User
  // Signed in on the partner's address (sessions are bound to it, host-sessions.ts).
  let ownerHere: User
  let adminHere: User
  beforeAll(async () => {
    const partnerId = await makePartner()
    await addDomain(partnerId, HOST, 'active')
    ws = await createWorkspace('Partner Host Plumbing')
    await makeClient(ws.id, partnerId)
    admin = await signUp()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, admin.userId))
    // A server admin who is also a member of the partner's client, so the address signs them in at all.
    await auth.api.addMember({ body: { userId: admin.userId, organizationId: ws.id, role: 'admin' } })
    ownerHere = await signInOn(HOST, ws.owner)
    adminHere = await signInOn(HOST, admin)
  })

  test('the app works: reads and writes of a signed-in member, from the address’s own origin', async () => {
    expect((await onHost(HOST, '/v1/auth-methods')).status).toBe(200)
    expect((await onHost(HOST, '/v1/me', { who: ownerHere })).status).toBe(200)
    const res = await onHost(HOST, '/v1/actions/call.markRead', {
      who: ownerHere,
      origin: ORIGIN,
      body: { callId: ws.call.id },
    })
    expect(res.status).toBe(200)
  })

  test('every route of the install’s own address is 404', async () => {
    const routes: [string, string][] = [
      ['GET', '/v1/admin/overview'],
      ['GET', '/v1/admin/workspaces'],
      ['GET', '/v1/admin'],
      ['GET', '//v1/admin/overview'],
      ['GET', '/v1/admin/overview/'],
      ['GET', '/v1/agent/provider-config'],
      ['POST', '/v1/impersonation/start'],
      ['POST', '/mcp'],
      ['POST', '/mcp/setup'],
      ['POST', '/mcp/setup/some-key'],
      ['GET', '/oauth/authorize'],
      ['POST', '/oauth/token'],
      ['POST', '/oauth/register'],
      ['GET', '/.well-known/oauth-protected-resource'],
      ['GET', '/.well-known/oauth-protected-resource/mcp'],
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/.well-known/openid-configuration'],
      ['GET', '/.well-known/openai-apps-challenge'],
      ['GET', '/v1/openapi.json'],
      ['GET', '/v1/signup/config'],
      ['POST', '/v1/signup/code'],
      ['POST', '/v1/signup'],
      ['POST', '/v1/workspaces'],
      ['GET', '/v1/workspace/agent-setup'],
      ['POST', '/v1/setup'],
      ['POST', '/v1/billing/stripe/webhook'],
      ['POST', '/v1/apps/webhook/jobber'],
      ['POST', '/v1/demo/call'],
      ['POST', '/v1/webhooks/test-lookup'],
    ]
    for (const [method, path] of routes) {
      const res = await onHost(HOST, path, {
        method,
        who: admin,
        origin: ORIGIN,
        ...(method === 'POST' ? { body: {} } : {}),
      })
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(await res.json(), `${method} ${path}`).toMatchObject({ code: 'main_host_only' })
    }
  })

  test('Server admin, the partner area, sign-up and the other main-only actions are refused, also for a server admin', async () => {
    const refused: [string, unknown][] = [
      ['workspace.create', { name: 'From a partner host' }],
      ['account.signUp', { plan: 'cloud' }],
      ['instanceAdmin.grant', { userId: ws.owner.userId }],
      ['partner.adminList', {}],
      ['partner.get', { partnerId: 'ptn_any' }],
      ['partner.listClients', { partnerId: 'ptn_any' }],
      ['partnerBrand.get', { partnerId: 'ptn_any' }],
      ['partnerMember.invite', { partnerId: 'ptn_any', email: 'x@linedesk.test' }],
      ['workspace.createForClient', { partnerId: 'ptn_any', name: 'Client' }],
      ['oauth.approve', {}],
      ['oauth.describe', {}],
      ['agentSetup.createKey', {}],
      ['agentSetup.createWorkspaceKey', {}],
      ['billing.startCheckout', {}],
      ['billing.confirmCheckout', {}],
      ['billing.startTopUp', { amountCents: 1000 }],
      ['billing.openPortal', {}],
      ['billing.overview', { partnerId: 'ptn_any' }],
    ]
    await asServerAdmin(admin, async () => {
      for (const [name, input] of refused) {
        for (const who of [adminHere, ownerHere]) {
          const res = await onHost(HOST, `/v1/actions/${name}`, { who, origin: ORIGIN, body: input })
          expect(res.status, name).toBe(404)
          expect(await res.json(), name).toMatchObject({ code: 'main_host_only' })
        }
      }
      // The session there holds neither Server admin nor the partner area, and the action list offers none of it.
      const me = await (await onHost(HOST, '/v1/me', { who: adminHere })).json()
      expect(me.permissions ?? []).not.toContain('instance:admin')
      const offered = (await (await onHost(HOST, '/v1/me/actions', { who: ownerHere })).json()) as {
        actions?: { name: string }[]
      }
      const names = (offered.actions ?? []).map(a => a.name)
      // billing.overview is refused only for the partner bill (its partnerId), so it stays offered.
      for (const [name] of refused) if (name !== 'billing.overview') expect(names, name).not.toContain(name)
      // On the install's own address, the same server admin keeps Server admin.
      expect((await request(admin, 'GET', '/v1/admin/overview')).status).toBe(200)
    })
  })

  test('mainHostOnlyAction covers every Server admin and partner action of the registry', () => {
    for (const def of actions.values()) {
      if (def.permission === 'instance:admin' || def.permission === 'partner' || /^partner[A-Z.]/.test(def.name))
        expect(mainHostOnlyAction(def, {}), def.name).toBe(true)
    }
    // A workspace's own billing stays; the partner bill (partnerId) is the partner area's.
    expect(mainHostOnlyAction(actions.get('billing.overview')!, {})).toBe(false)
    expect(mainHostOnlyAction(actions.get('billing.overview')!, { partnerId: 'ptn_x' })).toBe(true)
    expect(mainHostOnlyAction(actions.get('call.markRead')!, {})).toBe(false)
  })

  test('the probe signs this address’s id with the checker’s fresh nonce; a saved answer does not pass again', async () => {
    const [row] = await db.select().from(partner_domains).where(eq(partner_domains.hostname, HOST))
    const first = nonce()
    const res = await onHost(HOST, `/v1/health/host?nonce=${first}`)
    expect(res.status).toBe(200)
    const answer = await res.json()
    expect(answer).toEqual({
      ok: true,
      domainId: row!.id,
      proof: signWithSecretsKey('host-probe', `${row!.id}\n${first}`),
    })
    expect(hostProbePassed(row!.id, first, answer)).toBe(true)
    // The same answer replayed to the next check (another nonce), for another id, or changed: failed.
    expect(hostProbePassed(row!.id, nonce(), answer)).toBe(false)
    expect(hostProbePassed('pd_other', first, answer)).toBe(false)
    expect(
      hostProbePassed(row!.id, first, {
        ...answer,
        proof: answer.proof.replace(/^./, (c: string) => (c === '0' ? '1' : '0')),
      }),
    ).toBe(false)
    expect(hostProbePassed(row!.id, first, { ...answer, proof: null })).toBe(false)
    expect(hostProbePassed(row!.id, 'short', answer)).toBe(false)
    // A fresh nonce gets a different proof.
    const second = await (await onHost(HOST, `/v1/health/host?nonce=${nonce()}`)).json()
    expect(second.proof).not.toBe(answer.proof)
    // Without a nonce, or a malformed one: 400.
    for (const query of ['', '?nonce=', '?nonce=short', `?nonce=${'x'.repeat(129)}`, '?nonce=has%20space-0123456789'])
      expect((await onHost(HOST, `/v1/health/host${query}`)).status, query).toBe(400)
    expect((await onHost('localhost:5173', `/v1/health/host?nonce=${first}`)).status).toBe(404)
    expect((await onHost('unknown.example.com', `/v1/health/host?nonce=${first}`)).status).toBe(404)
  })

  test('without SECRETS_KEY the probe gives no proof and every check fails', async () => {
    const [row] = await db.select().from(partner_domains).where(eq(partner_domains.hostname, HOST))
    const key = process.env.SECRETS_KEY
    const n = nonce()
    const withKey = await (await onHost(HOST, `/v1/health/host?nonce=${n}`)).json()
    delete process.env.SECRETS_KEY
    try {
      const answer = await (await onHost(HOST, `/v1/health/host?nonce=${n}`)).json()
      expect(answer).toMatchObject({ ok: true, proof: null })
      expect(hostProbePassed(row!.id, n, answer)).toBe(false)
      // Not even an answer made while the key was there.
      expect(hostProbePassed(row!.id, n, withKey)).toBe(false)
    } finally {
      process.env.SECRETS_KEY = key
    }
  })

  test('the probe also answers an address that is not live yet, which is otherwise refused', async () => {
    const id = await addDomain(await makePartner(), 'app.verifying-agency.test', 'verifying')
    expect(await (await onHost('app.verifying-agency.test', `/v1/health/host?nonce=${nonce()}`)).json()).toMatchObject({
      domainId: id,
    })
    expect((await onHost('app.verifying-agency.test', '/v1/auth-methods')).status).toBe(421)
  })
})

describe('trusted origins per host (Better Auth, CSRF, the sign-in link page)', () => {
  const HOST = 'app.origin-agency.test'
  const ORIGIN = `https://${HOST}`
  const OTHER = 'app.other-origin-agency.test'
  let domainId: string
  let ws: Awaited<ReturnType<typeof createWorkspace>>
  let ownerHere: User
  beforeAll(async () => {
    const partnerId = await makePartner()
    domainId = await addDomain(partnerId, HOST, 'active')
    await addDomain(await makePartner(), OTHER, 'active')
    ws = await createWorkspace('Origin Plumbing')
    await makeClient(ws.id, partnerId)
    ownerHere = await signInOn(HOST, ws.owner)
  })

  /** A cookie-signed write as JSON from `origin` to `host`, with the session made on that address. */
  const write = (host: string, origin: string) =>
    onHost(host, '/v1/actions/call.markRead', {
      who: host === HOST ? ownerHere : ws.owner,
      origin,
      body: { callId: ws.call.id },
    })
  /** A password sign-in through Better Auth from `origin` to `host`. */
  const signIn = (host: string, origin: string) =>
    onHost(host, '/api/auth/sign-in/email', {
      origin,
      body: { email: 'nobody@linedesk.test', password: 'wrong-password-123' },
    })

  test('active: the address trusts its own origin, nobody else does', async () => {
    expect(originsOn(HOST)).toEqual([MAIN, ORIGIN])
    expect(originsOn('localhost:5173')).toEqual([MAIN])
    expect(originsOn(OTHER)).not.toContain(ORIGIN)
    expect(originsOn('unknown.example.com')).toEqual([MAIN])
    expect((await write(HOST, ORIGIN)).status).toBe(200)
    // The install's own origin is still trusted there; another partner's or the address on the main host is not.
    expect((await write(HOST, MAIN)).status).toBe(200)
    for (const [host, origin] of [
      [HOST, `https://${OTHER}`],
      ['localhost:5173', ORIGIN],
      [OTHER, ORIGIN],
      [HOST, `http://${HOST}`],
      [HOST, `${ORIGIN}:8443`],
    ] as const) {
      const res = await write(host, origin)
      expect(res.status, `${origin} → ${host}`).toBe(403)
      expect(await res.json()).toMatchObject({ code: 'cross_site_refused' })
    }
    // A password sign-in is the install's own address's (host-sessions.ts): only email codes and links here.
    const password = await signIn(HOST, ORIGIN)
    expect(password.status).toBe(404)
    expect(await password.json()).toMatchObject({ code: 'main_host_only' })
    // Better Auth skips its own Origin check under test (isTest): what it would check is the list its option gives for
    // the request, the same function.
    // the request, from the host the middleware resolved for that Request (app.ts hands it on with the answer).
    const betterAuthList = (host: string, remembered = true) => {
      const request = new Request(`${MAIN}/api/auth/sign-in/email`, { headers: { host } })
      if (remembered) rememberRequestHost(request, resolveHost(host))
      return (auth.options.trustedOrigins as (request?: Request) => string[])(request)
    }
    expect(betterAuthList(HOST)).toEqual([MAIN, ORIGIN])
    expect(betterAuthList('localhost:5173')).toEqual([MAIN])
    expect(betterAuthList(OTHER)).not.toContain(ORIGIN)
    // A Request the middleware never saw is never trusted for a partner's origin.
    expect(betterAuthList(HOST, false)).toEqual([MAIN])
    expect((auth.options.trustedOrigins as (request?: Request) => string[])()).toEqual([MAIN])
    // The sign-in link page answers only the app's own pages.
    expect((await onHost(HOST, '/v1/sign-in-link/check', { origin: ORIGIN, body: { token: 'x' } })).status).toBe(200)
    expect(
      (await onHost('localhost:5173', '/v1/sign-in-link/check', { origin: ORIGIN, body: { token: 'x' } })).status,
    ).toBe(403)
  })

  test('crossSiteRefusal with the per-host list', () => {
    const req = (origin: string) => ({
      method: 'POST',
      header: (name: string) => ({ cookie: 'session=1', origin, 'content-type': 'application/json' })[name],
    })
    expect(crossSiteRefusal(req(ORIGIN), originsOn(HOST))).toBeNull()
    expect(crossSiteRefusal(req(ORIGIN), originsOn('localhost:5173'))).not.toBeNull()
  })

  test('failed: the address is refused and its origin trusted nowhere', async () => {
    await setStatus(domainId, 'failed')
    expect(originsOn(HOST)).toEqual([MAIN])
    expect((await write(HOST, ORIGIN)).status).toBe(421)
    expect((await write('localhost:5173', ORIGIN)).status).toBe(403)
    expect((await signIn(HOST, ORIGIN)).status).toBe(421)
    await setStatus(domainId, 'active')
    expect((await write(HOST, ORIGIN)).status).toBe(200)
  })

  test('removed: the same, and its session cookie reads nothing there any more', async () => {
    await setStatus(domainId, 'removed')
    expect(originsOn(HOST)).toEqual([MAIN])
    expect((await write(HOST, ORIGIN)).status).toBe(421)
    expect((await onHost(HOST, '/v1/me', { who: ownerHere })).status).toBe(421)
    expect((await write('localhost:5173', ORIGIN)).status).toBe(403)
  })
})

describe('one answer per request, whatever the map does meanwhile (security review of #1172, L-1)', () => {
  const HOST = 'app.midrequest-agency.test'
  const ORIGIN = `https://${HOST}`
  let partnerId: string
  let admin: User
  let adminHere: User
  beforeAll(async () => {
    partnerId = await makePartner()
    await addDomain(partnerId, HOST, 'active')
    const ws = await createWorkspace('Mid-request Plumbing')
    await makeClient(ws.id, partnerId)
    admin = await signUp()
    await auth.api.addMember({ body: { userId: admin.userId, organizationId: ws.id, role: 'admin' } })
    adminHere = await signInOn(HOST, admin)
  })
  const approveAgain = async () => {
    await db.update(partners).set({ status: 'approved', suspended_at: null }).where(eq(partners.id, partnerId))
    await reloadHosts()
  }
  afterEach(async () => {
    midRequest.hook = null
    await approveAgain()
  })

  /** Suspends the partner and loads the map again, in the middle of the next request. */
  const suspendMidRequest = () => {
    midRequest.hook = async () => {
      await db
        .update(partners)
        .set({ status: 'suspended', suspended_at: new Date().toISOString() })
        .where(eq(partners.id, partnerId))
      await reloadHosts()
      expect(resolveHost(HOST)).toEqual({ kind: 'unknown' })
    }
  }

  test('a request that started on the live address keeps Server admin and the partner area off to its end', async () => {
    await asServerAdmin(admin, async () => {
      suspendMidRequest()
      const me = await onHost(HOST, '/v1/me', { who: adminHere })
      expect(midRequest.hook).toBeNull()
      expect(me.status).toBe(200)
      expect((await me.json()).permissions).not.toContain('instance:admin')
      await approveAgain()
      suspendMidRequest()
      const res = await onHost(HOST, '/v1/actions/partner.adminList', { who: adminHere, origin: ORIGIN, body: {} })
      expect(midRequest.hook).toBeNull()
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ code: 'main_host_only' })
    })
    // The next request sees the suspension: refused.
    expect((await onHost(HOST, '/v1/me', { who: adminHere })).status).toBe(421)
  })

  test('the remembered answer, not the map, decides the trusted origins of a request', async () => {
    const context = {}
    rememberRequestHost(context, resolveHost(HOST))
    await db
      .update(partners)
      .set({ status: 'suspended', suspended_at: new Date().toISOString() })
      .where(eq(partners.id, partnerId))
    await reloadHosts()
    expect(requestHostOf(context)).toMatchObject({ kind: 'partner', partnerId })
    expect(trustedOrigins(context)).toEqual([MAIN, ORIGIN])
    // Something the middleware never saw is unknown: no partner origin, and the guard refuses it.
    expect(requestHostOf({})).toEqual({ kind: 'unknown' })
    expect(trustedOrigins({})).toEqual([MAIN])
  })
})

// Last in the file: deletes every partner address.
describe('the host check stays on once an install had a partner address (security review of #1172, L-2)', () => {
  test('the first row records it, and deleting every row (partners deleted, rows cascading) does not switch it off', async () => {
    const [latched] = await db.select().from(instance_settings).where(eq(instance_settings.key, HOST_CHECK_KEY))
    expect(latched).toMatchObject({ value: 'on' })
    // Client workspaces of these partners (made by the tests above) let go of them first, as a partner's removal does.
    await db.update(organization).set({ partnerId: null }).where(isNotNull(organization.partnerId))
    await db.delete(partners)
    expect(await db.select().from(partner_domains)).toEqual([])
    forgetHosts()
    await reloadHosts()
    // A former partner address, any other name: still refused, never served as the install's own.
    for (const host of ['app.resolve-agency.test', 'desk.example.com', '203.0.113.7'])
      expect(resolveHost(host), host).toEqual({ kind: 'unknown' })
    const res = await onHost('app.resolve-agency.test', '/v1/admin/overview')
    expect(res.status).toBe(421)
    expect((await onHost('localhost:5173', '/v1/auth-methods')).status).toBe(200)
  })
})
