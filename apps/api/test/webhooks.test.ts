// An assistant's webhooks: set through the registry (owners and admins, own workspace only, one per hook),
// the secret stored encrypted and never logged. Call start: the caller is POSTed, the answer becomes caller
// details on the call. After the call: queued with the finish, built into the whole call at the first
// attempt, signed, retried, logged and switched off after failures. Requests go to a real local server.
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CALL_START_TIMEOUT_MS, DURING_CALL_MAX_PER_CALL, DURING_CALL_TIMEOUT_MS, newWebhookSecret, recordingKey, rolePermissions } from '@linedesk/actions'
import { assistants, bookings, calls, commands, contacts, type Tx, webhook_deliveries, webhook_endpoints, webhook_secrets } from '@linedesk/db'
import type { WebhookHook, WebhookLookup } from '@linedesk/db/types'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { Actor } from '../src/context.ts'
import { db } from '../src/db.ts'
import {
  attemptDelivery, clearOldPayloads, isPrivateAddress, publicLookup, SIGNATURE_HEADER, sendWebhook, urlProblem, WEBHOOK_ATTEMPTS, WEBHOOK_ENDPOINTS_PER_WORKSPACE,
  WEBHOOK_DISABLE_AFTER, WEBHOOK_PAYLOAD_DAYS, WEBHOOK_TESTS_PER_MINUTE, webhookHandlers,
} from '../src/webhooks.ts'
import { act, addMember, agent, anonymous, createWorkspace, request, type User, type Workspace } from './helpers.ts'

type Received = { headers: Record<string, string | string[] | undefined>; body: string }

let ws: Workspace
let other: Workspace
let member: User
let server: Server
let base: string
const received: Received[] = []
/** What the receiver answers next: the status, a JSON body, and how long it waits first. */
let answer = 200
let replyBody = ''
let replyDelayMs = 0

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
      setTimeout(() => res.writeHead(answer, { 'content-type': 'application/json' }).end(replyBody), replyDelayMs)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  process.env.WEBHOOK_ALLOW_PRIVATE_URLS = 'false'
  await new Promise(resolve => server.close(resolve))
})

async function addHook(hooks: WebhookHook[] = ['call_end'], owner = ws.owner, assistantId = ws.assistant.id) {
  const endpointId = `whe_${crypto.randomUUID().slice(0, 12)}`
  const secret = newWebhookSecret()
  const res = await act(owner, 'webhook.create', { endpointId, assistantId, url: `${base}/hook`, hooks, secret })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { endpointId, secret }
}

/** More assistants in a workspace, each with room for two webhooks. */
async function moreAssistants(workspaceId: string, count: number) {
  const rows = Array.from({ length: count }, () => ({ id: `as_${crypto.randomUUID().slice(0, 12)}`, workspace_id: workspaceId }))
  await db.insert(assistants).values(rows)
  return rows.map(r => r.id)
}

// Each test adds its own webhooks to the shared workspace: drop the ones of earlier tests.
// Calls left live by earlier tests are ended, so new ones are not refused as too many at once.
beforeEach(async () => {
  await db.delete(webhook_endpoints).where(eq(webhook_endpoints.workspace_id, ws.id))
  await db.update(calls).set({ status: 'completed' }).where(and(eq(calls.workspace_id, ws.id), eq(calls.status, 'live')))
  answer = 200
  replyBody = ''
  replyDelayMs = 0
  received.length = 0
})

const deliveriesOf = (endpointId: string) => db.select().from(webhook_deliveries).where(eq(webhook_deliveries.endpoint_id, endpointId))
const endpointRow = async (endpointId: string) => (await db.select().from(webhook_endpoints).where(eq(webhook_endpoints.id, endpointId)))[0]!
const callRow = async (callId: string) => (await db.select().from(calls).where(eq(calls.id, callId)))[0]!

/** A new phone call from the workspace's contact; finished with a summary and a message when `finish`. */
async function newCall({ finish = false } = {}) {
  const started = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
  expect(started.status, JSON.stringify(started.body)).toBe(200)
  const { callId } = started.body.data as { callId: string }
  if (finish) await finishCall(callId)
  return callId
}
const finishCall = (callId: string) => act(agent(ws.id), 'call.finish', { callId, outcome: 'message', summary: 'Water heater leaking.' })
const verify = (secret: string, received: Received) => {
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(received.headers[SIGNATURE_HEADER]))!
  return v1 === createHmac('sha256', secret).update(`${t}.${received.body}`).digest('hex') && Math.abs(Number(t) - Date.now() / 1000) < 5
}

