// Finished phone calls into connected apps (docs/crm-sync.md, phase 1): queued in the transaction that finished the
// call (call.finish, the stale-call sweep), next to the Zapier `call_finished`; sent by the job app.push, which finds
// or creates the caller's record, fills its empty fields and logs the call on it. No transaction stays open while
// the app is asked: a push is claimed, sent, and each step saved in short transactions (attemptAppPush). Retried
// with backoff; a push that keeps failing counts against its connection, which then asks for attention on the
// app's page. Failures are stored as codes (AppErrorCode); the app's own words go to the server log only. The
// connection's switches (APP_SETTINGS) are read when the call is queued and again when it is sent: a call that they
// say not to send is `skipped` with its reason, never counted as a failure. Slack (not a CRM) gets one message per
// call in the channel picked when connecting; "only urgent calls" is checked when it is sent, after the summary.
import type { AppPushesData } from '@linedesk/actions'
import { appSettingOn, CALL_END_DELAY_SEC } from '@linedesk/actions'
import {
  AppError,
  type AppId,
  type FinishedCall,
  isE164,
  type PushResult,
  PushSkipped,
  retryable,
} from '@linedesk/connectors'
import {
  type AppConnection,
  type AppErrorCode,
  app_connections,
  app_pushes,
  type Call,
  calls,
  contacts,
  crm_links,
  type Tx,
} from '@linedesk/db'
import { and, desc, eq, gt, inArray, lt, ne, or, sql } from 'drizzle-orm'
import { type AppServices, appAccess, appServicesOf, errorMessage, lockConnection } from './app-connections.ts'
import { WEB_ORIGIN } from './auth.ts'
import { db } from './db.ts'
import { appPushText } from './emails/app-push-text.ts'
import type { Handler } from './handler-context.ts'
import { Reject } from './handler-context.ts'
import { sendsCall } from './integrations.ts'
import { queueAppPush } from './jobs.ts'
import { callerContact, iso } from './webhooks.ts'
import { workspaceLocale } from './workspace-locale.ts'

/** Tries per push (the first and the retries); with pg-boss's backoff from 60 s that spans about four hours. */
export const APP_PUSH_ATTEMPTS = 8
/** Pushes failed in a row after which a connection asks for attention, though its grant may still work. */
export const NEEDS_ATTENTION_AFTER = 3
/**
 * A claim older than this died with its worker (a deploy, a crash, a lost database connection): the push may be
 * claimed again. Every request to the app has a timeout, so a live try takes two or three minutes at most.
 */
export const SENDING_TIMEOUT_MS = 10 * 60_000
/** A push still open this long after it was queued, past all its retries, is queued again by the sweep. */
export const REQUEUE_AFTER_MS = 5 * 3600_000
/** A push still open this long is given up by the sweep: nothing hangs forever. */
export const GIVE_UP_AFTER_MS = 24 * 3600_000

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const nowIso = () => new Date().toISOString()

/**
 * With the call's finished news (call-news.ts): one push per connected app of the workspace that logs calls
 * (log_calls). Phone calls only. `afterSec`: after the summary has had its time, like the webhooks; 0 when the news
 * waited for the transcript.
 */
export async function queueAppPushes(tx: Tx, call: Call, afterSec = CALL_END_DELAY_SEC) {
  if (!sendsCall(call)) return
  const connected = await tx
    .select({ id: app_connections.id, settings: app_connections.settings })
    .from(app_connections)
    .where(eq(app_connections.workspace_id, call.workspace_id))
  for (const connection of connected) {
    if (!appSettingOn(connection.settings, 'log_calls')) continue
    const [push] = await tx
      .insert(app_pushes)
      .values({ id: newId('apush'), workspace_id: call.workspace_id, connection_id: connection.id, call_id: call.id })
      .onConflictDoNothing()
      .returning({ id: app_pushes.id })
    if (push) await queueAppPush(tx, push.id, afterSec)
  }
}

