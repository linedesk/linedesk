// Integration subscriptions (docs/api.md, Integrations): Zapier's REST hooks, made with a workspace API key.
// `integration.subscribe` stores a URL on the integration's own host (INTEGRATION_HOSTS) for an event. A delivery row
// per subscription is written in the transaction of what happened, and the webhooks' job sends it (same table, queue,
// retries and payload clearing as the after-call webhook, webhooks.ts):
//   call_started        a phone call is answered (openCall): CALL_STARTED_DELAY_SEC later, so the call-start
//                       webhook's caller details are in
//   during_call_lookup  the assistant asked its during-call webhook a lookup (call.askWebhook): at once
//   call_finished       a phone call is finished (call.finish): CALL_END_DELAY_SEC later, with the recording A subscription sends only while its key works (not revoked, its creator still a member with
// at least the key's role, the workspace not disabled); revoking the key deletes it, a 410 answer deletes it (Zapier's
// "unsubscribed"), and WEBHOOK_DISABLE_AFTER failed deliveries in a row switch it off.
import {
  CALL_END_DELAY_SEC,
  INTEGRATION_SAMPLE_CALLS_MAX,
  INTEGRATION_SUBSCRIPTIONS_PER_WORKSPACE,
  type DuringCallRequest,
  type IntegrationCall,
  type IntegrationCallStarted,
  type IntegrationEvent,
  type IntegrationLookup,
  type IntegrationPayload,
  type IntegrationListData,
  type IntegrationSource,
  type IntegrationSubscribed,
  type IntegrationUnsubscribed,
  ZAPIER_APP_SETTING,
  type ZapierAppData,
  integrationCall,
  integrationLookup,
  integrationUrlProblem,
} from '@linedesk/actions'
import {
  api_keys,
  calls,
  instance_settings,
  integration_subscriptions,
  member,
  organization,
  type Tx,
  user,
  webhook_deliveries,
} from '@linedesk/db'
import type { Call } from '@linedesk/db/types'
import { and, desc, eq, isNotNull, isNull, ne, or, type SQL, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { type Handler, Reject } from './handler-context.ts'
import { queueWebhookDelivery } from './jobs.ts'
import {
  assistantOf,
  attemptDelivery,
  callEndPayload,
  callerContact,
  callerOf,
  iso,
  recognizedOn,
  type DeliveryOutcome,
  sendWebhook,
  urlProblemSaid,
  WEBHOOK_ATTEMPTS,
  WEBHOOK_DISABLE_AFTER,
} from './webhooks.ts'

type Env = Record<string, string | undefined>

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const short = (text: string) => (text.length > 300 ? `${text.slice(0, 297)}...` : text)

/** WEBHOOK_ALLOW_PRIVATE_URLS=true (development, closed networks): any host, as for webhooks; never link-local (urlProblem). */
const allowAnyHost = (env: Env) => env.WEBHOOK_ALLOW_PRIVATE_URLS === 'true'

/**
 * The subscription's key still works, as actorForApiKey checks it on every request (api-keys.ts): not revoked, the
 * workspace not disabled, its creator still a member, not disabled, with at least the key's role.
 */
const keyStillWorks = and(
  isNull(api_keys.revoked_at),
  isNull(organization.disabledAt),
  isNull(user.disabledAt),
  sql`(${api_keys.role} = 'member' and ${member.role} in ('member', 'admin', 'owner') or ${api_keys.role} = 'admin' and ${member.role} in ('admin', 'owner'))`,
)

/** Subscriptions matching `where` whose key still works (keyStillWorks). */
function workingSubscriptions(tx: Tx, where: SQL | undefined) {
  return tx
    .select({ subscription: integration_subscriptions })
    .from(integration_subscriptions)
    .innerJoin(api_keys, eq(api_keys.id, integration_subscriptions.api_key_id))
    .innerJoin(organization, eq(organization.id, integration_subscriptions.workspace_id))
    .innerJoin(member, and(eq(member.organizationId, api_keys.workspace_id), eq(member.userId, api_keys.created_by)))
    .innerJoin(user, eq(user.id, api_keys.created_by))
    .where(and(where, keyStillWorks))
}

/** Only phone calls go out: test calls and spam send nothing, as with the after-call webhook. */
export const sendsCall = (call: Pick<Call, 'source' | 'outcome' | 'spam_likely'>) =>
  call.source === 'phone' && call.outcome !== 'spam' && !call.spam_likely

/** Seconds after a call is answered that `call_started` goes out: the call-start webhook (1 s) has answered by then. */
export const CALL_STARTED_DELAY_SEC = 3

/**
 * Writes `payload` as a delivery for every working subscription of the workspace to `event`, in the transaction of
 * what happened, and queues it `afterSec` later. A payload with only `call_id` is built when it is sent.
 */
async function queueEvent(
  tx: Tx,
  workspaceId: string,
  event: IntegrationEvent,
  payload: (id: string) => Record<string, unknown>,
  afterSec: number,
) {
  const found = await workingSubscriptions(
    tx,
    and(
      eq(integration_subscriptions.workspace_id, workspaceId),
      eq(integration_subscriptions.event, event),
      eq(integration_subscriptions.status, 'active'),
    ),
  )
  for (const { subscription } of found) {
    const id = newId('whd')
    await tx.insert(webhook_deliveries).values({
      id,
      workspace_id: workspaceId,
      endpoint_id: null,
      subscription_id: subscription.id,
      event,
      payload: payload(id),
    })
    await queueWebhookDelivery(tx, id, afterSec)
  }
}

/**
 * Queues `call_finished` for every working subscription of the call's workspace, in the transaction that finished
 * the call (call.finish). The payload is built when it is sent, like the after-call webhook's.
 */
export async function queueIntegrationDeliveries(tx: Tx, call: Call, afterSec = CALL_END_DELAY_SEC) {
  if (!sendsCall(call)) return
  await queueEvent(
    tx,
    call.workspace_id,
    'call_finished',
    () => ({ event: 'call_finished', call_id: call.id }),
    afterSec,
  )
}

/** Queues `call_started` in the transaction that opened an answered phone call (openCall). Built when it is sent. */
export async function queueCallStarted(tx: Tx, call: Call) {
  if (!sendsCall(call)) return
  await queueEvent(
    tx,
    call.workspace_id,
    'call_started',
    () => ({ event: 'call_started', call_id: call.id }),
    CALL_STARTED_DELAY_SEC,
  )
}

/**
 * Queues `during_call_lookup` after the assistant asked its during-call webhook (call.askWebhook): the request and
 * the answer, complete. Each subscription's copy has its own id (the delivery's), so Zapier never drops one as seen.
 */
export async function queueLookup(tx: Tx, call: Call, request: DuringCallRequest, answer: string | null) {
  if (!sendsCall(call)) return
  const at = new Date().toISOString()
  await queueEvent(tx, call.workspace_id, 'during_call_lookup', id => integrationLookup(id, request, answer, at), 0)
}

/** A phone call as `call_started` sends it; null when it is gone. */
export async function integrationCallStartedOf(
  tx: Tx,
  workspaceId: string,
  callId: string,
): Promise<IntegrationCallStarted | null> {
  const [call] = await tx
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspace_id, workspaceId), isNull(calls.deleted_at)))
  if (!call) return null
  const assistant = call.assistant_id ? await assistantOf(tx, call.assistant_id) : undefined
  // A caller ID the carrier did not vouch for may be faked: no contact then, as with the call-start webhook.
  const recognized = assistant ? recognizedOn(call, assistant) : false
  const caller = recognized ? callerOf(await callerContact(tx, call)) : null
  return {
    id: call.id,
    event: 'call_started',
    call_id: call.id,
    workspace_id: call.workspace_id,
    assistant_id: assistant?.id ?? null,
    assistant_name: assistant?.name ?? null,
    from_number: call.from_number,
    to_number: call.to_number,
    started_at: iso(call.started_at),
    caller,
    caller_name: caller?.name ?? null,
    caller_company: caller?.company ?? null,
    caller_email: caller?.email ?? null,
    caller_contact_id: caller?.contact_id ?? null,
    caller_verified: recognized,
    caller_details: (call.caller_details as IntegrationCallStarted['caller_details']) ?? null,
  }
}