describe('webhooks', () => {
  test('the secret is stored encrypted and never in the command log; members cannot manage webhooks', async () => {
    const { endpointId, secret } = await addHook()
    const [stored] = await db.select().from(webhook_secrets).where(eq(webhook_secrets.endpoint_id, endpointId))
    expect(stored!.secret_encrypted).not.toContain(secret)
    const logged = await db.select().from(commands).where(eq(commands.action, 'webhook.create'))
    expect(JSON.stringify(logged)).not.toContain(secret)
    expect(await endpointRow(endpointId)).toMatchObject({ assistant_id: ws.assistant.id, hooks: ['call_end'], status: 'active' })
    const input = { endpointId: 'whe_x', assistantId: ws.assistant.id, url: `${base}/x`, hooks: ['call_start'], secret }
    expect((await act(member, 'webhook.create', input)).status).toBe(403)
    expect((await act(member, 'webhook.deliveries', { endpointId })).status).toBe(403)
  })

  test('another workspace cannot see, test, change or delete a webhook, nor add one to its assistant', async () => {
    const { endpointId } = await addHook()
    for (const [name, input] of [['webhook.deliveries', {}], ['webhook.test', { hook: 'call_end' }], ['webhook.update', { enabled: false }], ['webhook.delete', {}]] as const)
      expect(await act(other.owner, name, { endpointId, ...input })).toMatchObject({ status: 409, body: { error: 'webhook not found' } })
    expect((await endpointRow(endpointId)).status).toBe('active')
    const input = { endpointId: 'whe_theirs', assistantId: ws.assistant.id, url: `${base}/hook`, hooks: ['call_start'], secret: newWebhookSecret() }
    expect(await act(other.owner, 'webhook.create', input)).toMatchObject({ status: 409, body: { error: 'assistant not found' } })
  })

  test('a weak secret, an unknown hook and a non-http URL are refused', async () => {
    const input = { endpointId: 'whe_bad', assistantId: ws.assistant.id, url: `${base}/hook`, hooks: ['call_end'], secret: newWebhookSecret() }
    expect((await act(ws.owner, 'webhook.create', { ...input, secret: 'whsec_short' })).status).toBe(422)
    expect((await act(ws.owner, 'webhook.create', { ...input, hooks: ['call.completed'] })).status).toBe(422)
    expect((await act(ws.owner, 'webhook.create', { ...input, url: 'ftp://example.com/hook' })).status).toBe(422)
  })

  test('one webhook per assistant, its hooks switched on and off; other assistants have their own', async () => {
    const { endpointId } = await addHook(['call_end'])
    const again = { endpointId: 'whe_again', assistantId: ws.assistant.id, url: `${base}/other`, hooks: ['call_start'], secret: newWebhookSecret() }
    expect(await act(ws.owner, 'webhook.create', again)).toMatchObject({ status: 409, body: { error: 'This assistant has a webhook already. Change or delete it instead.' } })
    expect((await act(ws.owner, 'webhook.update', { endpointId, hooks: ['call_end', 'call_start'] })).status).toBe(200)
    expect((await endpointRow(endpointId)).hooks).toEqual(['call_start', 'call_end'])
    expect((await act(ws.owner, 'webhook.update', { endpointId, hooks: [] })).status).toBe(200)
    expect((await endpointRow(endpointId)).hooks).toEqual([])
    const [second] = await moreAssistants(ws.id, 1)
    await addHook(['call_end'], ws.owner, second)
  })

  test('without the development switch only public https addresses are allowed', async () => {
    const env = {}
    expect(await urlProblem('http://example.com/hook', env)).toMatch(/https/)
    expect(await urlProblem('https://127.0.0.1/hook', env)).toMatch(/private/)
    expect(await urlProblem('https://[::1]/hook', env)).toMatch(/private/)
    expect(await urlProblem('https://localhost/hook', env)).toMatch(/private/)
    expect(await urlProblem('https://93.184.215.14/hook', env)).toBeNull()
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1'])
      expect(isPrivateAddress(ip)).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1']) expect(isPrivateAddress(ip)).toBe(false)
  })

  test('site-local and IPv4-translated (SIIT) IPv6 addresses are private; webhooks use port 443 or 8443 only', async () => {
    for (const ip of ['fec0::1', 'feff::1', '::ffff:0:808:808', '::ffff:0:7f00:1']) expect(isPrivateAddress(ip), ip).toBe(true)
    const env = {}
    expect(await urlProblem('https://93.184.215.14:22/hook', env)).toMatch(/port 443 or 8443/)
    expect(await urlProblem('https://93.184.215.14:6379/hook', env)).toMatch(/port 443 or 8443/)
    expect(await urlProblem('https://93.184.215.14:8443/hook', env)).toBeNull()
    expect(await urlProblem('https://93.184.215.14:443/hook', env)).toBeNull()
  })

  test('IPv4 inside IPv6 is checked as the IPv4 address it reaches, however it is written', async () => {
    const privateOnes = [
      '::ffff:7f00:1', '[::ffff:a9fe:a9fe]', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:0001', '::7f00:1', '::127.0.0.1', '::', '::1',
      '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::808:808', '2002:7f00:1::', '2002:a9fe:a9fe::1', '2001:0:4136:e378::1', 'not an address',
    ]
    for (const ip of privateOnes) expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1', '2001:4860:4860::8888']) expect(isPrivateAddress(ip), ip).toBe(false)
    expect(await urlProblem('https://[::ffff:7f00:1]/hook', {})).toMatch(/private/)
    expect(await urlProblem('https://[64:ff9b::a9fe:a9fe]/hook', {})).toMatch(/private/)
  })

  test(`at most ${WEBHOOK_ENDPOINTS_PER_WORKSPACE} webhooks per workspace`, async () => {
    const own = await createWorkspace('Endpoint Cap Plumbing')
    // The fixture's switched-off webhook of the first assistant counts too.
    const ids = await moreAssistants(own.id, WEBHOOK_ENDPOINTS_PER_WORKSPACE)
    for (const id of ids.slice(0, WEBHOOK_ENDPOINTS_PER_WORKSPACE - 1)) await addHook(['call_end'], own.owner, id)
    const more = await act(own.owner, 'webhook.create', {
      endpointId: `whe_${crypto.randomUUID().slice(0, 12)}`, assistantId: ids.at(-1), url: `${base}/hook`, hooks: ['call_end'], secret: newWebhookSecret(),
    })
    expect(more).toMatchObject({ status: 409, body: { error: expect.stringMatching(/At most 10 webhooks/) } })
  })

  test('creates at the same time cannot pass the cap or the one-per-assistant rule together', async () => {
    const own = await createWorkspace('Endpoint Race Plumbing')
    const actor: Actor = { actorId: own.owner.userId, role: 'owner', workspaceId: own.id, permissions: rolePermissions.owner }
    const [second] = await moreAssistants(own.id, 1)
    const create = (tx: Tx) =>
      webhookHandlers['webhook.create']!({ tx, actor, now: new Date().toISOString() }, {
        endpointId: `whe_${crypto.randomUUID().slice(0, 12)}`, assistantId: second, url: `${base}/hook`, hooks: ['call_end'], secret: newWebhookSecret(),
      })
    // The first create holds its transaction open while the second one runs: the second must wait and then see the first.
    let again: Promise<unknown> | undefined
    await db.transaction(async tx => {
      await create(tx)
      again = db.transaction(tx2 => create(tx2)).then(() => 'created', (e: Error) => e.message)
      await new Promise(resolve => setTimeout(resolve, 300))
    })
    expect(await again).toMatch(/has a webhook already/)
    expect(await db.select().from(webhook_endpoints).where(eq(webhook_endpoints.assistant_id, second!))).toHaveLength(1)
  })
})