/** The finished call as the app gets it, and the Linedesk contact of the caller; null when the call is gone. */
async function finishedCall(
  tx: Tx,
  connection: AppConnection,
  push: AppPushRow,
): Promise<{ call: FinishedCall; contactId: string | null } | null> {
  const [call] = await tx
    .select()
    .from(calls)
    .where(and(eq(calls.id, push.call_id), eq(calls.workspace_id, connection.workspace_id)))
  if (!call || call.deleted_at) return null
  const contact = await callerContact(tx, call)
  const [link] = contact
    ? await tx
        .select({ external_id: crm_links.external_id })
        .from(crm_links)
        .where(and(eq(crm_links.connection_id, connection.id), eq(crm_links.contact_id, contact.id)))
    : []
  const callerNumber = (call.direction === 'in' ? call.from_number : call.to_number) ?? ''
  const businessNumber = (call.direction === 'in' ? call.to_number : call.from_number) ?? null
  const { resolvedLanguage } = await workspaceLocale(tx, connection.workspace_id)
  const text = appPushText(resolvedLanguage, contact?.name || callerNumber, call.started_at)
  const durationSec =
    call.duration_sec ??
    (call.ended_at ? Math.max(0, Math.round((Date.parse(call.ended_at) - Date.parse(call.started_at)) / 1000)) : 0)
  const finished: FinishedCall = {
    callId: call.id,
    direction: call.direction,
    callerNumber,
    businessNumber,
    startedAt: iso(call.started_at),
    durationSec,
    title: call.title?.trim() || text.fallbackTitle,
    summary: call.summary ?? '',
    nextSteps: (call.action_items ?? []).map(item => item.text),
    callUrl: new URL(`/#call/${call.id}`, WEB_ORIGIN).toString(),
    caller: {
      name: contact?.name ?? null,
      email: contact?.email ?? null,
      company: contact?.company ?? null,
      phone: callerNumber,
    },
    // The record an earlier try of this push found or created comes first: a retry never creates it twice.
    linkedRecordId: push.record_id ?? link?.external_id ?? null,
    urgent: call.urgency === 'urgent',
    labels: {
      nextSteps: text.nextSteps,
      openCall: text.openCall,
      caller: text.caller,
      number: text.number,
      urgent: text.urgent,
      when: text.when,
    },
  }
  return { call: finished, contactId: contact?.id ?? null }
}

/** busy: another push of the connection is being sent; the job tries again shortly, without counting a try. */
export type AppPushOutcome = 'done' | 'retry' | 'failed' | 'skipped' | 'busy'

type AppPushRow = typeof app_pushes.$inferSelect
type Claimed = { push: AppPushRow & { claimed_at: string }; connection: AppConnection }

/** The push was disconnected, connected to another account, or claimed again by another worker while it was sent. */
class PushGone extends Error {}

const claimable = (push: AppPushRow, now: number) =>
  push.status === 'pending' ||
  (push.status === 'sending' && (!push.claimed_at || Date.parse(push.claimed_at) < now - SENDING_TIMEOUT_MS))

/**
 * Claims a push in a short transaction under the connection's lock: `sending`, a try counted, committed before
 * anything goes to the app. One push per connection at a time, so two calls of one new caller never create two
 * records; a claim that died with its worker is taken over after SENDING_TIMEOUT_MS.
 */
