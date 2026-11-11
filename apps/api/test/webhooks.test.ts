// Outbound webhooks: endpoints through the registry (owners and admins, own workspace only), the
// secret stored encrypted and never logged, events queued with the write that caused them, signed
// deliveries to a real local server, retries, the delivery log and switching off after failures.
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { newWebhookSecret } from '@linedesk/actions'
import { calls, commands, webhook_deliveries, webhook_endpoints, webhook_secrets } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import {
  attemptDelivery, clearOldPayloads, isPrivateAddress, publicLookup, SIGNATURE_HEADER, sendWebhook, urlProblem, WEBHOOK_ATTEMPTS,
  WEBHOOK_DISABLE_AFTER, WEBHOOK_PAYLOAD_DAYS, WEBHOOK_TESTS_PER_MINUTE,
} from '../src/webhooks.ts'
import { act, addMember, agent, createWorkspace, type User, type Workspace } from './helpers.ts'

type Received = { headers: Record<string, string | string[] | undefined>; body: string }

let ws: Workspace
let other: Workspace
let member: User
let server: Server
let base: string
const received: Received[] = []
/** What the receiver answers next. */
let answer = 200

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

async function addEndpoint(events: string[] = ['call.completed', 'call.summary_ready', 'message.taken', 'booking.created'], owner = ws.owner) {
  const endpointId = `whe_${crypto.randomUUID().slice(0, 12)}`
  const secret = newWebhookSecret()
  const res = await act(owner, 'webhook.create', { endpointId, url: `${base}/hook`, events, secret })
  expect(res.status).toBe(200)
  return { endpointId, secret }
}

const deliveriesOf = (endpointId: string) => db.select().from(webhook_deliveries).where(eq(webhook_deliveries.endpoint_id, endpointId))
const endpointRow = async (endpointId: string) => (await db.select().from(webhook_endpoints).where(eq(webhook_endpoints.id, endpointId)))[0]!

describe('endpoints', () => {
  test('the secret is stored encrypted and never in the command log; members cannot manage endpoints', async () => {
    const { endpointId, secret } = await addEndpoint()
    const [stored] = await db.select().from(webhook_secrets).where(eq(webhook_secrets.endpoint_id, endpointId))
    expect(stored!.secret_encrypted).not.toContain(secret)
    const logged = await db.select().from(commands).where(eq(commands.action, 'webhook.create'))
    expect(JSON.stringify(logged)).not.toContain(secret)
    expect((await act(member, 'webhook.create', { endpointId: 'whe_x', url: `${base}/x`, events: ['call.completed'], secret })).status).toBe(403)
    expect((await act(member, 'webhook.deliveries', { endpointId })).status).toBe(403)
  })

  test('another workspace cannot see, test, change or delete an endpoint', async () => {
    const { endpointId } = await addEndpoint()
    for (const [name, input] of [['webhook.deliveries', {}], ['webhook.test', {}], ['webhook.update', { enabled: false }], ['webhook.delete', {}]] as const)
      expect(await act(other.owner, name, { endpointId, ...input })).toMatchObject({ status: 409, body: { error: 'webhook endpoint not found' } })
    expect((await endpointRow(endpointId)).status).toBe('active')
  })

  test('a weak secret, an unknown event and a non-http URL are refused', async () => {
    const input = { endpointId: 'whe_bad', url: `${base}/hook`, events: ['call.completed'], secret: newWebhookSecret() }
    expect((await act(ws.owner, 'webhook.create', { ...input, secret: 'whsec_short' })).status).toBe(422)
    expect((await act(ws.owner, 'webhook.create', { ...input, events: ['call.deleted'] })).status).toBe(422)
    expect((await act(ws.owner, 'webhook.create', { ...input, url: 'ftp://example.com/hook' })).status).toBe(422)
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
    // localhost resolves to 127.0.0.1: the connection's own lookup refuses it (no private switch).
    const port = (server.address() as AddressInfo).port
    received.length = 0
    expect(await sendWebhook(`https://localhost:${port}/hook`, 'whsec_x', 'whd_1', 'webhook.test', '{}', {})).toEqual({
      ok: false, responseStatus: null, error: 'that address is private; webhooks go to public ones only',
    })
    expect(received).toEqual([])
  })

  test('a failed connection says only "could not connect", whatever the reason', async () => {
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise(resolve => closed.close(resolve))
    expect(await sendWebhook(`http://127.0.0.1:${port}/hook`, 'whsec_x', 'whd_2', 'webhook.test', '{}', { WEBHOOK_ALLOW_PRIVATE_URLS: 'true' }))
      .toEqual({ ok: false, responseStatus: null, error: 'could not connect' })
  })
})

