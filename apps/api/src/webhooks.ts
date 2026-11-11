// Outbound webhooks (docs/webhooks.md). An event becomes one delivery row per subscribed, active
// endpoint and one pg-boss job each, in the transaction that caused it: no event for a write that
// did not commit. The job POSTs the event signed with the endpoint's secret and retries with backoff;
// an endpoint whose deliveries keep failing after every retry is switched off.
import { createHmac } from 'node:crypto'
import { type LookupAddress, lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import type { WebhookDeliveriesData, WebhookDeliverySummary, WebhookTestData } from '@linedesk/actions'
import { type Tx, webhook_deliveries, webhook_endpoints, webhook_secrets } from '@linedesk/db'
import type { Booking, Call, WebhookEvent } from '@linedesk/db/types'
import { and, desc, eq, isNotNull, lt, ne, or, sql } from 'drizzle-orm'
import { Agent, fetch as undiciFetch } from 'undici'
import { type Handler, Reject } from './handler-context.ts'
import { isPrivateAddress } from './ip-address.ts'
import { queueWebhookDelivery } from './jobs.ts'
import { createRateLimiter } from './rate-limit.ts'
import { decryptSecret, encryptSecret, hasSecretsKey } from './secrets.ts'

export { isPrivateAddress }

type Env = Record<string, string | undefined>

/** Attempts per delivery: the first and the retries pg-boss makes (jobs.ts), about an hour in all. */
export const WEBHOOK_ATTEMPTS = 7
/** Deliveries in a row that failed after every attempt before the endpoint is switched off. */
export const WEBHOOK_DISABLE_AFTER = 5
/** Test sends per workspace and minute. */
export const WEBHOOK_TESTS_PER_MINUTE = 10
/** Payloads hold callers' details: they are cleared after this many days (the delivery's status stays). */
export const WEBHOOK_PAYLOAD_DAYS = 30
const TIMEOUT_MS = 10_000
export const SIGNATURE_HEADER = 'linedesk-signature'

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const secretSlot = (endpointId: string) => `webhook.${endpointId}`
const short = (text: string) => (text.length > 300 ? `${text.slice(0, 297)}...` : text)

// --- Where deliveries may go -----------------------------------------------------------------

/** WEBHOOK_ALLOW_PRIVATE_URLS=true: development and closed networks may send to http and private addresses. */
const allowPrivate = (env: Env) => env.WEBHOOK_ALLOW_PRIVATE_URLS === 'true'
const PRIVATE = 'that address is private; webhooks go to public ones only'
/** Ports a webhook may use: HTTPS ones only, so a URL cannot aim at another service on a public host. */
export const WEBHOOK_PORTS = ['443', '8443']
/** Endpoints per workspace: each slow one holds a delivery worker for up to the timeout. */
export const WEBHOOK_ENDPOINTS_PER_WORKSPACE = 10

/** https, and not a private address written as such. Names are checked when they are resolved (publicLookup). */
function addressProblem(url: string, env: Env): string | null {
  if (allowPrivate(env)) return null
  const { protocol, hostname, port } = new URL(url)
  if (protocol !== 'https:') return 'Use an https address.'
  if (port && !WEBHOOK_PORTS.includes(port)) return `Use port ${WEBHOOK_PORTS.join(' or ')}.`
  const host = hostname.replace(/^\[|\]$/g, '')
  return isIP(host) && isPrivateAddress(host) ? PRIVATE : null
}

type Resolve = (hostname: string, callback: (err: Error | null, addresses: LookupAddress[]) => void) => void
const resolveAll: Resolve = (hostname, callback) => dnsLookup(hostname, { all: true }, callback)

/**
 * A `lookup` for the connection: resolves the name once and refuses it when any address is private,
 * so the request goes to exactly the address that was checked (no second lookup to rebind).
 */
export function publicLookup(resolve: Resolve = resolveAll) {
  return (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err)
      if (!addresses.length || addresses.some(a => isPrivateAddress(a.address)))
        return callback(Object.assign(new Error(PRIVATE), { code: 'EPRIVATEADDRESS' }))
      if (options.all) callback(null, addresses)
      else callback(null, addresses[0]!.address, addresses[0]!.family)
    })
  }
}