/** The payload of a delivery whose row holds only the call's id: built at its first attempt. */
async function builtPayload(
  tx: Tx,
  event: string,
  workspaceId: string,
  callId: string,
  env: Env,
): Promise<IntegrationPayload | null> {
  if (event === 'call_started') return integrationCallStartedOf(tx, workspaceId, callId)
  return integrationCallOf(tx, workspaceId, callId, env)
}

/** The call as an integration gets it; null when it is gone. */
export async function integrationCallOf(
  tx: Tx,
  workspaceId: string,
  callId: string,
  env: Env = process.env,
): Promise<IntegrationCall | null> {
  const payload = await callEndPayload(tx, workspaceId, callId, env)
  return payload ? integrationCall(payload) : null
}

/**
 * One attempt of a delivery (the `webhook.deliver` job, jobs.ts): an assistant's webhook's goes to attemptDelivery.
 * A subscription's is like it: the payload
 * is built at the first attempt, retried with backoff, failed after WEBHOOK_ATTEMPTS. A 410 answer means the Zap
 * was turned off or deleted: the subscription is deleted (with its deliveries). Not signed: Zapier cannot check a
 * signature, and its hook URL is the secret.
 */
export async function attemptAnyDelivery(tx: Tx, deliveryId: string, env: Env = process.env): Promise<DeliveryOutcome> {
  const [delivery] = await tx.select().from(webhook_deliveries).where(eq(webhook_deliveries.id, deliveryId))
  if (delivery?.status !== 'pending') return 'skipped'
  // An assistant's webhook: its own path.
  if (!delivery.subscription_id) return attemptDelivery(tx, deliveryId, env)
  const fail = (error: string, extra: { payload?: null } = {}) =>
    tx
      .update(webhook_deliveries)
      .set({ status: 'failed', error, ...extra })
      .where(eq(webhook_deliveries.id, delivery.id))
  const [found] = await workingSubscriptions(tx, eq(integration_subscriptions.id, delivery.subscription_id))
  if (!found) {
    await fail('the API key of this subscription no longer works')
    return 'skipped'
  }
  const { subscription } = found
  if (subscription.status !== 'active') {
    await fail('the subscription is switched off')
    return 'skipped'
  }
  const callId = delivery.payload?.call_id
  // call_started and call_finished are queued as the call's id only; a lookup is queued complete.
  const stub = delivery.attempts === 0 && typeof callId === 'string' && delivery.event !== 'during_call_lookup'
  const payload = stub ? await builtPayload(tx, delivery.event, delivery.workspace_id, callId, env) : delivery.payload
  if (!payload) {
    await fail('the call was deleted', { payload: null })
    return 'skipped'
  }
  if (payload !== delivery.payload)
    await tx.update(webhook_deliveries).set({ payload }).where(eq(webhook_deliveries.id, delivery.id))
  const result = await sendWebhook(
    subscription.target_url,
    null,
    delivery.id,
    delivery.event,
    JSON.stringify(payload),
    { env },
  )
  const now = new Date().toISOString()
  if (result.responseStatus === 410) {
    await tx.delete(integration_subscriptions).where(eq(integration_subscriptions.id, subscription.id))
    return 'failed'
  }
  const attempts = delivery.attempts + 1
  const final = result.ok || attempts >= WEBHOOK_ATTEMPTS
  await tx
    .update(webhook_deliveries)
    .set({
      attempts,
      response_status: result.responseStatus,
      error: result.error,
      last_attempt_at: now,
      status: result.ok ? 'delivered' : final ? 'failed' : 'pending',
    })
    .where(eq(webhook_deliveries.id, delivery.id))
  if (result.ok) {
    await tx
      .update(integration_subscriptions)
      .set({ failure_count: 0, last_delivery_at: now })
      .where(eq(integration_subscriptions.id, subscription.id))
    return 'delivered'
  }
  if (!final) return 'retry'
  const [updated] = await tx
    .update(integration_subscriptions)
    .set({ failure_count: sql`${integration_subscriptions.failure_count} + 1` })
    .where(eq(integration_subscriptions.id, subscription.id))
    .returning({ failures: integration_subscriptions.failure_count })
  if (updated && updated.failures >= WEBHOOK_DISABLE_AFTER) {
    const reason = `Switched off after ${updated.failures} failed deliveries in a row (last: ${result.error ?? 'unknown error'}).`
    await tx
      .update(integration_subscriptions)
      .set({ status: 'disabled', disabled_reason: short(reason) })
      .where(eq(integration_subscriptions.id, subscription.id))
  }
  return 'failed'
}

