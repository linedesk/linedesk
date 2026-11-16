// An assistant's webhook (docs/webhooks.md): one address, with the hooks it gets switched on.
// `call_start`: as a call comes in, the agent asks (call.lookUpCaller) and the API POSTs the caller to the URL and waits CALL_START_TIMEOUT_MS for caller
// details. `during_call`: the assistant asks one of the webhook's lookups (call.askWebhook) and the API POSTs
// what the caller said and waits DURING_CALL_TIMEOUT_MS for the answer. `call_end`: when the call is finished a delivery row and a pg-boss job are written in that
// transaction; CALL_END_DELAY_SEC later the job builds the whole call into the payload (so the recording
// is in it), POSTs it signed with the endpoint's secret and retries with backoff. An endpoint whose
// requests keep failing is switched off.
import { createHmac } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import {
  callerRecognized,
  CALL_END_DELAY_SEC,
  CALL_START_TIMEOUT_MS,
  type CallAskWebhookData,
  type CallEndPayload,
  type CallLookUpData,
  type CallStartRequest,
  callerDetailsFrom,
  DURING_CALL_MAX_PER_CALL,
  DURING_CALL_TIMEOUT_MS,
  type DuringCallRequest,
  exampleLookupValues,
  hooksOf,
  lookupAnswerFrom,
  lookupValuesFrom,
  type WebhookDeliveriesData,
  type WebhookDeliverySummary,
  type WebhookTestData,
} from '@linedesk/actions'
import { assistants, bookings, calls, contacts, transcript_segments, type Tx, webhook_deliveries, webhook_endpoints, webhook_secrets } from '@linedesk/db'
import type { Assistant, Call, WebhookEndpoint, WebhookHook, WebhookLookup } from '@linedesk/db/types'
import { and, asc, desc, eq, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import { Agent, fetch as undiciFetch } from 'undici'
import { WEB_ORIGIN } from './auth.ts'
import { type Handler, Reject } from './handler-context.ts'
import { checkedLookup, isPrivateAddress, type Resolve, resolveAll } from './ip-address.ts'
import { queueWebhookDelivery } from './jobs.ts'
import { createRateLimiter } from './rate-limit.ts'
import { recordingLink } from './recording-route.ts'
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
export const secretSlot = (endpointId: string) => `webhook.${endpointId}`
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

/**
 * A `lookup` for the connection: resolves the name once and refuses it when any address is private,
 * so the request goes to exactly the address that was checked (no second lookup to rebind).
 */
export function publicLookup(resolve: Resolve = resolveAll) {
  return checkedLookup(isPrivateAddress, PRIVATE, resolve)
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

type Attempt = { ok: boolean; responseStatus: number | null; error: string | null; reply?: unknown }

const causeCode = (e: unknown): string | undefined => {
  const cause = e instanceof Error ? (e.cause as { code?: string } | undefined) : undefined
  return cause?.code
}

/** The largest answer read from a call-start webhook; anything longer is not caller details. */
const MAX_REPLY_BYTES = 32_768

/** The answer's JSON, or undefined when it is not JSON or too long. */
async function readReply(res: Response | Awaited<ReturnType<typeof undiciFetch>>): Promise<unknown> {
  const reader = res.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

type SendOptions = { env?: Env; timeoutMs?: number; readReply?: boolean }

/**
 * POSTs one request. Failures before an answer are reported only as "could not connect" (or "no answer in
 * time", or the private-address refusal), so the log and the test send cannot be used to probe ports; the
 * detail goes to the server log. With `readReply` the answer's JSON comes back as `reply`. Signed unless `secret` is null.
 */
export async function sendWebhook(url: string, secret: string | null, deliveryId: string, hook: string, body: string, options: SendOptions = {}): Promise<Attempt> {
  const { env = process.env, timeoutMs = TIMEOUT_MS } = options
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
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Linedesk-Webhooks/2',
        'linedesk-hook': hook,
        'linedesk-delivery': deliveryId,
        // Integration subscriptions (integrations.ts) have no secret: their URL is the secret.
        ...(secret === null ? {} : { [SIGNATURE_HEADER]: signature(secret, body, Math.floor(Date.now() / 1000)) }),
      },
      body,
    })
    const ok = res.status >= 200 && res.status < 300
    const reply = ok && options.readReply ? await readReply(res) : undefined
    if (reply === undefined) await res.body?.cancel().catch(() => {})
    return { ok, responseStatus: res.status, error: ok ? null : `answered ${res.status}`, ...(options.readReply ? { reply } : {}) }
  } catch (e) {
    if (causeCode(e) === 'EPRIVATEADDRESS') return { ok: false, responseStatus: null, error: PRIVATE }
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'))
      return { ok: false, responseStatus: null, error: `no answer within ${timeoutMs >= 1000 ? `${timeoutMs / 1000} s` : `${timeoutMs} ms`}` }
    console.warn(`webhook request ${deliveryId} could not connect: ${e instanceof Error ? `${e.message} ${causeCode(e) ?? ''}` : e}`)
    return { ok: false, responseStatus: null, error: 'could not connect' }
  }
}