const publicAgent = new Agent({ connect: { lookup: publicLookup() as never, timeout: TIMEOUT_MS } })
const anyAgent = new Agent({ connect: { timeout: TIMEOUT_MS } })

/**
 * Why events must not go to this URL, or null: shown when an endpoint is saved. Sending checks again
 * on its own (addressProblem and publicLookup), since the name may point elsewhere by then.
 */
export async function urlProblem(url: string, env: Env = process.env): Promise<string | null> {
  const problem = addressProblem(url, env)
  if (problem || allowPrivate(env)) return problem
  const host = new URL(url).hostname
  if (isIP(host.replace(/^\[|\]$/g, ''))) return null
  const addresses = await new Promise<LookupAddress[] | null>(resolve => resolveAll(host, (err, list) => resolve(err ? null : list)))
  if (!addresses?.length) return `${host} could not be found.`
  return addresses.some(a => isPrivateAddress(a.address)) ? `${host}: ${PRIVATE}.` : null
}

// --- Signing and sending ---------------------------------------------------------------------

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, as Stripe does; receivers compare v1 and check t is recent. */
export function signature(secret: string, body: string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${mac}`
}

type Attempt = { ok: boolean; responseStatus: number | null; error: string | null }

const causeCode = (e: unknown): string | undefined => {
  const cause = e instanceof Error ? (e.cause as { code?: string } | undefined) : undefined
  return cause?.code
}

/**
 * POSTs one event. Failures before an answer are reported only as "could not connect" (or the
 * private-address refusal), so the log and the test send cannot be used to probe ports; the detail
 * goes to the server log.
 */
export async function sendWebhook(url: string, secret: string, deliveryId: string, event: string, body: string, env: Env = process.env): Promise<Attempt> {
  const problem = (() => {
    try {
      return addressProblem(url, env)
    } catch {
      return 'invalid address'
    }
  })()
  if (problem) return { ok: false, responseStatus: null, error: problem }
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      redirect: 'manual',
      dispatcher: allowPrivate(env) ? anyAgent : publicAgent,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Linedesk-Webhooks/1',
        'linedesk-event': event,
        'linedesk-delivery': deliveryId,
        [SIGNATURE_HEADER]: signature(secret, body, Math.floor(Date.now() / 1000)),
      },
      body,
    })
    await res.body?.cancel().catch(() => {})
    const ok = res.status >= 200 && res.status < 300
    return { ok, responseStatus: res.status, error: ok ? null : `answered ${res.status}` }
  } catch (e) {
    if (causeCode(e) === 'EPRIVATEADDRESS') return { ok: false, responseStatus: null, error: PRIVATE }
    console.warn(`webhook delivery ${deliveryId} could not connect: ${e instanceof Error ? `${e.message} ${causeCode(e) ?? ''}` : e}`)
    return { ok: false, responseStatus: null, error: 'could not connect' }
  }
}

// --- Events ----------------------------------------------------------------------------------

const callData = (call: Call) => ({
  id: call.id, from_number: call.from_number, to_number: call.to_number, direction: call.direction, started_at: call.started_at,
  ended_at: call.ended_at, duration_sec: call.duration_sec, outcome: call.outcome, urgency: call.urgency, title: call.title,
  summary: call.summary, action_items: call.action_items, fields: call.fields, contact_id: call.contact_id, assistant_id: call.assistant_id,
})
const bookingData = (b: Booking) => ({
  id: b.id, start_at: b.start_at, end_at: b.end_at, status: b.status, title: b.title, calendar_name: b.calendar_name,
  appointment_type_id: b.appointment_type_id, call_id: b.call_id, contact_id: b.contact_id,
})

/** What each event carries in `data`. */
export const webhookData = {
  callCompleted: (call: Call) => ({ call: callData(call) }),
  bookingCreated: (booking: Booking) => ({ booking: bookingData(booking) }),
  messageTaken: (call: Call, message: string) => ({ call_id: call.id, message, from_number: call.from_number, contact_id: call.contact_id }),
}

/**
 * Queues `event` for every active endpoint of the workspace that subscribed to it, in the caller's
 * transaction. Test calls send nothing. Without a queue (tests) the delivery rows are still written.
 */
export async function queueWebhookEvent(tx: Tx, workspaceId: string, event: WebhookEvent, data: Record<string, unknown>, now: string) {
  const endpoints = await tx.select({ id: webhook_endpoints.id }).from(webhook_endpoints).where(and(
    eq(webhook_endpoints.workspace_id, workspaceId), eq(webhook_endpoints.status, 'active'), sql`${webhook_endpoints.events} ? ${event}`,
  ))
  if (!endpoints.length) return
  const payload = { id: newId('evt'), type: event, created_at: now, workspace_id: workspaceId, data }
  const rows = endpoints.map(e => ({ id: newId('whd'), workspace_id: workspaceId, endpoint_id: e.id, event, payload }))
  await tx.insert(webhook_deliveries).values(rows)
  for (const row of rows) await queueWebhookDelivery(tx, row.id)
}

/** The events of a finished call: completed, and summary_ready when it has a summary. */
export async function queueCallFinishedEvents(tx: Tx, call: Call, now: string) {
  if (call.source === 'test') return
  await queueWebhookEvent(tx, call.workspace_id, 'call.completed', webhookData.callCompleted(call), now)
  if (call.summary) await queueWebhookEvent(tx, call.workspace_id, 'call.summary_ready', webhookData.callCompleted(call), now)
}

// --- Delivery (the job) ----------------------------------------------------------------------

/** Clears the payloads of deliveries older than WEBHOOK_PAYLOAD_DAYS (a daily job); status, attempts and times stay. */
export async function clearOldPayloads(tx: Tx, now = new Date()) {
  const before = new Date(now.getTime() - WEBHOOK_PAYLOAD_DAYS * 86_400_000).toISOString()
  const cleared = await tx.update(webhook_deliveries).set({ payload: null })
    .where(and(isNotNull(webhook_deliveries.payload), lt(webhook_deliveries.created_at, before), ne(webhook_deliveries.status, 'pending')))
    .returning({ id: webhook_deliveries.id })
  return cleared.length
}

/** Clears the payloads that carry a call (its own events, its message, its booking), when the call is deleted. */
export async function clearCallPayloads(tx: Tx, workspaceId: string, callId: string) {
  const data = sql`${webhook_deliveries.payload} -> 'data'`
  await tx.update(webhook_deliveries).set({ payload: null }).where(and(
    eq(webhook_deliveries.workspace_id, workspaceId),
    isNotNull(webhook_deliveries.payload),
    or(sql`${data} -> 'call' ->> 'id' = ${callId}`, sql`${data} ->> 'call_id' = ${callId}`, sql`${data} -> 'booking' ->> 'call_id' = ${callId}`),
  ))
}

export type DeliveryOutcome = 'delivered' | 'retry' | 'failed' | 'skipped'

/**
 * One attempt of a delivery. 'retry': the job should throw so pg-boss tries again later. After the
 * last attempt the delivery is failed and counts against the endpoint; WEBHOOK_DISABLE_AFTER of
 * those in a row switch it off. A success resets the count.
 */
export async function attemptDelivery(tx: Tx, deliveryId: string, env: Env = process.env): Promise<DeliveryOutcome> {
  const [found] = await tx.select({ delivery: webhook_deliveries, endpoint: webhook_endpoints, secret: webhook_secrets.secret_encrypted })
    .from(webhook_deliveries)
    .innerJoin(webhook_endpoints, eq(webhook_endpoints.id, webhook_deliveries.endpoint_id))
    .innerJoin(webhook_secrets, eq(webhook_secrets.endpoint_id, webhook_endpoints.id))
    .where(eq(webhook_deliveries.id, deliveryId))
  if (found?.delivery.status !== 'pending') return 'skipped'
  const { delivery, endpoint } = found
  const now = new Date().toISOString()
  if (endpoint.status !== 'active') {
    await tx.update(webhook_deliveries).set({ status: 'failed', error: 'endpoint is switched off' }).where(eq(webhook_deliveries.id, delivery.id))
    return 'skipped'
  }
  if (!delivery.payload) {
    await tx.update(webhook_deliveries).set({ status: 'failed', error: 'the call was deleted' }).where(eq(webhook_deliveries.id, delivery.id))
    return 'skipped'
  }
  const secret = decryptSecret(found.secret, secretSlot(endpoint.id))
  const result = await sendWebhook(endpoint.url, secret, delivery.id, delivery.event, JSON.stringify(delivery.payload), env)
  const attempts = delivery.attempts + 1
  const final = result.ok || attempts >= WEBHOOK_ATTEMPTS
  await tx.update(webhook_deliveries).set({
    attempts, response_status: result.responseStatus, error: result.error, last_attempt_at: now,
    status: result.ok ? 'delivered' : final ? 'failed' : 'pending',
  }).where(eq(webhook_deliveries.id, delivery.id))
  if (result.ok) {
    await tx.update(webhook_endpoints).set({ failure_count: 0, last_delivery_at: now }).where(eq(webhook_endpoints.id, endpoint.id))
    return 'delivered'
  }
  if (!final) return 'retry'
  await countFailure(tx, endpoint.id, result.error)
  return 'failed'
}

async function countFailure(tx: Tx, endpointId: string, error: string | null) {
  const [updated] = await tx.update(webhook_endpoints).set({ failure_count: sql`${webhook_endpoints.failure_count} + 1` })
    .where(eq(webhook_endpoints.id, endpointId)).returning({ failures: webhook_endpoints.failure_count })
  if (updated && updated.failures >= WEBHOOK_DISABLE_AFTER) {
    const reason = `Switched off after ${updated.failures} failed deliveries in a row (last: ${error ?? 'unknown error'}).`
    await tx.update(webhook_endpoints).set({ status: 'disabled', disabled_reason: short(reason) })
      .where(and(eq(webhook_endpoints.id, endpointId), eq(webhook_endpoints.status, 'active')))
  }
}

// --- Actions ---------------------------------------------------------------------------------

const allowTestSend = createRateLimiter({ max: WEBHOOK_TESTS_PER_MINUTE, windowMs: 60_000 })

function workspaceOf(actor: { workspaceId: string | null }) {
  if (!actor.workspaceId) throw new Reject('no workspace')
  return actor.workspaceId
}

async function checkUrl(url: string) {
  const problem = await urlProblem(url)
  if (problem) throw new Reject(problem)
}

async function endpointIn(tx: Tx, workspaceId: string, endpointId: string) {
  const [endpoint] = await tx.select().from(webhook_endpoints)
    .where(and(eq(webhook_endpoints.id, endpointId), eq(webhook_endpoints.workspace_id, workspaceId)))
  if (!endpoint) throw new Reject('webhook endpoint not found')
  return endpoint
}

export const webhookHandlers: Record<string, Handler> = {
  'webhook.create': async ({ tx, actor }, input: { endpointId: string; url: string; events: WebhookEvent[]; secret: string }) => {
    const workspace_id = workspaceOf(actor)
    if (!hasSecretsKey()) throw new Reject('Webhooks need SECRETS_KEY on the server to store their secret.')
    await checkUrl(input.url)
    const [taken] = await tx.select({ id: webhook_endpoints.id }).from(webhook_endpoints).where(eq(webhook_endpoints.id, input.endpointId))
    if (taken) throw new Reject('that endpoint id is taken')
    // Two creates at once would both count 9 and both insert: one workspace's creates take turns.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`webhook_endpoints:${workspace_id}`}))`)
    const [{ endpoints } = { endpoints: 0 }] = await tx.select({ endpoints: sql<number>`count(*)::int` }).from(webhook_endpoints).where(eq(webhook_endpoints.workspace_id, workspace_id))
    if (endpoints >= WEBHOOK_ENDPOINTS_PER_WORKSPACE)
      throw new Reject(`At most ${WEBHOOK_ENDPOINTS_PER_WORKSPACE} webhook endpoints per workspace. Delete one you no longer use.`)
    const [endpoint] = await tx.insert(webhook_endpoints).values({
      id: input.endpointId, workspace_id, url: input.url, events: [...new Set(input.events)], created_by: actor.actorId,
    }).returning()
    await tx.insert(webhook_secrets).values({ endpoint_id: endpoint!.id, workspace_id, secret_encrypted: encryptSecret(input.secret, secretSlot(endpoint!.id)) })
    return { rows: { webhook_endpoints: [endpoint!] }, data: { endpointId: endpoint!.id } }
  },

  'webhook.update': async ({ tx, actor }, input: { endpointId: string; url?: string; events?: WebhookEvent[]; enabled?: boolean }) => {
    const endpoint = await endpointIn(tx, workspaceOf(actor), input.endpointId)
    if (input.url !== undefined) await checkUrl(input.url)
    const switched = input.enabled === undefined ? {} : input.enabled
      ? { status: 'active' as const, disabled_reason: null, failure_count: 0 }
      : { status: 'disabled' as const, disabled_reason: null }
    const rows = await tx.update(webhook_endpoints).set({
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.events === undefined ? {} : { events: [...new Set(input.events)] }),
      ...switched,
    }).where(eq(webhook_endpoints.id, endpoint.id)).returning()
    return { rows: { webhook_endpoints: rows } }
  },

  'webhook.delete': async ({ tx, actor }, input: { endpointId: string }) => {
    const endpoint = await endpointIn(tx, workspaceOf(actor), input.endpointId)
    await tx.delete(webhook_endpoints).where(eq(webhook_endpoints.id, endpoint.id))
    return { rows: {}, deleted: { webhook_endpoints: [endpoint.id] }, data: { endpointId: endpoint.id } }
  },

  // Read-only in the registry, so it runs outside a transaction: the request to the endpoint never holds one open.
  'webhook.test': async ({ tx, actor, now }, input: { endpointId: string }) => {
    const workspaceId = workspaceOf(actor)
    const endpoint = await endpointIn(tx, workspaceId, input.endpointId)
    if (!allowTestSend(workspaceId)) throw new Reject(`At most ${WEBHOOK_TESTS_PER_MINUTE} test events a minute. Try again shortly.`)
    const [stored] = await tx.select().from(webhook_secrets).where(eq(webhook_secrets.endpoint_id, endpoint.id))
    if (!stored) throw new Reject('this endpoint has no secret; add it again')
    const id = newId('whd')
    const payload = { id: newId('evt'), type: 'webhook.test', created_at: now, workspace_id: endpoint.workspace_id, data: { endpoint_id: endpoint.id } }
    const result = await sendWebhook(endpoint.url, decryptSecret(stored.secret_encrypted, secretSlot(endpoint.id)), id, 'webhook.test', JSON.stringify(payload))
    await tx.insert(webhook_deliveries).values({
      id, workspace_id: endpoint.workspace_id, endpoint_id: endpoint.id, event: 'webhook.test', payload, attempts: 1,
      status: result.ok ? 'delivered' : 'failed', response_status: result.responseStatus, error: result.error, last_attempt_at: new Date().toISOString(),
    })
    const data: WebhookTestData = { deliveryId: id, ok: result.ok, responseStatus: result.responseStatus, error: result.error }
    return { rows: {}, data }
  },

  'webhook.deliveries': async ({ tx, actor }, input: { endpointId: string; limit: number }) => {
    const endpoint = await endpointIn(tx, workspaceOf(actor), input.endpointId)
    const rows = await tx.select().from(webhook_deliveries).where(eq(webhook_deliveries.endpoint_id, endpoint.id))
      .orderBy(desc(webhook_deliveries.created_at)).limit(input.limit)
    const deliveries: WebhookDeliverySummary[] = rows.map(r => ({
      id: r.id, event: r.event, status: r.status, attempts: r.attempts, response_status: r.response_status, error: r.error,
      created_at: r.created_at, last_attempt_at: r.last_attempt_at,
    }))
    const data: WebhookDeliveriesData = { deliveries }
    return { rows: {}, data }
  },
}