async function claimPush(database: Tx, pushId: string): Promise<Claimed | 'skipped' | 'busy'> {
  return database.transaction(async tx => {
    const [peek] = await tx
      .select({ connection_id: app_pushes.connection_id })
      .from(app_pushes)
      .where(eq(app_pushes.id, pushId))
    if (!peek) return 'skipped'
    await lockConnection(tx, peek.connection_id)
    // Read again under the lock: another worker may have claimed or finished it meanwhile.
    const [push] = await tx.select().from(app_pushes).where(eq(app_pushes.id, pushId)).for('update')
    const now = Date.now()
    if (!push || !claimable(push, now)) return 'skipped'
    const [connection] = await tx.select().from(app_connections).where(eq(app_connections.id, push.connection_id))
    if (!connection) return 'skipped'
    const [other] = await tx
      .select({ id: app_pushes.id })
      .from(app_pushes)
      .where(
        and(
          eq(app_pushes.connection_id, push.connection_id),
          eq(app_pushes.status, 'sending'),
          ne(app_pushes.id, push.id),
          gt(app_pushes.claimed_at, new Date(now - SENDING_TIMEOUT_MS).toISOString()),
        ),
      )
      .limit(1)
    if (other) return 'busy'
    // A claim that died after it had used the last try.
    if (push.attempts >= APP_PUSH_ATTEMPTS) {
      await tx
        .update(app_pushes)
        .set({ status: 'failed', error_code: push.error_code ?? 'internal', finished_at: nowIso() })
        .where(eq(app_pushes.id, push.id))
      return 'skipped'
    }
    const [claimed] = await tx
      .update(app_pushes)
      .set({ status: 'sending', claimed_at: new Date(now).toISOString(), attempts: push.attempts + 1 })
      .where(eq(app_pushes.id, push.id))
      .returning()
    return { push: claimed as Claimed['push'], connection }
  })
}

/**
 * Saves a step of a claimed push in its own short transaction under the connection's lock, only while the push is
 * still this worker's and the connection still the account it was sent to; else PushGone. `fn` gets the connection
 * as it is now.
 */
async function whileMine<T>(
  database: Tx,
  { push, connection }: Claimed,
  fn: (tx: Tx, current: AppConnection) => Promise<T>,
): Promise<T> {
  return database.transaction(async tx => {
    await lockConnection(tx, connection.id)
    const [current] = await tx.select().from(app_connections).where(eq(app_connections.id, connection.id))
    const [mine] = await tx
      .select({ id: app_pushes.id })
      .from(app_pushes)
      .where(
        and(eq(app_pushes.id, push.id), eq(app_pushes.status, 'sending'), eq(app_pushes.claimed_at, push.claimed_at)),
      )
    if (!current || current.account_id !== connection.account_id || !mine) throw new PushGone()
    return fn(tx, current)
  })
}

const linkContact = (tx: Tx, connection: AppConnection, contactId: string, recordId: string) =>
  tx
    .insert(crm_links)
    .values({
      id: newId('crml'),
      workspace_id: connection.workspace_id,
      connection_id: connection.id,
      contact_id: contactId,
      external_id: recordId,
    })
    .onConflictDoUpdate({
      target: [crm_links.connection_id, crm_links.contact_id],
      set: { external_id: recordId, updated_at: nowIso() },
    })

const errorCodeOf = (e: unknown): AppErrorCode =>
  e instanceof AppError ? (e.kind === 'client' ? 'auth' : e.kind) : 'internal'

/** Failures only connecting again fixes (a refused grant, the Slack channel deleted or archived): attention at once. */
const NEEDS_RECONNECT: ReadonlySet<AppErrorCode> = new Set(['auth', 'channel_not_found', 'channel_archived'])

/**
 * One try of a push, outside any long transaction: claimed in a short one, sent to the app without a transaction
 * open, and each step saved in its own short one as soon as it is done (the caller's record, then the logged call),
 * so a retry reuses them. Never throws for the app's answer: a try that may work later returns 'retry' (the job
 * throws then). A failure of the bookkeeping itself throws; the claim then runs out and a retry takes it over.
 */
export async function attemptAppPush(
  pushId: string,
  services?: AppServices,
  database: Tx = db,
  /** Hears how long the app asked to wait (Retry-After) when the outcome is 'retry' after a rate limit. */
  onRetryAfter?: (sec: number) => void,
): Promise<AppPushOutcome> {
  const claim = await claimPush(database, pushId)
  if (claim === 'skipped' || claim === 'busy') return claim
  const { push, connection } = claim
  try {
    return await sendClaimed(database, claim, services)
  } catch (e) {
    if (e instanceof PushGone) return 'skipped'
    // The app's own words, which may hold caller details, go to the server log only; the page gets the code.
    console.warn(
      `app push ${push.id} (${connection.provider}, try ${push.attempts} of ${APP_PUSH_ATTEMPTS}): ${errorMessage(e)}`,
    )
    const outcome = await noteFailure(database, claim, e).catch(gone => {
      if (gone instanceof PushGone) return 'skipped' as const
      throw gone
    })
    if (outcome === 'retry' && e instanceof AppError && e.retryAfterSec) onRetryAfter?.(e.retryAfterSec)
    return outcome
  }
}