describe('events', () => {
  test('a finished call queues call.completed and call.summary_ready for subscribed endpoints only, once', async () => {
    const all = await addEndpoint()
    const onlySummary = await addEndpoint(['call.summary_ready'])
    const started = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
    const { callId } = started.body.data
    const finish = () => act(agent(ws.id), 'call.finish', { callId, outcome: 'message', summary: 'Water heater leaking.' })
    expect((await finish()).status).toBe(200)
    expect((await finish()).status).toBe(200) // an agent retry is not a new event
    const events = (await deliveriesOf(all.endpointId)).map(d => d.event).sort()
    expect(events).toEqual(['call.completed', 'call.summary_ready'])
    const [summary] = await deliveriesOf(onlySummary.endpointId)
    expect(summary).toMatchObject({ event: 'call.summary_ready', status: 'pending' })
    expect(summary!.payload).toMatchObject({ type: 'call.summary_ready', workspace_id: ws.id, data: { call: { id: callId, summary: 'Water heater leaking.', outcome: 'message' } } })
  })

  test('a message the assistant takes queues message.taken; test calls and switched-off endpoints get nothing', async () => {
    const { endpointId } = await addEndpoint(['message.taken'])
    const off = await addEndpoint(['message.taken'])
    expect((await act(ws.owner, 'webhook.update', { endpointId: off.endpointId, enabled: false })).status).toBe(200)
    expect((await act(agent(ws.id), 'call.takeMessage', { callId: ws.call.id, message: 'Call back about the estimate' })).status).toBe(200)
    expect((await deliveriesOf(endpointId))[0]!.payload).toMatchObject({ type: 'message.taken', data: { call_id: ws.call.id, message: 'Call back about the estimate' } })
    expect(await deliveriesOf(off.endpointId)).toEqual([])

    await db.update(calls).set({ source: 'test' }).where(eq(calls.id, ws.call.id))
    await act(agent(ws.id), 'call.takeMessage', { callId: ws.call.id, message: 'Only a test' })
    await db.update(calls).set({ source: 'phone' }).where(eq(calls.id, ws.call.id))
    expect(await deliveriesOf(endpointId)).toHaveLength(1)
  })
})