// --- The hooks ----------------------------------------------------------------------------------

/** The assistant's webhook with its secret, when it is on and gets `hook`; else null. */
async function activeHook(tx: Tx, assistantId: string | null, hook: WebhookHook) {
  if (!assistantId) return null
  const [found] = await tx.select({ endpoint: webhook_endpoints, secret: webhook_secrets.secret_encrypted })
    .from(webhook_endpoints)
    .innerJoin(webhook_secrets, eq(webhook_secrets.endpoint_id, webhook_endpoints.id))
    .where(and(eq(webhook_endpoints.assistant_id, assistantId), sql`${webhook_endpoints.hooks} ? ${hook}`, eq(webhook_endpoints.status, 'active')))
  return found ?? null
}

/** `name_confirmed`: the team gave or confirmed the name (name_source "member"); a name only a caller gave proves nothing. */
export const callerOf = (contact: { id: string; name: string | null; name_source: string | null; company: string | null; email: string | null } | undefined) =>
  contact ? { contact_id: contact.id, name: contact.name, name_confirmed: !!contact.name?.trim() && contact.name_source === 'member', company: contact.company, email: contact.email } : null

export async function callerContact(tx: Tx, call: Pick<Call, 'workspace_id' | 'contact_id'>) {
  if (!call.contact_id) return undefined
  const [contact] = await tx.select({ id: contacts.id, name: contacts.name, name_source: contacts.name_source, company: contacts.company, email: contacts.email })
    .from(contacts).where(and(eq(contacts.id, call.contact_id), eq(contacts.workspace_id, call.workspace_id)))
  return contact
}

/** A time as ISO 8601 (Postgres hands them over as "2026-11-12 12:43:35.917+00"). */
export const iso = (at: string) => new Date(at).toISOString()
const isoOrNull = (at: string | null) => (at ? iso(at) : null)

/** What the call-start webhook is sent. */
export function callStartRequest(call: Call, assistant: Pick<Assistant, 'id' | 'name'>, caller: ReturnType<typeof callerOf>): CallStartRequest {
  return {
    hook: 'call_start', call_id: call.id, workspace_id: call.workspace_id, assistant_id: assistant.id, assistant_name: assistant.name,
    from_number: call.from_number, to_number: call.to_number, started_at: iso(call.started_at), caller,
  }
}

type ActiveHook = NonNullable<Awaited<ReturnType<typeof activeHook>>>

/**
 * A request the call waits for (call start, during the call): POSTed once with a short time limit and logged
 * with the usable part of its answer (`read`). A failure counts against the endpoint like a failed delivery,
 * so one that never answers is switched off instead of slowing every call.
 */
async function askLive<T>(tx: Tx, found: ActiveHook, request: { hook: WebhookHook; workspace_id: string }, timeoutMs: number, read: (reply: unknown) => T | null, env: Env): Promise<T | null> {
  const id = newId('whd')
  const secret = decryptSecret(found.secret, secretSlot(found.endpoint.id))
  const result = await sendWebhook(found.endpoint.url, secret, id, request.hook, JSON.stringify(request), { env, timeoutMs, readReply: true })
  const kept = result.ok ? read(result.reply) : null
  const now = new Date().toISOString()
  await tx.insert(webhook_deliveries).values({
    id, workspace_id: request.workspace_id, endpoint_id: found.endpoint.id, event: request.hook, payload: { ...request, reply: kept },
    attempts: 1, status: result.ok ? 'delivered' : 'failed', response_status: result.responseStatus, error: result.error, last_attempt_at: now,
  })
  if (result.ok) await tx.update(webhook_endpoints).set({ failure_count: 0, last_delivery_at: now }).where(eq(webhook_endpoints.id, found.endpoint.id))
  else await countFailure(tx, found.endpoint.id, result.error)
  return kept
}