/**
 * The newest finished phone calls (no test calls, no spam), newest first, as an integration gets them, but without a
 * recording link: a sample only shows the fields, and any member key could otherwise mint 24-hour links to recordings.
 */
export async function sampleCalls(
  tx: Tx,
  workspaceId: string,
  limit: number,
  env: Env = process.env,
): Promise<IntegrationCall[]> {
  const rows = await tx
    .select({ id: calls.id })
    .from(calls)
    .where(
      and(
        eq(calls.workspace_id, workspaceId),
        isNull(calls.deleted_at),
        eq(calls.source, 'phone'),
        eq(calls.status, 'completed'),
        or(isNull(calls.outcome), ne(calls.outcome, 'spam')),
      ),
    )
    .orderBy(desc(calls.started_at))
    .limit(Math.min(Math.max(1, limit), INTEGRATION_SAMPLE_CALLS_MAX))
  const out: IntegrationCall[] = []
  for (const row of rows) {
    const call = await integrationCallOf(tx, workspaceId, row.id, env)
    if (call) out.push({ ...call, recording_url: null, recording_expires_at: null })
  }
  return out
}

/** The newest answered phone calls as `call_started` sends them, newest first (samples for a Zap). */
async function sampleStartedCalls(tx: Tx, workspaceId: string, limit: number): Promise<IntegrationCallStarted[]> {
  const rows = await tx
    .select({ id: calls.id })
    .from(calls)
    .where(
      and(
        eq(calls.workspace_id, workspaceId),
        isNull(calls.deleted_at),
        eq(calls.source, 'phone'),
        eq(calls.spam_likely, false),
        or(isNull(calls.outcome), ne(calls.outcome, 'spam')),
      ),
    )
    .orderBy(desc(calls.started_at))
    .limit(limit)
  const out: IntegrationCallStarted[] = []
  for (const row of rows) {
    const call = await integrationCallStartedOf(tx, workspaceId, row.id)
    if (call) out.push(call)
  }
  return out
}