describe('delivery', () => {
  async function queuedDelivery() {
    const { endpointId, secret } = await addEndpoint(['message.taken'])
    await act(agent(ws.id), 'call.takeMessage', { callId: ws.call.id, message: 'Please call back' })
    const [delivery] = await deliveriesOf(endpointId)
    return { endpointId, secret, deliveryId: delivery!.id }
  }

  test('POSTs the event signed with the endpoint secret over timestamp and body', async () => {
    const { endpointId, secret, deliveryId } = await queuedDelivery()
    answer = 200
    received.length = 0
    expect(await attemptDelivery(db, deliveryId)).toBe('delivered')
    const [request] = received
    expect(request!.headers['linedesk-event']).toBe('message.taken')
    expect(request!.headers['linedesk-delivery']).toBe(deliveryId)
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(request!.headers[SIGNATURE_HEADER]))!
    expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${request!.body}`).digest('hex'))
    expect(Math.abs(Number(t) - Date.now() / 1000)).toBeLessThan(5)
    expect(JSON.parse(request!.body)).toMatchObject({ type: 'message.taken', data: { message: 'Please call back' } })
    expect((await deliveriesOf(endpointId))[0]).toMatchObject({ status: 'delivered', attempts: 1, response_status: 200 })
    expect((await endpointRow(endpointId)).last_delivery_at).not.toBeNull()
    expect(await attemptDelivery(db, deliveryId)).toBe('skipped') // a duplicate job sends nothing
  })

  test(`a failing endpoint is retried up to ${WEBHOOK_ATTEMPTS} attempts, then the delivery fails and counts`, async () => {
    const { endpointId, deliveryId } = await queuedDelivery()
    answer = 500
    for (let i = 1; i < WEBHOOK_ATTEMPTS; i++) expect(await attemptDelivery(db, deliveryId)).toBe('retry')
    expect(await attemptDelivery(db, deliveryId)).toBe('failed')
    expect((await deliveriesOf(endpointId))[0]).toMatchObject({ status: 'failed', attempts: WEBHOOK_ATTEMPTS, response_status: 500, error: 'answered 500' })
    expect((await endpointRow(endpointId)).failure_count).toBe(1)
  })

  test(`after ${WEBHOOK_DISABLE_AFTER} failed deliveries in a row the endpoint is switched off; on again resets it`, async () => {
    const { endpointId } = await addEndpoint(['message.taken'])
    answer = 503
    for (let n = 0; n < WEBHOOK_DISABLE_AFTER; n++) {
      await act(agent(ws.id), 'call.takeMessage', { callId: ws.call.id, message: `try ${n}` })
      const [pending] = (await deliveriesOf(endpointId)).filter(d => d.status === 'pending')
      for (let i = 0; i < WEBHOOK_ATTEMPTS; i++) await attemptDelivery(db, pending!.id)
    }
    const off = await endpointRow(endpointId)
    expect(off).toMatchObject({ status: 'disabled', failure_count: WEBHOOK_DISABLE_AFTER })
    expect(off.disabled_reason).toMatch(/Switched off after 5 failed deliveries in a row \(last: answered 503\)/)
    await act(agent(ws.id), 'call.takeMessage', { callId: ws.call.id, message: 'while off' })
    expect((await deliveriesOf(endpointId)).filter(d => d.status === 'pending')).toEqual([])

    expect((await act(ws.owner, 'webhook.update', { endpointId, enabled: true })).status).toBe(200)
    expect(await endpointRow(endpointId)).toMatchObject({ status: 'active', failure_count: 0, disabled_reason: null })
  })

  test('test-send: answers at once, is logged, and the log lists newest first', async () => {
    const { endpointId } = await addEndpoint(['booking.created'])
    answer = 204
    expect((await act(ws.owner, 'webhook.test', { endpointId })).body.data).toMatchObject({ ok: true, responseStatus: 204, error: null })
    answer = 410
    expect((await act(ws.owner, 'webhook.test', { endpointId })).body.data).toMatchObject({ ok: false, responseStatus: 410, error: 'answered 410' })
    const log = (await act(ws.owner, 'webhook.deliveries', { endpointId })).body.data.deliveries
    expect(log.map((d: { status: string }) => d.status)).toEqual(['failed', 'delivered'])
    expect(log[0]).toMatchObject({ event: 'webhook.test', response_status: 410 })
    expect(log[0]).not.toHaveProperty('payload')
    expect((await endpointRow(endpointId)).failure_count).toBe(0) // tests never switch an endpoint off
  })

  test(`test sends are not commands, and at most ${WEBHOOK_TESTS_PER_MINUTE} a minute per workspace`, async () => {
    const own = await createWorkspace('Test Send Business')
    const { endpointId } = await addEndpoint(['booking.created'], own.owner)
    answer = 200
    for (let i = 0; i < WEBHOOK_TESTS_PER_MINUTE; i++) expect((await act(own.owner, 'webhook.test', { endpointId })).status).toBe(200)
    expect(await act(own.owner, 'webhook.test', { endpointId })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/test events a minute/) } })
    expect(await db.select().from(commands).where(and(eq(commands.workspace_id, own.id), eq(commands.action, 'webhook.test')))).toEqual([])
  })

  test(`payloads are cleared after ${WEBHOOK_PAYLOAD_DAYS} days and when their call is deleted; the delivery stays`, async () => {
    const { endpointId } = await addEndpoint(['message.taken'])
    const call = await act(agent(), 'call.start', { from: ws.contact.phone, to: ws.number })
    const { callId } = call.body.data
    await act(agent(ws.id), 'call.takeMessage', { callId, message: 'Water heater at 12 Elm St' })
    const [pending] = await deliveriesOf(endpointId)
    expect(pending!.payload).not.toBeNull()

    expect((await act(ws.owner, 'call.delete', { callId })).status).toBe(200)
    expect((await deliveriesOf(endpointId))[0]).toMatchObject({ payload: null, event: 'message.taken', status: 'pending' })
    expect(await attemptDelivery(db, pending!.id)).toBe('skipped') // nothing of a deleted call is sent
    expect((await deliveriesOf(endpointId))[0]).toMatchObject({ status: 'failed', error: 'the call was deleted' })

    const old = await addEndpoint(['message.taken'])
    await act(agent(ws.id), 'call.takeMessage', { callId: ws.call.id, message: 'Old message' })
    const [delivery] = await deliveriesOf(old.endpointId)
    answer = 200
    await attemptDelivery(db, delivery!.id)
    expect(await clearOldPayloads(db, new Date(Date.now() + (WEBHOOK_PAYLOAD_DAYS - 1) * 86_400_000))).toBe(0)
    expect(await clearOldPayloads(db, new Date(Date.now() + (WEBHOOK_PAYLOAD_DAYS + 1) * 86_400_000))).toBeGreaterThan(0)
    expect((await deliveriesOf(old.endpointId))[0]).toMatchObject({ payload: null, status: 'delivered', response_status: 200 })
  })

  test('deleting an endpoint removes its log and secret; its pending deliveries send nothing', async () => {
    const { endpointId, deliveryId } = await queuedDelivery()
    expect((await act(ws.owner, 'webhook.delete', { endpointId })).status).toBe(200)
    expect(await deliveriesOf(endpointId)).toEqual([])
    expect(await db.select().from(webhook_secrets).where(and(eq(webhook_secrets.endpoint_id, endpointId)))).toEqual([])
    expect(await attemptDelivery(db, deliveryId)).toBe('skipped')
  })
})
