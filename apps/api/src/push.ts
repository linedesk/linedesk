// Web Push for new calls: a member turns it on per browser in Settings, Notifications; the browser's
// subscription is stored per member and workspace (push_subscriptions). Pushes go out from a pg-boss
// job (jobs.ts) when a call is flagged urgent, a message is taken and a call ends; all three share one
// notification per call, so a later one replaces the earlier on the device.
// The payload is minimal: who called, and only for members who opted in, one line on what about.
// Never a transcript. VAPID keys come from the environment (operator-generated, see .env.example).
import { Agent } from 'node:https'
import { isPushServiceUrl, type PushSettings, pushDeviceId } from '@linedesk/actions'
import { calls, contacts, member, member_notification_settings, push_subscriptions, type Tx, user } from '@linedesk/db'
import type { Call } from '@linedesk/db/types'
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import webpush from 'web-push'
import { formatNumber } from './call-notifications.ts'
import type { Actor } from './context.ts'
import { type Handler, Forbidden, Reject } from './handler-context.ts'
import { createRateLimiter } from './rate-limit.ts'
import { publicLookup } from './webhooks.ts'

type Env = Record<string, string | undefined>

/** What happened: the agent flagged the call urgent, took a message, the call ended, or a teammate assigned it to you. */
export type PushKind = 'urgent' | 'message' | 'finished' | 'assigned'

/** What the service worker gets (public/sw.js). */
export type PushPayload = { callId: string; kind: PushKind; urgent: boolean; title: string; body: string }

export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } }

export interface PushSender {
  /** The VAPID public key browsers subscribe with; null: push is not set up on this install. */
  publicKey: string | null
  /** `gone`: the push service no longer knows the subscription (unsubscribed, expired); delete it. */
  send(target: PushTarget, payload: PushPayload): Promise<'sent' | 'gone'>
}

/** How long a push service keeps a push for an offline device: news about a call goes stale. */
const TTL_SECONDS = 12 * 60 * 60
/** How long one push may take; a slow push service must not hold up the others. */
export const SEND_TIMEOUT_MS = 5000
/** Pushes about one call that are in flight at once. */
export const SEND_CONCURRENCY = 8

/**
 * The connection for pushes: the endpoint's name is resolved once and refused when any address is
 * private (webhooks.ts), on top of the push-service allow-list the endpoint passed when it was stored.
 */
export const pushAgent = (resolve?: Parameters<typeof publicLookup>[0]) =>
  new Agent({ keepAlive: true, lookup: publicLookup(resolve) as never })

/** VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (mailto: or https: of the operator); without both keys push is off. */
export function pushSenderFromEnv(env: Env = process.env): PushSender {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() || null
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() || null
  if (!publicKey || !privateKey) {
    return {
      publicKey: null,
      send: async () => {
        throw new Error('push is not set up: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are missing')
      },
    }
  }
  const vapidDetails = { subject: env.VAPID_SUBJECT?.trim() || 'mailto:admin@localhost', publicKey, privateKey }
  const agent = pushAgent()
  return {
    publicKey,
    async send(target, payload) {
      // Stored endpoints passed the allow-list; checked again so no other address is ever requested.
      if (!isPushServiceUrl(target.endpoint)) return 'gone'
      try {
        await webpush.sendNotification(target, JSON.stringify(payload), {
          vapidDetails,
          agent,
          timeout: SEND_TIMEOUT_MS,
          TTL: TTL_SECONDS,
          urgency: payload.urgent ? 'high' : 'normal',
          // Undelivered pushes about the same call collapse into the newest.
          topic: payload.callId.replace(/[^A-Za-z0-9_-]/g, '').slice(-32),
        })
        return 'sent'
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) return 'gone'
        throw e
      }
    },
  }
}

let defaultSender: PushSender | null = null
/** The install's sender, read from the environment once. */
export const pushSender = () => (defaultSender ??= pushSenderFromEnv())
/** For tests: another sender (null: read the environment again). */
export const setPushSender = (sender: PushSender | null) => {
  defaultSender = sender
}

