// OAuth sign-in for the MCP server (LIN-126): metadata, client registration (DCR) and metadata documents (CIMD), the
// consent actions, the token endpoint with PKCE, and the key it issues: a personal key that works on /mcp, is listed
// and revoked like the others, and never has Server admin. Instance-wide file (vitest.config.ts): it makes a server admin.
import { createHash, randomBytes } from 'node:crypto'
import { oauth_clients, oauth_codes, personal_keys, session, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import {
  clientMetadata,
  deleteUnusedClients,
  FETCHES_PER_WINDOW,
  forgetClientDocuments,
  forgetRegistrations,
  isPublicAddress,
  issuer,
  mayRegister,
  mcpResource,
  REGISTRATIONS_ALL_PER_HOUR,
  REGISTRATIONS_PER_HOUR,
  redirectKind,
  redirectMatches,
} from '../src/oauth.ts'
import { actorForPersonalKey } from '../src/personal-keys.ts'
import { act, appRequest, createWorkspace, FROM, randomIp, type User, type Workspace } from './helpers.ts'

let ws: Workspace

beforeAll(async () => {
  ws = await createWorkspace('Brightwater Plumbing & Heating')
})
const realFetch = clientMetadata.fetch
afterEach(() => {
  forgetRegistrations()
  forgetClientDocuments()
  clientMetadata.fetch = realFetch
})

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'

async function register(body: Record<string, unknown>) {
  const res = await appRequest('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [FROM]: randomIp() },
    body: JSON.stringify(body),
  })
  // biome-ignore lint/suspicious/noExplicitAny: JSON bodies are asserted on in the tests
  return { status: res.status, body: (await res.json()) as any }
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

type Flow = { clientId: string; redirectUri: string; verifier: string; challenge: string; state: string }

function request(flow: Flow, extra: Record<string, string> = {}) {
  return {
    client_id: flow.clientId,
    redirect_uri: flow.redirectUri,
    response_type: 'code',
    code_challenge: flow.challenge,
    code_challenge_method: 'S256',
    state: flow.state,
    resource: mcpResource(),
    ...extra,
  }
}

async function newFlow(redirectUri = CALLBACK, name = 'Claude'): Promise<Flow> {
  const reg = await register({ client_name: name, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
  expect(reg.status).toBe(201)
  return { clientId: reg.body.client_id, redirectUri, ...pkce(), state: `st-${randomBytes(4).toString('hex')}` }
}

/** oauth.approve as `who`: the code from the redirect. */
async function approve(who: User, flow: Flow) {
  const res = await act(who, 'oauth.approve', request(flow))
  expect(res.status).toBe(200)
  const to = new URL(res.body.data.redirectTo)
  expect(to.searchParams.get('state')).toBe(flow.state)
  expect(to.searchParams.get('iss')).toBe(issuer())
  return to.searchParams.get('code')!
}

async function token(params: Record<string, string>, json = false, headers: Record<string, string> = {}) {
  const res = await appRequest('/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
      [FROM]: randomIp(),
      ...headers,
    },
    body: json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
  })
  // biome-ignore lint/suspicious/noExplicitAny: JSON bodies are asserted on in the tests
  return { status: res.status, body: (await res.json()) as any, headers: res.headers }
}

const exchange = (flow: Flow, code: string, extra: Record<string, string> = {}) =>
  token({
    grant_type: 'authorization_code',
    code,
    code_verifier: flow.verifier,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    ...extra,
  })

async function connect(who: User, redirectUri = CALLBACK) {
  const flow = await newFlow(redirectUri)
  const code = await approve(who, flow)
  const res = await exchange(flow, code)
  expect(res.status).toBe(200)
  return { flow, key: res.body.access_token as string }
}

let rpcId = 0
async function mcp(key: string | null, method = 'tools/list', params: Record<string, unknown> = {}) {
  const res = await appRequest('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      [FROM]: randomIp(),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find(l => l.startsWith('data: '))
        ?.slice(6) ?? 'null')
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are asserted on in the tests
  return { status: res.status, headers: res.headers, body: JSON.parse(json) as any }
}

describe('metadata', () => {
  test('protected resource: /mcp of this origin, signed in by this server', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await appRequest(path, { headers: { origin: 'https://claude.ai' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      const body = await res.json()
      expect(body.resource).toBe(`${new URL(issuer()).origin}/mcp`)
      expect(body.authorization_servers).toEqual([issuer()])
    }
  })

  test('authorization server: endpoints, S256, DCR and metadata documents', async () => {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const body = await (await appRequest(path)).json()
      expect(body).toMatchObject({
        issuer: issuer(),
        authorization_endpoint: `${issuer()}/oauth/authorize`,
        token_endpoint: `${issuer()}/oauth/token`,
        registration_endpoint: `${issuer()}/oauth/register`,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        grant_types_supported: ['authorization_code'],
        client_id_metadata_document_supported: true,
      })
    }
  })

  test('/mcp without a key: 401 naming the resource metadata; preflight open to any origin', async () => {
    const res = await mcp(null)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"`,
    )
    const bad = await mcp('ldp_unknown')
    expect(bad.headers.get('www-authenticate')).toContain('resource_metadata=')
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"')
    const pre = await appRequest('/mcp', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://inspector.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, mcp-protocol-version',
      },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  test('the OpenAI apps challenge: 404 unless set', async () => {
    const before = process.env.OPENAI_APPS_CHALLENGE
    try {
      delete process.env.OPENAI_APPS_CHALLENGE
      expect((await appRequest('/.well-known/openai-apps-challenge')).status).toBe(404)
      process.env.OPENAI_APPS_CHALLENGE = 'abc123'
      const res = await appRequest('/.well-known/openai-apps-challenge')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('abc123')
    } finally {
      if (before === undefined) delete process.env.OPENAI_APPS_CHALLENGE
      else process.env.OPENAI_APPS_CHALLENGE = before
    }
  })
})

describe('client registration', () => {
  test('https, loopback and app schemes register; others are refused', async () => {
    const ok = await register({
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:33418/callback', 'cursor://anysphere.cursor-mcp/oauth/callback', CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    })
    expect(ok.status).toBe(201)
    expect(ok.body).toMatchObject({ client_name: 'Claude Code', token_endpoint_auth_method: 'none' })
    expect(ok.body.client_secret).toBeUndefined()
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://a.example/cb#x', 'data:text/html,x']) {
      const bad = await register({ redirect_uris: [uri], token_endpoint_auth_method: 'none' })
      expect(bad.status, uri).toBe(400)
      expect(bad.body.error).toBe('invalid_redirect_uri')
    }
    expect((await register({ token_endpoint_auth_method: 'none' })).body.error).toBe('invalid_redirect_uri')
  })

  test('a confidential client gets a secret, shown once', async () => {
    const reg = await register({
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    })
    expect(reg.body.token_endpoint_auth_method).toBe('client_secret_basic')
    expect(reg.body.client_secret).toMatch(/^ldcs_/)
  })

  test('rate-limited per address', async () => {
    const ip = randomIp()
    let last = 0
    for (let i = 0; i <= REGISTRATIONS_PER_HOUR; i++) {
      const res = await appRequest('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [FROM]: ip },
        body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
      })
      last = res.status
    }
    expect(last).toBe(429)
  })

  test('and capped for all addresses together', () => {
    for (let i = 0; i < REGISTRATIONS_ALL_PER_HOUR; i++) expect(mayRegister(randomIp())).toBe(true)
    expect(mayRegister(randomIp())).toBe(false)
  })

  test('clients older than 30 days that never got a code are deleted; used ones stay', async () => {
    const unused = await newFlow()
    const used = await newFlow()
    await exchange(used, await approve(ws.owner, used))
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString()
    for (const flow of [unused, used])
      await db.update(oauth_clients).set({ created_at: old }).where(eq(oauth_clients.client_id, flow.clientId))
    const fresh = await newFlow()
    await deleteUnusedClients()
    const left = async (flow: Flow) =>
      (await db.select().from(oauth_clients).where(eq(oauth_clients.client_id, flow.clientId))).length
    expect(await left(unused)).toBe(0)
    expect(await left(used)).toBe(1)
    expect(await left(fresh)).toBe(1)
  })
})

describe('the flow', () => {
  test('authorize sends the person to the consent page; describe names the client and where it answers', async () => {
    const flow = await newFlow()
    const res = await appRequest(`/oauth/authorize?${new URLSearchParams(request(flow))}`)
    expect(res.status).toBe(302)
    const to = res.headers.get('location')!
    expect(to).toContain('/#connect-agent?')
    expect(to).toContain(encodeURIComponent(flow.redirectUri))
    const described = await act(ws.owner, 'oauth.describe', request(flow))
    expect(described.status).toBe(200)
    expect(described.body.data).toMatchObject({
      ok: true,
      clientName: 'Claude',
      clientHost: null,
      redirect: { kind: 'web', where: 'claude.ai' },
    })
    expect(described.body.data.email).toContain('@')
    const deny = new URL(described.body.data.denyTo)
    expect(deny.searchParams.get('error')).toBe('access_denied')
    expect(deny.searchParams.get('state')).toBe(flow.state)
  })

  test('approve, token with PKCE, then /mcp works with the key; the key is listed as connected', async () => {
    const { flow, key } = await connect(ws.owner)
    expect(key).toMatch(/^ldp_/)
    const tools = await mcp(key)
    expect(tools.status).toBe(200)
    expect(tools.body.result.tools.some((t: { name: string }) => t.name === 'calls_list')).toBe(true)
    const list = await act(ws.owner, 'personalKey.list', {})
    const row = list.body.data.keys.find((k: { oauth_client_id: string | null }) => k.oauth_client_id === flow.clientId)
    expect(row).toMatchObject({ name: 'Claude', revoked_at: null })
  })

  test('an OAuth key gets the small tool set: reads, public actions, assistant settings and records; no api_get, no billing', async () => {
    const { key } = await connect(ws.owner)
    const names = (await mcp(key)).body.result.tools.map((t: { name: string }) => t.name) as string[]
    expect(names).toEqual(expect.arrayContaining(['calls_list', 'calls_get', 'contacts_search', 'workspaces_list']))
    expect(names).toEqual(
      expect.arrayContaining([
        'call_markDone',
        'contact_update',
        'appointment_book',
        'assistant_update',
        'records_list',
      ]),
    )
    expect(names).not.toContain('api_get')
    expect(names.filter(n => /^(billing|partner|team|apiKey|personalKey|membership|workspace)_/.test(n))).toEqual([])
  })

  test('an OAuth key reads bookings with records_list, never webhook URLs', async () => {
    const { key } = await connect(ws.owner)
    const call = async (table: string) =>
      (await mcp(key, 'tools/call', { name: 'records_list', arguments: { table } })).body.result
    expect((await call('bookings')).isError).toBeFalsy()
    const webhooks = await call('webhook_endpoints')
    expect(webhooks.isError).toBe(true)
    expect(JSON.stringify(webhooks)).toContain('over OAuth only')
  })

  test('the token endpoint takes JSON too, and a loopback redirect on another port', async () => {
    const flow = await newFlow('http://127.0.0.1:3334/callback', 'Claude Code')
    const onAnotherPort = { ...flow, redirectUri: 'http://127.0.0.1:51234/callback' }
    const code = await approve(ws.owner, onAnotherPort)
    const res = await token(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: flow.verifier,
        redirect_uri: onAnotherPort.redirectUri,
        client_id: flow.clientId,
      },
      true,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.body.token_type).toBe('Bearer')
    expect(res.body.expires_in).toBeUndefined()
  })

  test('a confidential client authenticates with Basic', async () => {
    const reg = await register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/cb'] })
    const flow: Flow = { clientId: reg.body.client_id, redirectUri: 'https://chatgpt.com/cb', ...pkce(), state: 's' }
    const code = await approve(ws.owner, flow)
    const params = {
      grant_type: 'authorization_code',
      code,
      code_verifier: flow.verifier,
      redirect_uri: flow.redirectUri,
    }
    const wrong = Buffer.from(`${flow.clientId}:nope`).toString('base64')
    expect((await token(params, false, { authorization: `Basic ${wrong}` })).body.error).toBe('invalid_client')
    // The wrong secret used the code: a new one.
    const again = await approve(ws.owner, flow)
    const basic = Buffer.from(`${flow.clientId}:${reg.body.client_secret}`).toString('base64')
    const ok = await token({ ...params, code: again }, false, { authorization: `Basic ${basic}` })
    expect(ok.status).toBe(200)
  })
})

describe('refusals', () => {
  test('wrong verifier, other redirect URI, other client: invalid_grant', async () => {
    const flow = await newFlow()
    expect((await exchange(flow, await approve(ws.owner, flow), { code_verifier: pkce().verifier })).body.error).toBe(
      'invalid_grant',
    )
    expect(
      (await exchange(flow, await approve(ws.owner, flow), { redirect_uri: 'https://claude.ai/other' })).body.error,
    ).toBe('invalid_grant')
    const other = await newFlow()
    expect((await exchange(other, await approve(ws.owner, flow))).body.error).toBe('invalid_grant')
  })

  test('a reused code is refused and revokes the key it gave', async () => {
    const flow = await newFlow()
    const code = await approve(ws.owner, flow)
    const first = await exchange(flow, code)
    expect(first.status).toBe(200)
    expect((await mcp(first.body.access_token)).status).toBe(200)
    const second = await exchange(flow, code)
    expect(second.status).toBe(400)
    expect(second.body.error).toBe('invalid_grant')
    expect((await mcp(first.body.access_token)).status).toBe(401)
  })

  test('two exchanges of one code at once: one key at most, and it is revoked', async () => {
    const flow = await newFlow()
    const code = await approve(ws.owner, flow)
    const [a, b] = await Promise.all([exchange(flow, code), exchange(flow, code)])
    const won = [a, b].filter(r => r.status === 200)
    expect(won.length).toBeLessThanOrEqual(1)
    expect([a, b].some(r => r.body.error === 'invalid_grant')).toBe(true)
    for (const r of won) expect((await mcp(r.body.access_token)).status).toBe(401)
    const [row] = await db
      .select()
      .from(oauth_codes)
      .where(eq(oauth_codes.code_hash, createHash('sha256').update(code).digest('hex')))
    expect(row!.used_at).not.toBeNull()
  })

  test('the token request must name the same resource as the code, when it names one', async () => {
    const flow = await newFlow()
    const other = await exchange(flow, await approve(ws.owner, flow), { resource: 'https://other.example/mcp' })
    expect(other.status).toBe(400)
    expect(other.body.error).toBe('invalid_target')
    expect((await exchange(flow, await approve(ws.owner, flow), { resource: mcpResource() })).status).toBe(200)
    expect((await exchange(flow, await approve(ws.owner, flow))).status).toBe(200)
  })

  test('an expired code is refused', async () => {
    const flow = await newFlow()
    const code = await approve(ws.owner, flow)
    await db
      .update(oauth_codes)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(oauth_codes.code_hash, createHash('sha256').update(code).digest('hex')))
    expect((await exchange(flow, code)).body.error).toBe('invalid_grant')
  })

  test('without PKCE S256, with another resource or response type: the consent page offers the error to the client', async () => {
    const flow = await newFlow()
    for (const [extra, problem, error] of [
      [{ code_challenge: '' }, 'pkce', 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'pkce', 'invalid_request'],
      [{ resource: 'https://other.example/mcp' }, 'resource', 'invalid_target'],
      [{ response_type: 'token' }, 'response_type', 'unsupported_response_type'],
    ] as const) {
      // Never a redirect to the client before the person acts: always the consent page.
      const res = await appRequest(`/oauth/authorize?${new URLSearchParams(request(flow, extra))}`)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toContain('/#connect-agent?')
      const described = await act(ws.owner, 'oauth.describe', request(flow, extra))
      expect(described.body.data).toMatchObject({ ok: false, problem })
      const to = new URL(described.body.data.errorTo)
      expect(to.origin + to.pathname).toBe(CALLBACK)
      expect(to.searchParams.get('error')).toBe(error)
      expect(to.searchParams.get('state')).toBe(flow.state)
      expect((await act(ws.owner, 'oauth.approve', request(flow, extra))).status).not.toBe(200)
    }
  })

  test('an unregistered redirect URI or unknown client never redirects: the consent page says so', async () => {
    const flow = await newFlow()
    const res = await appRequest(
      `/oauth/authorize?${new URLSearchParams(request(flow, { redirect_uri: 'https://evil.example/cb' }))}`,
    )
    expect(res.headers.get('location')).toContain('/#connect-agent?')
    const described = await act(ws.owner, 'oauth.describe', request(flow, { redirect_uri: 'https://evil.example/cb' }))
    expect(described.body.data).toEqual({ ok: false, problem: 'redirect', errorTo: null })
    const unknown = await act(ws.owner, 'oauth.describe', request(flow, { client_id: 'ldc_nope' }))
    expect(unknown.body.data).toEqual({ ok: false, problem: 'client', errorTo: null })
    expect((await act(ws.owner, 'oauth.approve', request(flow, { client_id: 'ldc_nope' }))).status).toBe(409)
  })

  test('approving needs a sign-in from the last 10 minutes, as making a key does', async () => {
    const flow = await newFlow()
    const [own] = await db.select().from(session).where(eq(session.userId, ws.owner.userId))
    const createdAt = own!.createdAt
    await db
      .update(session)
      .set({ createdAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(session.userId, ws.owner.userId))
    try {
      expect(await act(ws.owner, 'oauth.approve', request(flow))).toMatchObject({
        status: 403,
        body: { code: 'SIGN_IN_AGAIN' },
      })
    } finally {
      await db.update(session).set({ createdAt }).where(eq(session.userId, ws.owner.userId))
    }
  })

  test('a key cannot approve a connection', async () => {
    const { key } = await connect(ws.owner)
    const flow = await newFlow()
    const res = await appRequest('/v1/actions/oauth.approve', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', [FROM]: randomIp() },
      body: JSON.stringify(request(flow)),
    })
    expect(res.status).toBe(403)
  })
})