describe('sending goes to the address that was checked', () => {
  const resolveTo = (address: string, family = 4) => (_host: string, callback: (err: Error | null, list: { address: string; family: number }[]) => void) =>
    callback(null, [{ address, family }])
  const lookupOnce = (lookup: ReturnType<typeof publicLookup>, all: boolean) =>
    new Promise<unknown[]>(resolve => lookup('hooks.example.com', { all }, (...args: unknown[]) => resolve(args)))

  test('the lookup refuses a name that resolves to a private address, and hands over the one it checked', async () => {
    const [refused] = await lookupOnce(publicLookup(resolveTo('127.0.0.1')), false)
    expect(refused).toMatchObject({ code: 'EPRIVATEADDRESS' })
    expect(await lookupOnce(publicLookup(resolveTo('::ffff:a9fe:a9fe', 6)), true)).toMatchObject([{ code: 'EPRIVATEADDRESS' }])
    expect(await lookupOnce(publicLookup(resolveTo('93.184.215.14')), false)).toEqual([null, '93.184.215.14', 4])
    expect(await lookupOnce(publicLookup(resolveTo('93.184.215.14')), true)).toEqual([null, [{ address: '93.184.215.14', family: 4 }]])
  })

  test('a real request to a name for a private address is refused when it connects', async () => {
    const port = (server.address() as AddressInfo).port
    // On the default port, so the port check passes and the connection's lookup is what refuses it.
    expect(await sendWebhook('https://localhost/hook', 'whsec_x', 'whd_1', 'webhook.test', '{}', { env: {} })).toEqual({
      ok: false, responseStatus: null, error: 'that address is private; webhooks go to public ones only',
    })
    // Another port is refused before any connection.
    expect(await sendWebhook(`https://localhost:${port}/hook`, 'whsec_x', 'whd_1', 'webhook.test', '{}', { env: {} })).toMatchObject({
      ok: false, responseStatus: null, error: 'Use port 443 or 8443.',
    })
    expect(received).toEqual([])
  })

  test('a failed connection says only "could not connect"; a slow one, that it did not answer in time', async () => {
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise(resolve => closed.close(resolve))
    expect(await sendWebhook(`http://127.0.0.1:${port}/hook`, 'whsec_x', 'whd_2', 'webhook.test', '{}', { env: { WEBHOOK_ALLOW_PRIVATE_URLS: 'true' } }))
      .toEqual({ ok: false, responseStatus: null, error: 'could not connect' })
    replyDelayMs = 400
    expect(await sendWebhook(`${base}/hook`, 'whsec_x', 'whd_3', 'webhook.test', '{}', { timeoutMs: 200 })).toEqual({ ok: false, responseStatus: null, error: 'no answer within 200 ms' })
  })
})