const MAX_LINE = 120
/** One line, at most MAX_LINE characters. */
const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1).trimEnd()}…` : line
}

/** The notification: who called (name, else number); with `withSummary` one line on what about. */
export function pushPayload(
  call: Pick<Call, 'id' | 'from_number' | 'urgency' | 'outcome' | 'title' | 'summary' | 'action_items'>,
  kind: PushKind,
  callerName: string | null,
  withSummary: boolean,
): PushPayload {
  const who = callerName || formatNumber(call.from_number)
  const urgent = kind === 'urgent' || call.urgency === 'urgent'
  const message = kind === 'message' || call.outcome === 'message'
  const title = urgent ? `Urgent call from ${who}` : message ? `Message from ${who}` : `New call from ${who}`
  const lastMessage = message ? call.action_items.at(-1)?.text : undefined
  const about = call.title || lastMessage || call.summary || ''
  return { callId: call.id, kind, urgent, title, body: withSummary && about ? oneLine(about) : '' }
}

export type PushResult = { sent: number; gone: number; failed: number; skipped?: 'missing' | 'test' | 'spam' | 'off' }

/** Members of the call's workspace (still members, not disabled) with push on, per browser; with `userId` only theirs. */
async function pushRecipients(tx: Tx, workspaceId: string, userId?: string) {
  return tx
    .select({
      endpoint: push_subscriptions.endpoint,
      p256dh: push_subscriptions.p256dh,
      auth: push_subscriptions.auth,
      summary: member_notification_settings.push_summary,
    })
    .from(push_subscriptions)
    .innerJoin(
      member,
      and(eq(member.organizationId, push_subscriptions.workspace_id), eq(member.userId, push_subscriptions.user_id)),
    )
    .innerJoin(user, eq(user.id, push_subscriptions.user_id))
    .leftJoin(
      member_notification_settings,
      and(
        eq(member_notification_settings.workspace_id, push_subscriptions.workspace_id),
        eq(member_notification_settings.user_id, push_subscriptions.user_id),
      ),
    )
    .where(
      and(
        eq(push_subscriptions.workspace_id, workspaceId),
        isNull(user.disabledAt),
        userId ? eq(push_subscriptions.user_id, userId) : undefined,
      ),
    )
}

/** Rejects after `ms`, so one hanging push service cannot hold up the job (the sender has its own timeout too). */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/** Runs `work` for every item, at most `limit` at a time. */
async function inParallel<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  const worker = async () => {
    while (next < items.length) await work(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

type SendOptions = { timeoutMs?: number; concurrency?: number }
type Recipient = Awaited<ReturnType<typeof pushRecipients>>[number]

/**
 * Sends one push per browser, a few at a time, each with a deadline. A failed browser does not stop
 * the others; gone ones are deleted.
 */
async function deliver(
  tx: Tx,
  sender: PushSender,
  call: Call,
  recipients: Recipient[],
  payloadFor: (r: Recipient) => PushPayload,
  { timeoutMs = SEND_TIMEOUT_MS, concurrency = SEND_CONCURRENCY }: SendOptions,
): Promise<PushResult> {
  const result: PushResult = { sent: 0, gone: 0, failed: 0 }
  const gone: string[] = []
  await inParallel(recipients, concurrency, async r => {
    const target = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }
    try {
      if ((await withTimeout(sender.send(target, payloadFor(r)), timeoutMs)) === 'sent') result.sent++
      else gone.push(r.endpoint)
    } catch (e) {
      result.failed++
      console.warn(`push to a member of ${call.workspace_id} failed: ${e instanceof Error ? e.message : e}`)
    }
  })
  result.gone = gone.length
  if (gone.length) await tx.delete(push_subscriptions).where(inArray(push_subscriptions.endpoint, gone))
  return result
}

/** The call a push is about, or why none goes out. */
async function pushableCall(tx: Tx, sender: PushSender, callId: string): Promise<Call | PushResult> {
  const none: PushResult = { sent: 0, gone: 0, failed: 0 }
  if (!sender.publicKey) return { ...none, skipped: 'off' }
  const [call] = await tx.select().from(calls).where(eq(calls.id, callId))
  if (!call || call.deleted_at) return { ...none, skipped: 'missing' }
  if (call.source === 'test') return { ...none, skipped: 'test' }
  if (call.outcome === 'spam') return { ...none, skipped: 'spam' }
  return call
}

const callerNameOf = async (tx: Tx, call: Call) =>
  call.contact_id ? ((await tx.select().from(contacts).where(eq(contacts.id, call.contact_id)))[0]?.name ?? null) : null

/** Sends the pushes about one call to every member with push on. */
export async function notifyCallPush(
  tx: Tx,
  sender: PushSender,
  callId: string,
  kind: PushKind,
  options: SendOptions = {},
): Promise<PushResult> {
  const call = await pushableCall(tx, sender, callId)
  if (!('id' in call)) return call
  const callerName = await callerNameOf(tx, call)
  const recipients = await pushRecipients(tx, call.workspace_id)
  return deliver(tx, sender, call, recipients, r => pushPayload(call, kind, callerName, r.summary === true), options)
}

/** Tells one member on their browsers that `byName` assigned them the call. */
export async function notifyAssignedPush(
  tx: Tx,
  sender: PushSender,
  callId: string,
  userId: string,
  byName: string,
  options: SendOptions = {},
): Promise<PushResult> {
  const call = await pushableCall(tx, sender, callId)
  if (!('id' in call)) return call
  const callerName = await callerNameOf(tx, call)
  const recipients = await pushRecipients(tx, call.workspace_id, userId)
  return deliver(tx, sender, call, recipients, r => assignedPushPayload(call, callerName, byName, r.summary === true), options)
}

/** "Mike assigned you a call", who called, and with `withSummary` what about. */
export function assignedPushPayload(
  call: Pick<Call, 'id' | 'from_number' | 'urgency' | 'title'>,
  callerName: string | null,
  byName: string,
  withSummary: boolean,
): PushPayload {
  const who = callerName || formatNumber(call.from_number)
  const about = withSummary && call.title ? ` · ${call.title}` : ''
  return {
    callId: call.id,
    kind: 'assigned',
    urgent: call.urgency === 'urgent',
    title: `${byName} assigned you a call`,
    body: oneLine(`From ${who}${about}`),
  }
}

/** The caller's push settings in their workspace, for notifications.get. */
export async function pushSettings(
  tx: Tx,
  workspaceId: string,
  userId: string,
  summary: boolean | null,
): Promise<PushSettings> {
  const rows = await tx
    .select({ endpoint: push_subscriptions.endpoint })
    .from(push_subscriptions)
    .where(and(eq(push_subscriptions.workspace_id, workspaceId), eq(push_subscriptions.user_id, userId)))
  return {
    publicKey: pushSender().publicKey,
    devices: await Promise.all(rows.map(r => pushDeviceId(r.endpoint))),
    summary: summary === true,
  }
}

/** Pushes stop for a member who leaves or is removed from a workspace. */
export async function dropWorkspacePush(tx: Tx, workspaceId: string, userId: string) {
  await tx
    .delete(push_subscriptions)
    .where(and(eq(push_subscriptions.workspace_id, workspaceId), eq(push_subscriptions.user_id, userId)))
}

/** Pushes stop in every workspace (a disabled account). */
export async function dropUserPush(tx: Tx, userId: string) {
  await tx.delete(push_subscriptions).where(eq(push_subscriptions.user_id, userId))
}

/** Browsers per member and workspace that get pushes; subscribing another drops the oldest. */
export const MAX_PUSH_DEVICES = 10
/** push.subscribe calls per member per hour. */
const allowSubscribe = createRateLimiter({ max: 20, windowMs: 3_600_000 })

/** A person signed in to a workspace: not the agent and not an API key (push is per browser). */
function pushPerson(actor: Actor): { workspaceId: string; userId: string } {
  if (!actor.workspaceId || actor.role === 'agent') throw new Reject('no workspace')
  if (actor.apiKeyId) throw new Reject('push notifications are set up in the browser, not with an API key')
  return { workspaceId: actor.workspaceId, userId: actor.actorId }
}

/** Also not an instance admin acting as someone else: their browser must not get that person's pushes. */
function pushMember(actor: Actor): { workspaceId: string; userId: string } {
  const person = pushPerson(actor)
  if (actor.impersonation) throw new Forbidden('push notifications cannot be changed while acting as someone else')
  return person
}

/**
 * Rows of other people for this endpoint. The same browser subscription (same keys) means the browser
 * changed hands without signing out: theirs go, so their pushes never reach this person. Different
 * keys are not the same subscription: refused, and nothing of theirs is touched.
 */
async function claimEndpoint(tx: Tx, userId: string, input: PushTarget) {
  const others = await tx
    .select({ p256dh: push_subscriptions.p256dh, auth: push_subscriptions.auth })
    .from(push_subscriptions)
    .where(and(eq(push_subscriptions.endpoint, input.endpoint), ne(push_subscriptions.user_id, userId)))
  if (!others.length) return
  if (others.some(o => o.p256dh !== input.keys.p256dh || o.auth !== input.keys.auth))
    throw new Reject('this browser subscription belongs to someone else')
  await tx
    .delete(push_subscriptions)
    .where(and(eq(push_subscriptions.endpoint, input.endpoint), ne(push_subscriptions.user_id, userId)))
}

/** Keeps the member's newest MAX_PUSH_DEVICES browsers in the workspace. */
async function keepNewestDevices(tx: Tx, workspaceId: string, userId: string) {
  const mine = and(eq(push_subscriptions.workspace_id, workspaceId), eq(push_subscriptions.user_id, userId))
  const rows = await tx
    .select({ endpoint: push_subscriptions.endpoint })
    .from(push_subscriptions)
    .where(mine)
    .orderBy(desc(push_subscriptions.created_at))
  const extra = rows.slice(MAX_PUSH_DEVICES).map(r => r.endpoint)
  if (extra.length) await tx.delete(push_subscriptions).where(and(mine, inArray(push_subscriptions.endpoint, extra)))
}

export const pushHandlers: Record<string, Handler> = {
  'push.subscribe': async ({ tx, actor, now }, input: PushTarget) => {
    const { workspaceId, userId } = pushMember(actor)
    if (!pushSender().publicKey) throw new Reject('push notifications are not set up on this server')
    if (!allowSubscribe(userId)) throw new Reject('too many push subscriptions in the last hour; try again later')
    await claimEndpoint(tx, userId, input)
    const values = { endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth }
    // Subscribing again counts as the newest device. Only ever the caller's own row is updated.
    await tx
      .insert(push_subscriptions)
      .values({ workspace_id: workspaceId, user_id: userId, ...values, created_at: now })
      .onConflictDoUpdate({
        target: [push_subscriptions.workspace_id, push_subscriptions.endpoint],
        set: { ...values, created_at: now },
        setWhere: eq(push_subscriptions.user_id, userId),
      })
    await keepNewestDevices(tx, workspaceId, userId)
    return { rows: {} }
  },

  'push.unsubscribe': async ({ tx, actor }, input: { endpoint: string; everywhere?: boolean }) => {
    const { workspaceId, userId } = pushPerson(actor)
    const mine = and(eq(push_subscriptions.endpoint, input.endpoint), eq(push_subscriptions.user_id, userId))
    await tx
      .delete(push_subscriptions)
      .where(input.everywhere ? mine : and(mine, eq(push_subscriptions.workspace_id, workspaceId)))
    return { rows: {} }
  },
}