export const assistantOf = async (tx: Tx, assistantId: string) =>
  (await tx.select({ id: assistants.id, name: assistants.name, behaviours: assistants.behaviours }).from(assistants).where(eq(assistants.id, assistantId)))[0]!

/** Whether the call's caller ID names the caller (callerRecognized): only then is the matched contact sent or looked up. */
export const recognizedOn = (call: Call, assistant: { behaviours: Record<string, boolean> | null }) =>
  callerRecognized(call.source, call.caller_attestation, assistant.behaviours)

/**
 * call.lookUpCaller: asks the assistant's call-start webhook about the caller and keeps what it answered on
 * the call (`caller_details`). Test calls ask nothing.
 */
export async function lookUpCaller(tx: Tx, call: Call, env: Env = process.env): Promise<CallLookUpData> {
  if (call.source !== 'phone') return { details: null }
  const found = await activeHook(tx, call.assistant_id, 'call_start')
  if (!found) return { details: null }
  const assistant = await assistantOf(tx, call.assistant_id!)
  // A caller ID the carrier did not vouch for may be faked: the business's system is not asked about its owner.
  if (!recognizedOn(call, assistant)) return { details: null }
  const request = callStartRequest(call, assistant, callerOf(await callerContact(tx, call)))
  const details = await askLive(tx, found, request, CALL_START_TIMEOUT_MS, callerDetailsFrom, env)
  if (details) await tx.update(calls).set({ caller_details: details }).where(eq(calls.id, call.id))
  return { details }
}

/** The lookups the assistant can ask during a call: none unless its webhook is on and gets `during_call`. Told to the agent by call.start. */
export async function duringCallLookups(tx: Tx, assistantId: string | null | undefined): Promise<WebhookLookup[]> {
  const found = await activeHook(tx, assistantId ?? null, 'during_call')
  return found?.endpoint.lookups ?? []
}

/** What the during-call webhook is sent for one lookup. */
export function duringCallRequest(call: Call, assistant: Pick<Assistant, 'id' | 'name'>, caller: ReturnType<typeof callerOf>, lookup: string, values: DuringCallRequest['values'], callerVerified = true): DuringCallRequest {
  return {
    hook: 'during_call', lookup, values, call_id: call.id, workspace_id: call.workspace_id, assistant_id: assistant.id, assistant_name: assistant.name,
    from_number: call.from_number, to_number: call.to_number, started_at: iso(call.started_at), test: call.source === 'test', caller, caller_verified: callerVerified,
  }
}

/**
 * call.askWebhook: asks the assistant's during-call webhook one of its lookups, with the lookup's own fields
 * the assistant filled in, and hands back the answer. Test calls ask too, so the assistant can be tried out.
 * At most DURING_CALL_MAX_PER_CALL requests per call.
 */
export async function askWebhook(
  tx: Tx, call: Call, input: { lookup: string; values: Record<string, unknown> }, env: Env = process.env,
  onAsked?: (request: DuringCallRequest, answer: string | null) => Promise<void>,
): Promise<CallAskWebhookData> {
  const found = await activeHook(tx, call.assistant_id, 'during_call')
  const lookup = found?.endpoint.lookups.find(l => l.name === input.lookup)
  if (!found || !lookup) return { answer: null, problem: 'unavailable' }
  const filled = lookupValuesFrom(lookup, input.values)
  if ('missing' in filled) return { answer: null, problem: 'missing', missing: filled.missing }
  const [{ asked } = { asked: 0 }] = await tx.select({ asked: sql<number>`count(*)::int` }).from(webhook_deliveries).where(and(
    eq(webhook_deliveries.endpoint_id, found.endpoint.id), eq(webhook_deliveries.event, 'during_call'), sql`${webhook_deliveries.payload} ->> 'call_id' = ${call.id}`,
  ))
  if (asked >= DURING_CALL_MAX_PER_CALL) return { answer: null, problem: 'limit' }
  const assistant = await assistantOf(tx, call.assistant_id!)
  const recognized = recognizedOn(call, assistant)
  const request = duringCallRequest(call, assistant, recognized ? callerOf(await callerContact(tx, call)) : null, lookup.name, filled.values, recognized)
  const answer = await askLive(tx, found, request, DURING_CALL_TIMEOUT_MS, lookupAnswerFrom, env)
  await onAsked?.(request, answer)
  return answer ? { answer, problem: null } : { answer: null, problem: 'failed' }
}