/** The newest lookups the assistants asked their during-call webhooks, as `during_call_lookup` sends them. */
async function sampleLookups(tx: Tx, workspaceId: string, limit: number): Promise<IntegrationLookup[]> {
  const rows = await tx
    .select({
      id: webhook_deliveries.id,
      payload: webhook_deliveries.payload,
      created_at: webhook_deliveries.created_at,
    })
    .from(webhook_deliveries)
    .where(
      and(
        eq(webhook_deliveries.workspace_id, workspaceId),
        eq(webhook_deliveries.event, 'during_call'),
        isNotNull(webhook_deliveries.payload),
        sql`(${webhook_deliveries.payload}->>'test') is distinct from 'true'`,
      ),
    )
    .orderBy(desc(webhook_deliveries.created_at))
    .limit(limit)
  return rows.flatMap(row => {
    const { reply, ...request } = row.payload as DuringCallRequest & { reply?: unknown }
    if (request.hook !== 'during_call') return []
    return [integrationLookup(row.id, request, typeof reply === 'string' ? reply : null, iso(row.created_at))]
  })
}

/** Samples of an event, newest first, as a subscription gets them: what Zapier shows when a Zap is set up. */
export async function sampleEvents(
  tx: Tx,
  workspaceId: string,
  event: IntegrationEvent,
  limit: number,
  env: Env = process.env,
): Promise<IntegrationPayload[]> {
  const n = Math.min(Math.max(1, limit), INTEGRATION_SAMPLE_CALLS_MAX)
  if (event === 'call_started') return sampleStartedCalls(tx, workspaceId, n)
  if (event === 'during_call_lookup') return sampleLookups(tx, workspaceId, n)
  return sampleCalls(tx, workspaceId, n, env)
}

/** Subscriptions are an API key's: a person signed in uses Integrations › Zapier to remove them. */
function keyOf(actor: Actor) {
  if (!actor.apiKeyId || !actor.workspaceId)
    throw Reject.t('server.api.integration.keyOnly')
  return { apiKeyId: actor.apiKeyId, workspaceId: actor.workspaceId }
}

/** Deletes the subscriptions a key made: in the transaction that revokes it. */
export async function dropKeySubscriptions(tx: Tx, apiKeyId: string) {
  await tx.delete(integration_subscriptions).where(eq(integration_subscriptions.api_key_id, apiKeyId))
}

/** The link to the Linedesk app on Zapier this install shows (Server admin › Settings › Integrations); null when it has none. */
export async function zapierAppUrl(tx: Tx): Promise<string | null> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, ZAPIER_APP_SETTING))
  return row?.value || null
}