describe('when a call starts', () => {
  test('the caller is POSTed signed; what the answer says about them is kept on the call and logged', async () => {
    const { endpointId, secret } = await addHook(['call_start'])
    replyBody = JSON.stringify({ name: 'Sam', plan: 'Premium', address: { city: 'Portland' }, 'not a name': 1 })
    const callId = await newCall()
    const looked = await act(agent(ws.id), 'call.lookUpCaller', { callId })
    expect(looked).toMatchObject({ status: 200, body: { data: { details: { name: 'Sam', plan: 'Premium' } } } })
    const [request] = received
    expect(request!.headers['linedesk-hook']).toBe('call_start')
    expect(verify(secret, request!)).toBe(true)
    expect(JSON.parse(request!.body)).toMatchObject({
      hook: 'call_start', call_id: callId, assistant_id: ws.assistant.id, from_number: ws.contact.phone, to_number: ws.number,
      caller: { contact_id: ws.contact.id, name_confirmed: false },
    })
    expect((await callRow(callId)).caller_details).toEqual({ name: 'Sam', plan: 'Premium' })
    expect(await deliveriesOf(endpointId)).toMatchObject([{ event: 'call_start', status: 'delivered', attempts: 1, payload: { call_id: callId, reply: { name: 'Sam', plan: 'Premium' } } }])
  })

  test('caller.name_confirmed is true only for a name the team gave or confirmed', async () => {
    await addHook(['call_start'])
    const callerAfter = async (name_source: 'member' | 'caller' | null) => {
      await db.update(contacts).set({ name_source }).where(eq(contacts.id, ws.contact.id))
      received.length = 0
      await act(agent(ws.id), 'call.lookUpCaller', { callId: await newCall() })
      return JSON.parse(received[0]!.body).caller
    }
    try {
      expect(await callerAfter('member')).toMatchObject({ name: ws.contact.name, name_confirmed: true })
      expect(await callerAfter('caller')).toMatchObject({ name: ws.contact.name, name_confirmed: false })
      expect(await callerAfter(null)).toMatchObject({ name_confirmed: false })
    } finally {
      await db.update(contacts).set({ name_source: null }).where(eq(contacts.id, ws.contact.id))
    }
  })

  test(`an answer later than ${CALL_START_TIMEOUT_MS} ms, a failure or no JSON give no details; failures switch the webhook off`, async () => {
    const { endpointId } = await addHook(['call_start'])
    replyDelayMs = CALL_START_TIMEOUT_MS + 300
    replyBody = JSON.stringify({ name: 'Too late' })
    const slow = await newCall()
    expect((await act(agent(ws.id), 'call.lookUpCaller', { callId: slow })).body.data).toEqual({ details: null })
    expect((await callRow(slow)).caller_details).toBeNull()
    expect((await deliveriesOf(endpointId))[0]).toMatchObject({ status: 'failed', error: 'no answer within 1 s' })
    replyDelayMs = 0
    replyBody = 'not json'
    expect((await act(agent(ws.id), 'call.lookUpCaller', { callId: await newCall() })).body.data).toEqual({ details: null })
    expect((await endpointRow(endpointId)).failure_count).toBe(0) // a 2xx without details is an answer, not a failure
    answer = 500
    for (let i = 0; i < WEBHOOK_DISABLE_AFTER; i++) await act(agent(ws.id), 'call.lookUpCaller', { callId: await newCall() })
    expect(await endpointRow(endpointId)).toMatchObject({ status: 'disabled', failure_count: WEBHOOK_DISABLE_AFTER })
    received.length = 0
    expect((await act(agent(ws.id), 'call.lookUpCaller', { callId: await newCall() })).body.data).toEqual({ details: null })
    expect(received).toEqual([]) // switched off: not asked
  })

  test('test calls, assistants without the webhook and a webhook without the hook ask nothing; only the agent may ask', async () => {
    const callId = await newCall()
    expect((await act(agent(ws.id), 'call.lookUpCaller', { callId })).body.data).toEqual({ details: null })
    const { endpointId } = await addHook(['call_end'])
    expect((await act(agent(ws.id), 'call.lookUpCaller', { callId })).body.data).toEqual({ details: null })
    expect((await act(ws.owner, 'webhook.update', { endpointId, hooks: ['call_start', 'call_end'] })).status).toBe(200)
    await db.update(calls).set({ source: 'test' }).where(eq(calls.id, callId))
    expect((await act(agent(ws.id), 'call.lookUpCaller', { callId })).body.data).toEqual({ details: null })
    expect(received).toEqual([])
    expect((await act(ws.owner, 'call.lookUpCaller', { callId })).status).toBe(403)
  })
})

const orderStatus: WebhookLookup = {
  name: 'order_status',
  when: 'The caller asks where their order is',
  fields: [
    { name: 'order_number', type: 'text', description: 'The order number', required: true },
    { name: 'items', type: 'number', description: 'How many items', required: false },
  ],
}