/**
 * Queues the after-call webhook of a finished call, in the transaction that finished it. The payload is
 * built when it is sent (CALL_END_DELAY_SEC later, so the recording is saved); until then the row holds
 * only the call's id. Test calls send nothing.
 */
export async function queueCallEnd(tx: Tx, call: Call) {
  if (call.source !== 'phone') return
  const found = await activeHook(tx, call.assistant_id, 'call_end')
  if (!found) return
  const id = newId('whd')
  await tx.insert(webhook_deliveries).values({
    id, workspace_id: call.workspace_id, endpoint_id: found.endpoint.id, event: 'call_end', payload: { hook: 'call_end', call_id: call.id },
  })
  await queueWebhookDelivery(tx, id, CALL_END_DELAY_SEC)
}

/** Where the API is reached from outside: the recording link points there. */
const apiBase = (env: Env) => env.PUBLIC_URL || WEB_ORIGIN
const SPEAKER: Record<string, string> = { agent: 'Assistant', caller: 'Caller', human: 'Team', system: 'Note' }

/** The whole call, as the after-call webhook gets it; null when the call is gone (deleted). */
export async function callEndPayload(tx: Tx, workspaceId: string, callId: string, env: Env = process.env, now = new Date()): Promise<CallEndPayload | null> {
  const [call] = await tx.select().from(calls).where(and(eq(calls.id, callId), eq(calls.workspace_id, workspaceId), isNull(calls.deleted_at)))
  if (!call) return null
  const [assistant] = call.assistant_id ? await tx.select({ name: assistants.name }).from(assistants).where(eq(assistants.id, call.assistant_id)) : []
  const lines = await tx.select({ speaker: transcript_segments.speaker, text: transcript_segments.text, at_ms: transcript_segments.at_ms })
    .from(transcript_segments).where(eq(transcript_segments.call_id, call.id)).orderBy(asc(transcript_segments.at_ms), asc(transcript_segments.id))
  const booked = await tx.select({
    id: bookings.id, start_at: bookings.start_at, end_at: bookings.end_at, status: bookings.status, title: bookings.title,
    calendar_name: bookings.calendar_name, appointment_type_id: bookings.appointment_type_id,
  }).from(bookings).where(and(eq(bookings.call_id, call.id), eq(bookings.workspace_id, workspaceId))).orderBy(asc(bookings.start_at))
  const recording = call.recording_key ? recordingLink(call.id, apiBase(env), now) : null
  const assistantName = assistant?.name ?? null
  return {
    hook: 'call_end', call_id: call.id, workspace_id: call.workspace_id, assistant_id: call.assistant_id, assistant_name: assistantName,
    direction: call.direction, from_number: call.from_number, to_number: call.to_number,
    started_at: iso(call.started_at), ended_at: isoOrNull(call.ended_at), duration_sec: call.duration_sec,
    outcome: call.outcome, urgency: call.urgency, title: call.title, summary: call.summary,
    next_steps: call.action_items, fields: call.fields,
    caller: callerOf(await callerContact(tx, call)), caller_details: call.caller_details,
    transcript: lines,
    transcript_text: lines.map(l => `${l.speaker === 'agent' && assistantName ? assistantName : SPEAKER[l.speaker] ?? l.speaker}: ${l.text}`).join('\n'),
    bookings: booked.map(b => ({ ...b, start_at: iso(b.start_at), end_at: iso(b.end_at) })),
    transfer: call.transfer_to ? { to: call.transfer_to, name: call.transfer_name, result: call.transfer_result } : null,
    call_url: new URL(`/#call/${call.id}`, WEB_ORIGIN).toString(),
    recording_url: recording?.url ?? null, recording_expires_at: recording?.expires_at ?? null,
  }
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

/** Clears the payloads of a call's requests (call start and after the call) when the call is deleted. */
export async function clearCallPayloads(tx: Tx, workspaceId: string, callId: string) {
  await tx.update(webhook_deliveries).set({ payload: null }).where(and(
    eq(webhook_deliveries.workspace_id, workspaceId),
    isNotNull(webhook_deliveries.payload),
    sql`${webhook_deliveries.payload} ->> 'call_id' = ${callId}`,
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
  // The after-call payload is built at the first attempt; retries send the same one.
  const callId = delivery.payload?.call_id
  const payload = delivery.event === 'call_end' && delivery.attempts === 0 && typeof callId === 'string'
    ? await callEndPayload(tx, delivery.workspace_id, callId, env)
    : delivery.payload
  if (!payload) {
    await tx.update(webhook_deliveries).set({ status: 'failed', error: 'the call was deleted', payload: null }).where(eq(webhook_deliveries.id, delivery.id))
    return 'skipped'
  }
  if (payload !== delivery.payload) await tx.update(webhook_deliveries).set({ payload }).where(eq(webhook_deliveries.id, delivery.id))
  const secret = decryptSecret(found.secret, secretSlot(endpoint.id))
  const result = await sendWebhook(endpoint.url, secret, delivery.id, delivery.event, JSON.stringify(payload), { env })
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

/** An endpoint of the actor's workspace; endpoints from before webhooks were per assistant are not found. */
async function endpointIn(tx: Tx, workspaceId: string, endpointId: string) {
  const [endpoint] = await tx.select().from(webhook_endpoints)
    .where(and(eq(webhook_endpoints.id, endpointId), eq(webhook_endpoints.workspace_id, workspaceId), isNotNull(webhook_endpoints.assistant_id)))
  if (!endpoint) throw new Reject('webhook not found')
  return endpoint
}

/** An example of what a hook sends, for Send test: a made-up call to the assistant (during it, asking `lookup`). */
function testRequest(endpoint: WebhookEndpoint, hook: WebhookHook, assistant: { id: string; name: string }, now: string, lookup: WebhookLookup | null): CallStartRequest | DuringCallRequest | CallEndPayload {
  const call = {
    call_id: 'call_test', workspace_id: endpoint.workspace_id, assistant_id: assistant.id, assistant_name: assistant.name,
    from_number: '+15035550123', to_number: '+15035550100', started_at: now,
    caller: { contact_id: 'ct_test', name: 'Sam Taylor', name_confirmed: true, company: null, email: 'sam@example.com' },
  }
  if (hook === 'call_start') return { hook: 'call_start', ...call }
  if (hook === 'during_call' && lookup) return { hook: 'during_call', lookup: lookup.name, values: exampleLookupValues(lookup), ...call, test: true, caller_verified: true }
  const lines = [
    { speaker: 'agent' as const, text: `Thanks for calling, this is ${assistant.name}. How can I help?`, at_ms: 0 },
    { speaker: 'caller' as const, text: 'Hi, this is Sam. My water heater is leaking, can someone come by tomorrow?', at_ms: 4200 },
  ]
  return {
    hook: 'call_end', ...call, direction: 'in', ended_at: now, duration_sec: 95, outcome: 'message', urgency: 'normal',
    title: 'Water heater leaking', summary: 'Sam Taylor reports a leaking water heater and asks for a visit tomorrow.',
    next_steps: [{ text: 'Call Sam back to schedule a visit tomorrow', kind: 'message' }],
    fields: [{ label: 'Issue', value: 'Leaking water heater' }], caller_details: { name: 'Sam', plan: 'Premium' },
    transcript: lines, transcript_text: lines.map(l => `${l.speaker === 'agent' ? assistant.name : 'Caller'}: ${l.text}`).join('\n'),
    bookings: [], transfer: null, call_url: new URL('/#call/call_test', WEB_ORIGIN).toString(), recording_url: null, recording_expires_at: null,
  }
}

export const webhookHandlers: Record<string, Handler> = {
  'webhook.create': async ({ tx, actor }, input: { endpointId: string; assistantId: string; url: string; hooks: WebhookHook[]; secret: string }) => {
    const workspace_id = workspaceOf(actor)
    if (!hasSecretsKey()) throw new Reject('Webhooks need SECRETS_KEY on the server to store their secret.')
    const [assistant] = await tx.select({ id: assistants.id }).from(assistants)
      .where(and(eq(assistants.id, input.assistantId), eq(assistants.workspace_id, workspace_id)))
    if (!assistant) throw new Reject('assistant not found')
    await checkUrl(input.url)
    const [taken] = await tx.select({ id: webhook_endpoints.id }).from(webhook_endpoints).where(eq(webhook_endpoints.id, input.endpointId))
    if (taken) throw new Reject('that endpoint id is taken')
    // Two creates at once would both find no webhook (or both count 9) and both insert: one workspace's creates take turns.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`webhook_endpoints:${workspace_id}`}))`)
    const [existing] = await tx.select({ id: webhook_endpoints.id }).from(webhook_endpoints)
      .where(eq(webhook_endpoints.assistant_id, assistant.id))
    if (existing) throw new Reject('This assistant has a webhook already. Change or delete it instead.')
    const [{ endpoints } = { endpoints: 0 }] = await tx.select({ endpoints: sql<number>`count(*)::int` }).from(webhook_endpoints).where(eq(webhook_endpoints.workspace_id, workspace_id))
    if (endpoints >= WEBHOOK_ENDPOINTS_PER_WORKSPACE)
      throw new Reject(`At most ${WEBHOOK_ENDPOINTS_PER_WORKSPACE} webhooks per workspace. Delete one you no longer use.`)
    const [endpoint] = await tx.insert(webhook_endpoints).values({
      id: input.endpointId, workspace_id, assistant_id: assistant.id, hooks: hooksOf(input.hooks), url: input.url, events: [], created_by: actor.actorId,
    }).returning()
    await tx.insert(webhook_secrets).values({ endpoint_id: endpoint!.id, workspace_id, secret_encrypted: encryptSecret(input.secret, secretSlot(endpoint!.id)) })
    return { rows: { webhook_endpoints: [endpoint!] }, data: { endpointId: endpoint!.id } }
  },

  'webhook.update': async ({ tx, actor }, input: { endpointId: string; url?: string; hooks?: WebhookHook[]; lookups?: WebhookLookup[]; enabled?: boolean }) => {
    const endpoint = await endpointIn(tx, workspaceOf(actor), input.endpointId)
    if (input.url !== undefined) await checkUrl(input.url)
    const switched = input.enabled === undefined ? {} : input.enabled
      ? { status: 'active' as const, disabled_reason: null, failure_count: 0 }
      : { status: 'disabled' as const, disabled_reason: null }
    const rows = await tx.update(webhook_endpoints).set({
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.hooks === undefined ? {} : { hooks: hooksOf(input.hooks) }),
      ...(input.lookups === undefined ? {} : { lookups: input.lookups }),
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
  'webhook.test': async ({ tx, actor, now }, input: { endpointId: string; hook: WebhookHook; lookup?: string }) => {
    const workspaceId = workspaceOf(actor)
    const endpoint = await endpointIn(tx, workspaceId, input.endpointId)
    const lookup = input.hook === 'during_call' ? (endpoint.lookups.find(l => l.name === input.lookup) ?? (input.lookup ? null : endpoint.lookups[0] ?? null)) : null
    if (input.hook === 'during_call' && !lookup) throw new Reject(input.lookup ? `this webhook has no lookup ${input.lookup}` : 'Add a lookup first: the test asks one of them.')
    if (!allowTestSend(workspaceId)) throw new Reject(`At most ${WEBHOOK_TESTS_PER_MINUTE} test requests a minute. Try again shortly.`)
    const [stored] = await tx.select().from(webhook_secrets).where(eq(webhook_secrets.endpoint_id, endpoint.id))
    if (!stored) throw new Reject('this webhook has no secret; add it again')
    const id = newId('whd')
    const payload = testRequest(endpoint, input.hook, await assistantOf(tx, endpoint.assistant_id!), now, lookup)
    // The hooks the call waits for are tested with their own time limit and their answer read, as on a call.
    const timeoutMs = input.hook === 'call_start' ? CALL_START_TIMEOUT_MS : input.hook === 'during_call' ? DURING_CALL_TIMEOUT_MS : undefined
    const result = await sendWebhook(endpoint.url, decryptSecret(stored.secret_encrypted, secretSlot(endpoint.id)), id, 'webhook.test', JSON.stringify(payload), timeoutMs ? { timeoutMs, readReply: true } : {})
    const reply = result.ok ? result.reply : undefined
    const details = input.hook === 'call_start' ? callerDetailsFrom(reply) : undefined
    const answer = input.hook === 'during_call' ? lookupAnswerFrom(reply) : undefined
    await tx.insert(webhook_deliveries).values({
      id, workspace_id: endpoint.workspace_id, endpoint_id: endpoint.id, event: 'webhook.test', payload: timeoutMs ? { ...payload, reply: details ?? answer ?? null } : payload, attempts: 1,
      status: result.ok ? 'delivered' : 'failed', response_status: result.responseStatus, error: result.error, last_attempt_at: new Date().toISOString(),
    })
    const data: WebhookTestData = {
      deliveryId: id, ok: result.ok, responseStatus: result.responseStatus, error: result.error,
      ...(details === undefined ? {} : { details }), ...(answer === undefined ? {} : { answer }),
    }
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