export const integrationHandlers: Record<string, Handler> = {
  'integration.subscribe': async (
    { tx, actor },
    input: { source: IntegrationSource; event: IntegrationEvent; targetUrl: string },
  ) => {
    const { apiKeyId, workspaceId } = keyOf(actor)
    const problem =
      integrationUrlProblem(input.source, input.targetUrl, allowAnyHost(process.env)) ??
      (await urlProblemSaid(input.targetUrl))
    if (problem) throw new Reject(problem)
    // Two subscribes at once would both count 24 and both insert: one workspace's subscribes take turns.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`integration_subscriptions:${workspaceId}`}))`)
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(integration_subscriptions)
      .where(eq(integration_subscriptions.workspace_id, workspaceId))
    if (count >= INTEGRATION_SUBSCRIPTIONS_PER_WORKSPACE)
      throw Reject.t('server.api.integration.tooMany', { count: INTEGRATION_SUBSCRIPTIONS_PER_WORKSPACE })
    const id = newId('isub')
    await tx.insert(integration_subscriptions).values({
      id,
      workspace_id: workspaceId,
      api_key_id: apiKeyId,
      source: input.source,
      event: input.event,
      target_url: input.targetUrl,
    })
    const data: IntegrationSubscribed = { subscriptionId: id }
    return { rows: {}, data }
  },

  'integration.unsubscribe': async ({ tx, actor }, input: { subscriptionId: string }) => {
    // Only the key's own: another key of the workspace cannot end a Zap it did not make.
    const { apiKeyId, workspaceId } = keyOf(actor)
    const removed = await tx
      .delete(integration_subscriptions)
      .where(
        and(
          eq(integration_subscriptions.id, input.subscriptionId),
          eq(integration_subscriptions.workspace_id, workspaceId),
          eq(integration_subscriptions.api_key_id, apiKeyId),
        ),
      )
      .returning({ id: integration_subscriptions.id })
    const data: IntegrationUnsubscribed = { subscriptionId: input.subscriptionId, removed: removed.length > 0 }
    return { rows: {}, data }
  },

  'integration.list': async ({ tx, actor }) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const rows = await tx
      .select({ subscription: integration_subscriptions, keyName: api_keys.name, keyPrefix: api_keys.prefix })
      .from(integration_subscriptions)
      .innerJoin(api_keys, eq(api_keys.id, integration_subscriptions.api_key_id))
      .where(and(eq(integration_subscriptions.workspace_id, actor.workspaceId), isNull(api_keys.revoked_at)))
      .orderBy(desc(integration_subscriptions.created_at))
    const data: IntegrationListData = {
      subscriptions: rows.map(({ subscription: s, keyName, keyPrefix }) => ({
        id: s.id,
        source: s.source,
        event: s.event,
        status: s.status,
        disabled_reason: s.disabled_reason,
        created_at: s.created_at,
        last_delivery_at: s.last_delivery_at,
        api_key_id: s.api_key_id,
        api_key_name: keyName,
        api_key_prefix: keyPrefix,
      })),
      appUrl: await zapierAppUrl(tx),
    }
    return { rows: {}, data }
  },

  'integration.remove': async ({ tx, actor }, input: { subscriptionId: string }) => {
    if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
    const [removed] = await tx
      .delete(integration_subscriptions)
      .where(
        and(
          eq(integration_subscriptions.id, input.subscriptionId),
          eq(integration_subscriptions.workspace_id, actor.workspaceId),
        ),
      )
      .returning({ id: integration_subscriptions.id })
    if (!removed) throw Reject.t('server.api.integration.notFound')
    return { rows: {}, data: { subscriptionId: removed.id } }
  },

  'zapierApp.get': async ({ tx }) => ({ rows: {}, data: { url: await zapierAppUrl(tx) } satisfies ZapierAppData }),

  'zapierApp.set': async ({ tx, actor, now }, input: { url: string | null }) => {
    if (input.url === null) await tx.delete(instance_settings).where(eq(instance_settings.key, ZAPIER_APP_SETTING))
    else
      await tx
        .insert(instance_settings)
        .values({ key: ZAPIER_APP_SETTING, value: input.url, updated_at: now, updated_by: actor.actorId })
        .onConflictDoUpdate({
          target: instance_settings.key,
          set: { value: input.url, updated_at: now, updated_by: actor.actorId },
        })
    return { rows: {}, data: { url: input.url } satisfies ZapierAppData }
  },
}