describe('the key', () => {
  test('never has Server admin, also for a server admin on an install without the passkey check', async () => {
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, ws.owner.userId))
    try {
      const { key } = await connect(ws.owner)
      const actor = await actorForPersonalKey(key, null, null)
      expect(actor).not.toBeNull()
      expect(actor!.permissions).not.toContain('instance:admin')
      const [row] = await db.select().from(personal_keys).where(eq(personal_keys.id, actor!.personalKeyId!))
      expect(row!.passkey_confirmed).toBe(false)
    } finally {
      await db.update(user).set({ instanceAdmin: false }).where(eq(user.id, ws.owner.userId))
    }
  })

  test('revoking it in Account settings ends the connection at once', async () => {
    const { key } = await connect(ws.owner)
    expect((await mcp(key)).status).toBe(200)
    const actor = await actorForPersonalKey(key, null, null)
    expect((await act(ws.owner, 'personalKey.revoke', { personalKeyId: actor!.personalKeyId })).status).toBe(200)
    expect((await mcp(key)).status).toBe(401)
  })
})

describe('client metadata documents (CIMD)', () => {
  const DOC = 'https://claude.ai/oauth/mcp-oauth-client-metadata'

  test('a client known by its document URL connects without registering', async () => {
    clientMetadata.fetch = async url =>
      url === DOC
        ? { client_id: DOC, client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }
        : null
    const flow: Flow = { clientId: DOC, redirectUri: CALLBACK, ...pkce(), state: 'cimd' }
    const described = await act(ws.owner, 'oauth.describe', request(flow))
    expect(described.body.data).toMatchObject({ ok: true, clientName: 'Claude', clientHost: 'claude.ai' })
    const res = await exchange(flow, await approve(ws.owner, flow))
    expect(res.status).toBe(200)
    expect((await mcp(res.body.access_token)).status).toBe(200)
  })

  test('a client that prefers private_key_jwt but also supports none connects as a public client (ChatGPT)', async () => {
    const CHATGPT = 'https://chatgpt.com/oauth/client.json'
    const doc = (supported: string[]) => ({
      client_id: CHATGPT,
      client_name: 'ChatGPT',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: supported,
      jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
    })
    clientMetadata.fetch = async url => (url === CHATGPT ? doc(['none', 'private_key_jwt']) : null)
    const flow: Flow = { clientId: CHATGPT, redirectUri: CALLBACK, ...pkce(), state: 'chatgpt' }
    const described = await act(ws.owner, 'oauth.describe', request(flow))
    expect(described.body.data).toMatchObject({ ok: true, clientName: 'ChatGPT', clientHost: 'chatgpt.com' })
    // ChatGPT may still send its client assertion: it is ignored, PKCE is what counts.
    const assertion = {
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'x.y.z',
    }
    const wrong = await exchange(flow, await approve(ws.owner, flow), { ...assertion, code_verifier: pkce().verifier })
    expect(wrong.body.error).toBe('invalid_grant')
    const res = await exchange(flow, await approve(ws.owner, flow), assertion)
    expect(res.status).toBe(200)
    expect((await mcp(res.body.access_token)).status).toBe(200)

    // Without `none` among its methods (or with no list, or a string), the client needs a method this server does not offer.
    for (const supported of [['private_key_jwt'], undefined, 'none']) {
      forgetClientDocuments()
      clientMetadata.fetch = async () => ({ ...doc([]), token_endpoint_auth_methods_supported: supported })
      expect((await act(ws.owner, 'oauth.describe', request(flow))).body.data, String(supported)).toEqual({
        ok: false,
        problem: 'client',
        errorTo: null,
      })
    }
  })

  test('a document for another client_id, or one that cannot be fetched, is refused', async () => {
    clientMetadata.fetch = async () => ({ client_id: 'https://other.example/doc', redirect_uris: [CALLBACK] })
    const flow: Flow = { clientId: DOC, redirectUri: CALLBACK, ...pkce(), state: 'x' }
    expect((await act(ws.owner, 'oauth.describe', request(flow))).body.data).toEqual({
      ok: false,
      problem: 'client',
      errorTo: null,
    })
    forgetClientDocuments()
    clientMetadata.fetch = async () => null
    expect((await act(ws.owner, 'oauth.describe', request(flow))).body.data).toEqual({
      ok: false,
      problem: 'metadata_unreachable',
      errorTo: null,
    })
  })

  test('a failed fetch is remembered for a minute; one person can make only so many fetches', async () => {
    let fetches = 0
    clientMetadata.fetch = async () => {
      fetches++
      return null
    }
    const flow: Flow = { clientId: DOC, redirectUri: CALLBACK, ...pkce(), state: 'x' }
    await act(ws.owner, 'oauth.describe', request(flow))
    await act(ws.owner, 'oauth.describe', request(flow))
    expect(fetches).toBe(1)
    forgetClientDocuments()
    clientMetadata.fetch = async url => {
      fetches++
      return { client_id: url, redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }
    }
    fetches = 0
    for (let i = 0; i <= FETCHES_PER_WINDOW; i++) {
      const res = await act(ws.owner, 'oauth.describe', request({ ...flow, clientId: `${DOC}-${i}` }))
      expect(res.body.data.ok, String(i)).toBe(i < FETCHES_PER_WINDOW)
    }
    expect(fetches).toBe(FETCHES_PER_WINDOW)
  })
})

