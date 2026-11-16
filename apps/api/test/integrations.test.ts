// Integration subscriptions (Zapier's REST hooks): made and ended with a workspace API key through the registry,
// only to the integration's own host, never offered over MCP; each finished phone call is queued per subscription and
// POSTed in the after-call webhook's shape; 410 ends one; revoking the key ends its subscriptions. Owners and admins
// list and remove them. The reads for integrations: the key itself, sample calls and a contact by number.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { actions, recordingKey } from '@linedesk/actions'
import { api_keys, calls, commands, integration_subscriptions, webhook_deliveries } from '@linedesk/db'
import { and, eq, isNotNull } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import { attemptAnyDelivery } from '../src/integrations.ts'
import { offeredOverMcp } from '../src/mcp.ts'
import { SIGNATURE_HEADER } from '../src/webhooks.ts'
import { act, addMember, agent, type Caller, createWorkspace, request, type User, type Workspace } from './helpers.ts'

type Received = { headers: Record<string, string | string[] | undefined>; body: string }

let ws: Workspace
let other: Workspace
let member: User
let server: Server
let base: string
const received: Received[] = []
let answer = 200

const bearer = (key: string): Caller => ({ headers: { authorization: `Bearer ${key}` } })

async function createKey(owner: Caller, role: 'member' | 'admin' = 'member') {
  const res = await act(owner, 'apiKey.create', { name: 'Zapier', role })
  expect(res.status).toBe(200)
  return res.body.data as { apiKeyId: string; key: string }
}

async function subscribe(key: string, path = '/hook') {
  const res = await act(bearer(key), 'integration.subscribe', { event: 'call_finished', targetUrl: `${base}${path}` })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data.subscriptionId as string
}

const subscriptionRow = async (id: string) =>
  (await db.select().from(integration_subscriptions).where(eq(integration_subscriptions.id, id)))[0]
const deliveriesOf = (subscriptionId: string) =>
  db.select().from(webhook_deliveries).where(eq(webhook_deliveries.subscription_id, subscriptionId))

/** A phone call from the workspace's contact, finished with a summary and a next step. */
async function finishedCall(asTest = false) {
  const started = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number, attestation: 'A' })
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const { callId } = started.body.data as { callId: string }
  if (asTest) await db.update(calls).set({ source: 'test' }).where(eq(calls.id, callId))
  const finished = await act(agent(ws.id), 'call.finish', {
    callId,
    outcome: 'message',
    summary: 'Water heater leaking.',
    actionItems: [{ text: 'Call Sam back' }],
  })
  expect(finished.status, JSON.stringify(finished.body)).toBe(200)
  return callId
}

beforeAll(async () => {
  process.env.WEBHOOK_ALLOW_PRIVATE_URLS = 'true'
  ws = await createWorkspace('Brightwater Plumbing & Heating')
  other = await createWorkspace('Other Business')
  member = await addMember(ws.id, 'member')
  server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body })
      res.writeHead(answer).end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  process.env.WEBHOOK_ALLOW_PRIVATE_URLS = 'false'
  await new Promise(resolve => server.close(resolve))
})

beforeEach(async () => {
  await db.delete(integration_subscriptions).where(eq(integration_subscriptions.workspace_id, ws.id))
  await db
    .update(calls)
    .set({ status: 'completed' })
    .where(and(eq(calls.workspace_id, ws.id), eq(calls.status, 'live')))
  received.length = 0
  answer = 200
})