async function sendClaimed(database: Tx, claim: Claimed, services?: AppServices): Promise<AppPushOutcome> {
  const { push, connection } = claim
  const finish = (status: 'done' | 'failed' | 'skipped', set: Partial<AppPushRow>) =>
    whileMine(database, claim, tx =>
      tx
        .update(app_pushes)
        .set({ status, finished_at: nowIso(), ...set })
        .where(eq(app_pushes.id, push.id)),
    )

  // Logging calls was turned off after this call was queued: not sent. Unless an earlier try already logged it.
  if (!push.external_id && !appSettingOn(connection.settings, 'log_calls')) {
    await finish('skipped', { error_code: 'calls_off' })
    return 'skipped'
  }
  const found = await finishedCall(database, connection, push)
  if (!found) {
    await finish('failed', { error_code: 'call_deleted' })
    return 'failed'
  }
  const { call, contactId } = found
  const succeed = (recordId: string | null, activityId: string) =>
    whileMine(database, claim, async tx => {
      if (contactId && recordId) await linkContact(tx, connection, contactId, recordId)
      await tx
        .update(app_pushes)
        .set({ status: 'done', error_code: null, finished_at: nowIso(), record_id: recordId, external_id: activityId })
        .where(eq(app_pushes.id, push.id))
      await tx
        .update(app_connections)
        .set({ status: 'connected', failures: 0, error_code: null, last_push_at: nowIso() })
        .where(eq(app_connections.id, connection.id))
    })
  // An earlier try logged the call and then could not save that it was done: done now, nothing sent twice.
  if (push.external_id) {
    await succeed(push.record_id, push.external_id)
    return 'done'
  }
  const apps = appServicesOf({ apps: services })
  const connector = apps.connector(connection.provider)
  // Only urgent calls go and this one is not (urgency is known once the summary is made, before the push is sent).
  if (appSettingOn(connection.settings, 'only_urgent') && !call.urgent) {
    await finish('skipped', { error_code: 'not_urgent' })
    return 'skipped'
  }
  // A withheld number and no email: nothing to file the call under in a CRM. Not the connection's fault, so not counted.
  if (connector.crm && !call.linkedRecordId && !isE164(call.callerNumber) && !call.caller.email) {
    await finish('failed', { error_code: 'no_caller_id' })
    return 'failed'
  }
  // The switches as they are now (read under the lock when the push was claimed).
  const options = {
    createContacts: appSettingOn(connection.settings, 'create_contacts'),
    fillFields: appSettingOn(connection.settings, 'fill_fields'),
  }
  let result: PushResult
  try {
    result = await connector.pushCall(
      appAccess(database, apps, connection),
      call,
      {
        onRecord: recordId =>
          whileMine(database, claim, async tx => {
            await tx.update(app_pushes).set({ record_id: recordId }).where(eq(app_pushes.id, push.id))
            if (contactId) await linkContact(tx, connection, contactId, recordId)
          }),
        onLogged: activityId =>
          whileMine(
            database,
            claim,
            async tx =>
              void (await tx.update(app_pushes).set({ external_id: activityId }).where(eq(app_pushes.id, push.id))),
          ),
      },
      options,
    )
  } catch (e) {
    // No contact matched the caller and creating contacts is off: skipped, not a failure of the connection.
    if (!(e instanceof PushSkipped)) throw e
    await finish('skipped', { error_code: e.reason })
    return 'skipped'
  }
  await succeed(result.recordId, result.activityId)
  return 'done'
}