/** A webhook with the during-call hook and the order-status lookup. */
async function addLookups(hooks: WebhookHook[] = ['during_call']) {
  const added = await addHook(hooks)
  const res = await act(ws.owner, 'webhook.update', { endpointId: added.endpointId, lookups: [orderStatus] })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return added
}
const ask = (callId: string, values: Record<string, unknown> = { order_number: '1234' }, lookup = 'order_status') =>
  act(agent(ws.id), 'call.askWebhook', { callId, lookup, values })

describe('during the call', () => {
  test("the assistant's lookup is POSTed signed with the fields the caller gave; the answer comes back and is logged", async () => {
    const { endpointId, secret } = await addLookups()
    replyBody = JSON.stringify({ answer: 'Order 1234 shipped on Monday.\nArrives Thursday.', other: 'ignored' })
    const callId = await newCall()
    const asked = await ask(callId, { order_number: '1234', items: '2', color: 'red' })
    expect(asked).toMatchObject({ status: 200, body: { data: { answer: 'Order 1234 shipped on Monday. Arrives Thursday.', problem: null } } })
    const [request] = received
    expect(request!.headers['linedesk-hook']).toBe('during_call')
    expect(verify(secret, request!)).toBe(true)
    expect(JSON.parse(request!.body)).toMatchObject({
      hook: 'during_call', lookup: 'order_status', values: { order_number: '1234', items: 2 }, call_id: callId,
      assistant_id: ws.assistant.id, from_number: ws.contact.phone, test: false, caller: { contact_id: ws.contact.id },
    })
    expect(JSON.parse(request!.body).values).not.toHaveProperty('color')
    expect(await deliveriesOf(endpointId)).toMatchObject([
      { event: 'during_call', status: 'delivered', payload: { call_id: callId, lookup: 'order_status', reply: 'Order 1234 shipped on Monday. Arrives Thursday.' } },
    ])
  })

  test('call.start tells the agent the lookups only while the webhook is on and gets the hook', async () => {
    const lookupsOf = async () => ((await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })).body.data as { lookups: WebhookLookup[] }).lookups
    expect(await lookupsOf()).toEqual([])
    const { endpointId } = await addLookups(['call_end', 'during_call'])
    expect(await lookupsOf()).toEqual([orderStatus])
    await act(ws.owner, 'webhook.update', { endpointId, hooks: ['call_end'] })
    expect(await lookupsOf()).toEqual([])
    await act(ws.owner, 'webhook.update', { endpointId, hooks: ['call_end', 'during_call'], enabled: false })
    expect(await lookupsOf()).toEqual([])
  })

  test('a missing required field, an unknown lookup or the hook off send nothing; only the agent may ask', async () => {
    const callId = await newCall()
    expect((await ask(callId)).body.data).toEqual({ answer: null, problem: 'unavailable' })
    const { endpointId } = await addLookups(['call_end'])
    expect((await ask(callId)).body.data).toEqual({ answer: null, problem: 'unavailable' })
    await act(ws.owner, 'webhook.update', { endpointId, hooks: ['during_call'] })
    expect((await ask(callId, { items: 2 })).body.data).toEqual({ answer: null, problem: 'missing', missing: ['order_number'] })
    expect((await ask(callId, { order_number: '1' }, 'refund_status')).body.data).toEqual({ answer: null, problem: 'unavailable' })
    expect(received).toEqual([])
    expect((await act(ws.owner, 'call.askWebhook', { callId, lookup: 'order_status', values: { order_number: '1' } })).status).toBe(403)
    expect((await act(agent(other.id), 'call.askWebhook', { callId, lookup: 'order_status', values: { order_number: '1' } })).status).not.toBe(200)
    expect(received).toEqual([])
  })

  test(`test calls ask too; at most ${DURING_CALL_MAX_PER_CALL} requests per call`, async () => {
    await addLookups()
    replyBody = JSON.stringify({ answer: 'Shipped.' })
    const callId = await newCall()
    await db.update(calls).set({ source: 'test' }).where(eq(calls.id, callId))
    for (let i = 0; i < DURING_CALL_MAX_PER_CALL; i++) expect((await ask(callId)).body.data).toEqual({ answer: 'Shipped.', problem: null })
    expect(JSON.parse(received[0]!.body)).toMatchObject({ test: true })
    expect((await ask(callId)).body.data).toEqual({ answer: null, problem: 'limit' })
    expect(received).toHaveLength(DURING_CALL_MAX_PER_CALL)
    expect((await ask(await newCall())).body.data).toEqual({ answer: 'Shipped.', problem: null }) // another call has its own
  })

  test(`an answer later than ${DURING_CALL_TIMEOUT_MS} ms, an error or no "answer" fail; failures switch the webhook off`, async () => {
    const { endpointId } = await addLookups()
    replyDelayMs = DURING_CALL_TIMEOUT_MS + 300
    replyBody = JSON.stringify({ answer: 'Too late' })
    expect((await ask(await newCall())).body.data).toEqual({ answer: null, problem: 'failed' })
    expect((await deliveriesOf(endpointId))[0]).toMatchObject({ status: 'failed', error: 'no answer within 3 s' })
    replyDelayMs = 0
    replyBody = JSON.stringify({ status: 'shipped' })
    expect((await ask(await newCall())).body.data).toEqual({ answer: null, problem: 'failed' })
    expect((await endpointRow(endpointId)).failure_count).toBe(0) // a 2xx is an answer, if not a useful one
    answer = 500
    for (let i = 0; i < WEBHOOK_DISABLE_AFTER; i++) await ask(await newCall())
    expect(await endpointRow(endpointId)).toMatchObject({ status: 'disabled', failure_count: WEBHOOK_DISABLE_AFTER })
  }, 15_000)

  test('lookups are for owners and admins, checked on the server', async () => {
    const { endpointId } = await addHook(['during_call'])
    expect((await act(member, 'webhook.update', { endpointId, lookups: [orderStatus] })).status).toBe(403)
    expect((await act(ws.owner, 'webhook.update', { endpointId, lookups: [orderStatus, orderStatus] })).status).toBe(422)
    expect((await act(ws.owner, 'webhook.update', { endpointId, lookups: [{ ...orderStatus, name: 'Order status' }] })).status).toBe(422)
    expect((await endpointRow(endpointId)).lookups).toEqual([])
  })
})