describe('subscribing', () => {
  test('a member key subscribes and unsubscribes; a signed-in person cannot, another key or workspace cannot end it', async () => {
    const { key, apiKeyId } = await createKey(ws.owner)
    const id = await subscribe(key)
    expect(await subscriptionRow(id)).toMatchObject({
      workspace_id: ws.id,
      api_key_id: apiKeyId,
      source: 'zapier',
      event: 'call_finished',
      status: 'active',
    })
    const session = await act(ws.owner, 'integration.subscribe', { event: 'call_finished', targetUrl: `${base}/x` })
    expect(session).toMatchObject({ status: 409, body: { error: expect.stringContaining('API key') } })
    const { key: theirs } = await createKey(other.owner)
    expect(await act(bearer(theirs), 'integration.unsubscribe', { subscriptionId: id })).toMatchObject({
      status: 200,
      body: { data: { removed: false } },
    })
    expect(await subscriptionRow(id)).toBeDefined()
    // Another key of the same workspace cannot end a Zap it did not make.
    const { key: second } = await createKey(ws.owner)
    expect(await act(bearer(second), 'integration.unsubscribe', { subscriptionId: id })).toMatchObject({
      status: 200,
      body: { data: { removed: false } },
    })
    expect(await subscriptionRow(id)).toBeDefined()
    expect(await act(bearer(key), 'integration.unsubscribe', { subscriptionId: id })).toMatchObject({
      status: 200,
      body: { data: { removed: true } },
    })
    expect(await subscriptionRow(id)).toBeUndefined()
    // Gone already: Zapier's retry of an unsubscribe is no error.
    expect(await act(bearer(key), 'integration.unsubscribe', { subscriptionId: id })).toMatchObject({
      status: 200,
      body: { data: { removed: false } },
    })
  })

  test("only https URLs on Zapier's host, when private addresses are not allowed", async () => {
    const { key } = await createKey(ws.owner)
    process.env.WEBHOOK_ALLOW_PRIVATE_URLS = 'false'
    try {
      for (const targetUrl of [
        'https://attacker.example.com/hook',
        'http://hooks.zapier.com/hooks/catch/1/abc',
        'https://hooks.zapier.com.attacker.example/x',
        'https://user:pw@hooks.zapier.com/x',
      ]) {
        const res = await act(bearer(key), 'integration.subscribe', { event: 'call_finished', targetUrl })
        expect(res.status, targetUrl).toBe(409)
      }
      expect(
        (
          await act(bearer(key), 'integration.subscribe', {
            event: 'call_finished',
            targetUrl: 'ftp://hooks.zapier.com/x',
          })
        ).status,
      ).toBe(422)
    } finally {
      process.env.WEBHOOK_ALLOW_PRIVATE_URLS = 'true'
    }
  })

  test("the command log holds the hook URL redacted (it is the Zap's capability)", async () => {
    const { key } = await createKey(ws.owner)
    await subscribe(key, '/hook-must-not-be-logged')
    const logged = await db
      .select()
      .from(commands)
      .where(and(eq(commands.workspace_id, ws.id), eq(commands.action, 'integration.subscribe')))
    expect(logged.length).toBeGreaterThan(0)
    for (const row of logged) expect(row.input).toMatchObject({ targetUrl: '[redacted]' })
    expect(JSON.stringify(logged)).not.toContain('hook-must-not-be-logged')
  })

  test('never an MCP tool: an assistant reading caller text must not send calls anywhere', () => {
    const actor = {
      permissions: ['call:read', 'call:write', 'contact:write'],
      role: 'admin',
      apiKeyId: 'key_x',
      workspaceId: ws.id,
    } as unknown as Actor
    expect(offeredOverMcp(actions.get('integration.subscribe')!, actor)).toBe(false)
    expect(offeredOverMcp(actions.get('integration.unsubscribe')!, actor)).toBe(false)
    expect(offeredOverMcp(actions.get('call.markDone')!, actor)).toBe(true)
  })
})

describe('delivery', () => {
  test('a finished phone call goes to each subscription, unsigned, in the after-call shape with flat fields', async () => {
    const { key } = await createKey(ws.owner)
    const id = await subscribe(key)
    const callId = await finishedCall()
    const [queued] = await deliveriesOf(id)
    expect(queued).toMatchObject({
      status: 'pending',
      event: 'call_finished',
      endpoint_id: null,
      payload: { call_id: callId },
    })
    expect(await attemptAnyDelivery(db, queued!.id)).toBe('delivered')
    expect(received).toHaveLength(1)
    expect(received[0]!.headers[SIGNATURE_HEADER]).toBeUndefined()
    expect(received[0]!.headers['linedesk-hook']).toBe('call_finished')
    const body = JSON.parse(received[0]!.body)
    expect(body).toMatchObject({
      id: callId,
      call_id: callId,
      event: 'call_finished',
      summary: 'Water heater leaking.',
      outcome: 'message',
      from_number: ws.contact.phone,
      caller_name: 'Known Caller',
      caller_contact_id: ws.contact.id,
      next_steps_text: 'Call Sam back',
    })
    expect(body.hook).toBeUndefined()
    expect(await subscriptionRow(id)).toMatchObject({ failure_count: 0, last_delivery_at: expect.any(String) })
    expect(await attemptAnyDelivery(db, queued!.id)).toBe('skipped')
  })

  test('test calls send nothing', async () => {
    const { key } = await createKey(ws.owner)
    const id = await subscribe(key)
    await finishedCall(true)
    expect(await deliveriesOf(id)).toHaveLength(0)
  })

  test('a failed attempt is retried; a 410 answer ends the subscription', async () => {
    const { key } = await createKey(ws.owner)
    const id = await subscribe(key)
    await finishedCall()
    const [queued] = await deliveriesOf(id)
    answer = 500
    expect(await attemptAnyDelivery(db, queued!.id)).toBe('retry')
    answer = 410
    expect(await attemptAnyDelivery(db, queued!.id)).toBe('failed')
    expect(await subscriptionRow(id)).toBeUndefined()
  })

  test('revoking the key ends its subscriptions; a key revoked otherwise sends nothing', async () => {
    const first = await createKey(ws.owner)
    const id = await subscribe(first.key)
    expect((await act(ws.owner, 'apiKey.revoke', { apiKeyId: first.apiKeyId })).status).toBe(200)
    expect(await subscriptionRow(id)).toBeUndefined()

    const second = await createKey(ws.owner)
    const kept = await subscribe(second.key)
    await finishedCall()
    const [queued] = await deliveriesOf(kept)
    // Revoked by another path (an unproven account's cleanup, account-linking.ts): the row stays, nothing goes out.
    await db.update(api_keys).set({ revoked_at: new Date().toISOString() }).where(eq(api_keys.id, second.apiKeyId))
    expect(await attemptAnyDelivery(db, queued!.id)).toBe('skipped')
    expect(received).toHaveLength(0)
    await finishedCall()
    expect(await deliveriesOf(kept)).toHaveLength(1)
  })
})