describe('tools', () => {
  test('every tool: a name of at most 64 characters, a title and all three hints', async () => {
    const { key } = await connect(ws.owner)
    const made = await act(ws.owner, 'apiKey.create', { name: 'Zap', role: 'admin' })
    for (const bearer of [key, made.body.data.key as string]) {
      const res = await mcp(bearer)
      expect(res.status).toBe(200)
      const tools = res.body.result.tools as {
        name: string
        title?: string
        annotations?: Record<string, unknown>
      }[]
      expect(tools.length).toBeGreaterThan(3)
      for (const tool of tools) {
        expect(tool.name.length, tool.name).toBeLessThanOrEqual(64)
        expect(tool.name).toMatch(/^[A-Za-z0-9_-]+$/)
        expect(tool.title, tool.name).toBeTruthy()
        for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint'])
          expect(typeof tool.annotations?.[hint], `${tool.name} ${hint}`).toBe('boolean')
      }
    }
  })
})

describe('rules', () => {
  test('public addresses only for metadata documents', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '100.64.0.1',
      '0.0.0.0',
      '2001::1',
      '2002:7f00:1::1',
      '64:ff9b:1::a00:1',
    ])
      expect(isPublicAddress(ip), ip).toBe(false)
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true)
  })

  test('redirect URIs: https, loopback on any port, app schemes', () => {
    expect(redirectKind(CALLBACK)).toBe('web')
    expect(redirectKind('https://claude.com/api/mcp/auth_callback')).toBe('web')
    expect(redirectKind('http://localhost:8080/cb')).toBe('loopback')
    expect(redirectKind('vscode://vscode.github-authentication/did-authenticate')).toBe('app')
    expect(redirectKind('cursor://anysphere.cursor-mcp/oauth/callback')).toBe('app')
    expect(redirectKind('com.example.app:/oauth')).toBe('app')
    for (const uri of ['search-ms:query=x', 'ms-settings:privacy', 'foo:/cb', 'file:///etc/passwd', 'javascript:x'])
      expect(redirectKind(uri), uri).toBeNull()
    expect(redirectKind('http://example.com/cb')).toBeNull()
    expect(redirectMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:9999/cb')).toBe(true)
    expect(redirectMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:9999/other')).toBe(false)
    expect(redirectMatches([CALLBACK], 'https://claude.ai/api/mcp/auth_callback?x=1')).toBe(false)
  })
})