/**
 * The bookkeeping of a failed try, in its own short transaction: back to `pending` for a retry, or failed for good
 * (the last try, or a refusal no retry helps), counted against the connection. A refused grant, or several in a row,
 * need someone to look.
 */
function noteFailure(database: Tx, claim: Claimed, e: unknown): Promise<AppPushOutcome> {
  const { push } = claim
  const error_code = errorCodeOf(e)
  return whileMine(database, claim, async (tx, connection) => {
    if (retryable(e) && push.attempts < APP_PUSH_ATTEMPTS) {
      await tx.update(app_pushes).set({ status: 'pending', error_code }).where(eq(app_pushes.id, push.id))
      return 'retry'
    }
    await tx
      .update(app_pushes)
      .set({ status: 'failed', error_code, finished_at: nowIso() })
      .where(eq(app_pushes.id, push.id))
    const failures = connection.failures + 1
    const attention = NEEDS_RECONNECT.has(error_code) || failures >= NEEDS_ATTENTION_AFTER
    await tx
      .update(app_connections)
      .set({ failures, error_code, ...(attention ? { status: 'needs_attention' as const } : {}) })
      .where(eq(app_connections.id, connection.id))
    return 'failed'
  })
}

/**
 * Last resort (a job every 15 minutes): a push whose claim died, or that is still open after all its retries (its
 * job gave up while the bookkeeping failed), is queued again; one open for a day is given up. Returns what it did.
 */
export async function sweepAppPushes(requeue: (pushId: string) => Promise<void>, database: Tx = db) {
  const now = Date.now()
  const open = inArray(app_pushes.status, ['pending', 'sending'])
  const givenUp = await database
    .update(app_pushes)
    .set({ status: 'failed', error_code: sql`coalesce(${app_pushes.error_code}, 'internal')`, finished_at: nowIso() })
    .where(and(open, lt(app_pushes.created_at, new Date(now - GIVE_UP_AFTER_MS).toISOString())))
    .returning({ id: app_pushes.id })
  const stuck = await database
    .select({ id: app_pushes.id })
    .from(app_pushes)
    .where(
      and(
        open,
        or(
          and(
            eq(app_pushes.status, 'sending'),
            lt(app_pushes.claimed_at, new Date(now - SENDING_TIMEOUT_MS).toISOString()),
          ),
          and(
            eq(app_pushes.status, 'pending'),
            lt(app_pushes.created_at, new Date(now - REQUEUE_AFTER_MS).toISOString()),
          ),
        ),
      ),
    )
  for (const { id } of stuck) await requeue(id)
  return { requeued: stuck.length, givenUp: givenUp.length }
}

export const appPushHandlers: Record<string, Handler> = {
  // The last pushes of the workspace's connection to the app, newest first, for the app's page.
  'app.pushes': async ({ tx, actor }, input: { app: AppId; limit: number }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const [connection] = await tx
      .select({ id: app_connections.id })
      .from(app_connections)
      .where(and(eq(app_connections.workspace_id, actor.workspaceId), eq(app_connections.provider, input.app)))
    if (!connection) return { rows: {}, data: { pushes: [] } satisfies AppPushesData }
    const found = await tx
      .select({
        push: app_pushes,
        from: calls.from_number,
        to: calls.to_number,
        direction: calls.direction,
        name: contacts.name,
      })
      .from(app_pushes)
      .innerJoin(calls, eq(calls.id, app_pushes.call_id))
      .leftJoin(contacts, eq(contacts.id, calls.contact_id))
      .where(eq(app_pushes.connection_id, connection.id))
      .orderBy(desc(app_pushes.created_at))
      .limit(input.limit)
    const data: AppPushesData = {
      pushes: found.map(({ push, from, to, direction, name }) => ({
        id: push.id,
        callId: push.call_id,
        caller: name || (direction === 'in' ? from : to) || '',
        status: push.status,
        attempts: push.attempts,
        error: push.error_code,
        createdAt: iso(push.created_at),
        finishedAt: push.finished_at ? iso(push.finished_at) : null,
      })),
    }
    return { rows: {}, data }
  },
}