describe('in Workspace settings › Developers', () => {
  test('owners list and remove them, never seeing the URL; members cannot; another workspace cannot remove', async () => {
    const { key, apiKeyId } = await createKey(ws.owner)
    const id = await subscribe(key)
    const listed = await act(ws.owner, 'integration.list', {})
    expect(listed.body.data.subscriptions).toEqual([
      expect.objectContaining({
        id,
        source: 'zapier',
        event: 'call_finished',
        api_key_id: apiKeyId,
        api_key_name: 'Zapier',
      }),
    ])
    expect(JSON.stringify(listed.body)).not.toContain(base)
    expect((await act(member, 'integration.list', {})).status).toBe(403)
    expect((await act(member, 'integration.remove', { subscriptionId: id })).status).toBe(403)
    expect(await act(other.owner, 'integration.remove', { subscriptionId: id })).toMatchObject({
      status: 409,
      body: { error: 'subscription not found' },
    })
    expect((await act(ws.owner, 'integration.remove', { subscriptionId: id })).status).toBe(200)
    expect(await subscriptionRow(id)).toBeUndefined()
  })
})

describe('reads for integrations', () => {
  test('GET /v1/api-key names the workspace; only for API keys', async () => {
    const { key, apiKeyId } = await createKey(ws.owner)
    expect(await request(bearer(key), 'GET', '/v1/api-key')).toMatchObject({
      status: 200,
      body: {
        workspace: { id: ws.id, name: 'Brightwater Plumbing & Heating' },
        key: { id: apiKeyId, name: 'Zapier', role: 'member' },
      },
    })
    expect((await request(ws.owner, 'GET', '/v1/api-key')).status).toBe(403)
    expect((await request(bearer('ld_unknownunknownunknownunknownunknownunknown1'), 'GET', '/v1/api-key')).status).toBe(
      401,
    )
  })

  test('GET /v1/integrations/calls lists finished phone calls of the key’s workspace, newest first, no test calls', async () => {
    const { key } = await createKey(ws.owner)
    const testCall = await finishedCall(true)
    const callId = await finishedCall()
    // A recorded call: a sample still carries no link to it (any member key could mint 7-day links otherwise).
    await db
      .update(calls)
      .set({ recording_key: recordingKey(ws.id, callId) })
      .where(eq(calls.id, callId))
    const res = await request(bearer(key), 'GET', '/v1/integrations/calls?limit=2')
    expect(res.status).toBe(200)
    expect(res.body.calls.length).toBeLessThanOrEqual(2)
    expect(res.body.calls[0]).toMatchObject({
      id: callId,
      event: 'call_finished',
      caller_name: 'Known Caller',
      recording_url: null,
      recording_expires_at: null,
    })
    expect(JSON.stringify(res.body)).not.toContain('/recording?')
    expect(res.body.calls.map((c: { id: string }) => c.id)).not.toContain(testCall)
    const { key: theirs } = await createKey(other.owner)
    const elsewhere = await request(bearer(theirs), 'GET', '/v1/integrations/calls')
    expect(elsewhere.body.calls.map((c: { id: string }) => c.id)).not.toContain(callId)
    expect((await request(ws.owner, 'GET', '/v1/integrations/calls')).status).toBe(403)
  })

  test('GET /v1/integrations/contacts finds a contact by number, in the key’s workspace only', async () => {
    const { key } = await createKey(ws.owner)
    const found = await request(
      bearer(key),
      'GET',
      `/v1/integrations/contacts?phone=${encodeURIComponent(ws.contact.phone)}`,
    )
    expect(found.body.contacts).toEqual([expect.objectContaining({ id: ws.contact.id, name: 'Known Caller' })])
    const { key: theirs } = await createKey(other.owner)
    expect(
      (await request(bearer(theirs), 'GET', `/v1/integrations/contacts?phone=${encodeURIComponent(ws.contact.phone)}`))
        .body.contacts,
    ).toEqual([])
    expect((await request(bearer(key), 'GET', '/v1/integrations/contacts?phone=12')).status).toBe(422)
  })
})

test('a subscription delivery leaves the assistants’ webhook deliveries alone', async () => {
  expect(
    await db
      .select()
      .from(webhook_deliveries)
      .where(
        and(
          eq(webhook_deliveries.workspace_id, ws.id),
          isNotNull(webhook_deliveries.endpoint_id),
          isNotNull(webhook_deliveries.subscription_id),
        ),
      ),
  ).toEqual([])
})