describe('after the call', () => {
  test('a finished call queues one request; the first attempt sends the whole call, signed', async () => {
    const { endpointId, secret } = await addHook(['call_end'])
    const callId = await newCall()
    await act(agent(ws.id), 'call.appendTranscript', { callId, speaker: 'agent', text: 'Thanks for calling, this is Maya.', atMs: 0 })
    await act(agent(ws.id), 'call.appendTranscript', { callId, speaker: 'caller', text: 'My water heater is leaking.', atMs: 3100 })
    await act(agent(ws.id), 'call.takeMessage', { callId, message: 'Call Sam back about the water heater' })
    await db.insert(bookings).values({ id: `bk_${callId}`, workspace_id: ws.id, call_id: callId, start_at: '2026-11-13T17:00:00.000Z', end_at: '2026-11-13T18:00:00.000Z', title: 'Water heater' })
    await db.update(calls).set({ caller_details: { name: 'Sam' }, recording_key: recordingKey(ws.id, callId, 'ogg') }).where(eq(calls.id, callId))
    expect((await finishCall(callId)).status).toBe(200)
    expect((await finishCall(callId)).status).toBe(200) // an agent retry is not a second call
    const [queued, ...rest] = await deliveriesOf(endpointId)
    expect(rest).toEqual([])
    expect(queued).toMatchObject({ event: 'call_end', status: 'pending', payload: { hook: 'call_end', call_id: callId } })

    expect(await attemptDelivery(db, queued!.id)).toBe('delivered')
    const [request] = received
    expect(request!.headers['linedesk-hook']).toBe('call_end')
    expect(request!.headers['linedesk-delivery']).toBe(queued!.id)
    expect(verify(secret, request!)).toBe(true)
    const body = JSON.parse(request!.body)
    expect(body).toMatchObject({
      hook: 'call_end', call_id: callId, workspace_id: ws.id, assistant_id: ws.assistant.id, from_number: ws.contact.phone, to_number: ws.number,
      outcome: 'message', summary: 'Water heater leaking.',
      caller: { contact_id: ws.contact.id }, caller_details: { name: 'Sam' },
      transcript: [{ speaker: 'agent', text: 'Thanks for calling, this is Maya.', at_ms: 0 }, { speaker: 'caller', text: 'My water heater is leaking.', at_ms: 3100 }],
      bookings: [{ id: `bk_${callId}`, status: 'confirmed', title: 'Water heater', start_at: '2026-11-13T17:00:00.000Z', end_at: '2026-11-13T18:00:00.000Z' }],
      transfer: null,
    })
    expect(body.started_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(body.ended_at).toMatch(/Z$/)
    expect(body.transcript_text).toMatch(/: Thanks for calling, this is Maya\.\nCaller: My water heater is leaking\.$/)
    expect(body.call_url).toMatch(new RegExp(`/#call/${callId}$`))
    expect(body.recording_url).toMatch(new RegExp(`/v1/calls/${callId}/recording\\?expires=\\d+&signature=[0-9a-f]{64}$`))
    expect(Date.parse(body.recording_expires_at) - Date.now()).toBeGreaterThan(6 * 86_400_000)
    expect((await deliveriesOf(endpointId))[0]).toMatchObject({ status: 'delivered', attempts: 1, response_status: 200, payload: { call_id: callId, summary: 'Water heater leaking.' } })
    expect((await endpointRow(endpointId)).last_delivery_at).not.toBeNull()
    expect(await attemptDelivery(db, queued!.id)).toBe('skipped') // a duplicate job sends nothing
  })

  test('the recording link opens without signing in only with its own signature, and only until it expires', async () => {
    await addHook(['call_end'])
    const callId = await newCall({ finish: true })
    await db.update(calls).set({ recording_key: recordingKey(ws.id, callId, 'ogg') }).where(eq(calls.id, callId))
    const [queued] = await deliveriesOf((await db.select().from(webhook_endpoints).where(eq(webhook_endpoints.workspace_id, ws.id)))[0]!.id)
    await attemptDelivery(db, queued!.id)
    const link = new URL(JSON.parse(received[0]!.body).recording_url)
    const path = `${link.pathname}${link.search}`
    // Signed: past the sign-in; no file in this test's store, so "no recording", not "not signed in".
    expect(await request(anonymous, 'GET', path)).toMatchObject({ status: 404, body: { error: 'no recording for this call' } })
    const tampered = path.replace(/signature=[0-9a-f]/, m => `${m.slice(0, -1)}${m.endsWith('0') ? '1' : '0'}`)
    expect(await request(anonymous, 'GET', tampered)).toMatchObject({ status: 403, body: { error: 'this recording link is not valid' } })
    expect((await request(anonymous, 'GET', path.replace(`/calls/${callId}/`, `/calls/${ws.call.id}/`))).status).toBe(403)
    expect((await request(anonymous, 'GET', path.replace(/expires=\d+/, 'expires=1000'))).status).toBe(403)
    expect((await request(anonymous, 'GET', `/v1/calls/${callId}/recording`)).status).toBe(401)
  })

  test('test calls, assistants without the webhook, a webhook without the hook and switched-off webhooks get nothing', async () => {
    const callId = await newCall({ finish: true })
    const { endpointId } = await addHook(['call_end'])
    const test = await newCall()
    await db.update(calls).set({ source: 'test' }).where(eq(calls.id, test))
    await finishCall(test)
    expect((await act(ws.owner, 'webhook.update', { endpointId, hooks: ['call_start'] })).status).toBe(200)
    await newCall({ finish: true })
    expect((await act(ws.owner, 'webhook.update', { endpointId, hooks: ['call_end'], enabled: false })).status).toBe(200)
    await newCall({ finish: true })
    expect(await deliveriesOf(endpointId)).toEqual([])
    expect(callId).toBeTruthy()
  })
})

describe('delivery', () => {
  async function queuedDelivery() {
    const { endpointId, secret } = await addHook(['call_end'])
    const callId = await newCall({ finish: true })
    const [delivery] = await deliveriesOf(endpointId)
    return { endpointId, secret, callId, deliveryId: delivery!.id }
  }

  test(`a failing webhook is tried up to ${WEBHOOK_ATTEMPTS} times with the same body, then the delivery fails and counts`, async () => {
    const { endpointId, deliveryId } = await queuedDelivery()
    answer = 500
    for (let i = 1; i < WEBHOOK_ATTEMPTS; i++) expect(await attemptDelivery(db, deliveryId)).toBe('retry')
    expect(await attemptDelivery(db, deliveryId)).toBe('failed')
    expect(new Set(received.map(r => JSON.stringify(JSON.parse(r.body), Object.keys(JSON.parse(r.body)).sort()))).size).toBe(1)
    expect((await deliveriesOf(endpointId))[0]).toMatchObject({ status: 'failed', attempts: WEBHOOK_ATTEMPTS, response_status: 500, error: 'answered 500' })
    expect((await endpointRow(endpointId)).failure_count).toBe(1)
  })

  test(`after ${WEBHOOK_DISABLE_AFTER} failed deliveries in a row the webhook is switched off; on again resets it`, async () => {
    const { endpointId } = await addHook(['call_end'])
    answer = 503
    for (let n = 0; n < WEBHOOK_DISABLE_AFTER; n++) {
      await newCall({ finish: true })
      const [pending] = (await deliveriesOf(endpointId)).filter(d => d.status === 'pending')
      for (let i = 0; i < WEBHOOK_ATTEMPTS; i++) await attemptDelivery(db, pending!.id)
    }
    const off = await endpointRow(endpointId)
    expect(off).toMatchObject({ status: 'disabled', failure_count: WEBHOOK_DISABLE_AFTER })
    expect(off.disabled_reason).toMatch(/Switched off after 5 failed deliveries in a row \(last: answered 503\)/)
    await newCall({ finish: true })
    expect((await deliveriesOf(endpointId)).filter(d => d.status === 'pending')).toEqual([])

    expect((await act(ws.owner, 'webhook.update', { endpointId, enabled: true })).status).toBe(200)
    expect(await endpointRow(endpointId)).toMatchObject({ status: 'active', failure_count: 0, disabled_reason: null })
  })

  test('test-send: an example request of either hook; for call start, the caller details it answered', async () => {
    const end = await addHook(['call_end'])
    answer = 204
    expect((await act(ws.owner, 'webhook.test', { endpointId: end.endpointId, hook: 'call_end' })).body.data).toMatchObject({ ok: true, responseStatus: 204, error: null })
    expect(JSON.parse(received[0]!.body)).toMatchObject({ hook: 'call_end', call_id: 'call_test', transcript: expect.any(Array) })
    expect(received[0]!.headers['linedesk-hook']).toBe('webhook.test')
    answer = 410
    expect((await act(ws.owner, 'webhook.test', { endpointId: end.endpointId, hook: 'call_end' })).body.data).toMatchObject({ ok: false, responseStatus: 410, error: 'answered 410' })
    const log = (await act(ws.owner, 'webhook.deliveries', { endpointId: end.endpointId })).body.data.deliveries
    expect(log.map((d: { status: string }) => d.status)).toEqual(['failed', 'delivered'])
    expect(log[0]).toMatchObject({ event: 'webhook.test', response_status: 410 })
    expect(log[0]).not.toHaveProperty('payload')
    expect((await endpointRow(end.endpointId)).failure_count).toBe(0) // tests never switch a webhook off

    answer = 200
    replyBody = JSON.stringify({ name: 'Sam' })
    expect((await act(ws.owner, 'webhook.test', { endpointId: end.endpointId, hook: 'call_start' })).body.data).toMatchObject({ ok: true, details: { name: 'Sam' } })
    expect(JSON.parse(received.at(-1)!.body)).toMatchObject({ hook: 'call_start', call_id: 'call_test' })

    expect((await act(ws.owner, 'webhook.test', { endpointId: end.endpointId, hook: 'during_call' })).body.error).toMatch(/Add a lookup first/)
    await act(ws.owner, 'webhook.update', { endpointId: end.endpointId, lookups: [orderStatus] })
    replyBody = JSON.stringify({ answer: 'Order 1234 shipped.' })
    expect((await act(ws.owner, 'webhook.test', { endpointId: end.endpointId, hook: 'during_call' })).body.data).toMatchObject({ ok: true, answer: 'Order 1234 shipped.' })
    expect(JSON.parse(received.at(-1)!.body)).toMatchObject({ hook: 'during_call', lookup: 'order_status', values: { order_number: 'example', items: 1234 }, test: true })
    expect((await act(ws.owner, 'webhook.test', { endpointId: end.endpointId, hook: 'during_call', lookup: 'refund' })).status).toBe(409)
  })

  test(`test sends are not commands, and at most ${WEBHOOK_TESTS_PER_MINUTE} a minute per workspace`, async () => {
    const own = await createWorkspace('Test Send Business')
    const [assistantId] = await moreAssistants(own.id, 1) // the fixture's webhook is on the first one
    const { endpointId } = await addHook(['call_end'], own.owner, assistantId)
    for (let i = 0; i < WEBHOOK_TESTS_PER_MINUTE; i++) expect((await act(own.owner, 'webhook.test', { endpointId, hook: 'call_end' })).status).toBe(200)
    expect(await act(own.owner, 'webhook.test', { endpointId, hook: 'call_end' })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/test requests a minute/) } })
    expect(await db.select().from(commands).where(and(eq(commands.workspace_id, own.id), eq(commands.action, 'webhook.test')))).toEqual([])
  })

  test(`payloads are cleared after ${WEBHOOK_PAYLOAD_DAYS} days and when their call is deleted; the delivery stays`, async () => {
    const { endpointId, callId, deliveryId } = await queuedDelivery()
    expect((await act(ws.owner, 'call.delete', { callId })).status).toBe(200)
    expect((await deliveriesOf(endpointId))[0]).toMatchObject({ payload: null, event: 'call_end', status: 'pending' })
    expect(await attemptDelivery(db, deliveryId)).toBe('skipped') // nothing of a deleted call is sent
    expect((await deliveriesOf(endpointId))[0]).toMatchObject({ status: 'failed', error: 'the call was deleted' })
    expect(received).toEqual([])

    await newCall({ finish: true })
    const [old] = (await deliveriesOf(endpointId)).filter(d => d.status === 'pending')
    await attemptDelivery(db, old!.id)
    expect(await clearOldPayloads(db, new Date(Date.now() + (WEBHOOK_PAYLOAD_DAYS - 1) * 86_400_000))).toBe(0)
    expect(await clearOldPayloads(db, new Date(Date.now() + (WEBHOOK_PAYLOAD_DAYS + 1) * 86_400_000))).toBeGreaterThan(0)
    expect((await deliveriesOf(endpointId)).find(d => d.id === old!.id)).toMatchObject({ payload: null, status: 'delivered', response_status: 200 })
  })

  test('deleting a webhook removes its log and secret; its pending deliveries send nothing', async () => {
    const { endpointId, deliveryId } = await queuedDelivery()
    expect(await act(ws.owner, 'webhook.delete', { endpointId })).toMatchObject({ status: 200, body: { deleted: { webhook_endpoints: [endpointId] } } })
    expect(await deliveriesOf(endpointId)).toEqual([])
    expect(await db.select().from(webhook_secrets).where(and(eq(webhook_secrets.endpoint_id, endpointId)))).toEqual([])
    expect(await attemptDelivery(db, deliveryId)).toBe('skipped')
  })

  test('webhooks from before they were per assistant are not shown to the actions', async () => {
    await db.insert(webhook_endpoints).values({ id: 'whe_legacy', workspace_id: ws.id, url: `${base}/old`, events: ['booking.created'], created_by: ws.owner.userId })
    expect(await act(ws.owner, 'webhook.test', { endpointId: 'whe_legacy', hook: 'call_end' })).toMatchObject({ status: 409, body: { error: 'webhook not found' } })
  })
})
