// Background jobs with pg-boss, in the API process: its tables live in the `pgboss` schema of the
// same database, so self-hosting needs nothing extra. Several API replicas share the work.
// JOBS_ENABLED=false: this process only queues jobs and runs none (another replica does them).
import type { Tx } from '@linedesk/db'
import { sql } from 'drizzle-orm'
import { fromDrizzle, PgBoss } from 'pg-boss'
import { sendBookingConfirmation } from './booking-confirmation.ts'
import { notifyCallFinished } from './call-notifications.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { evaluateCall, evaluationModel } from './evaluations.ts'
import { notifyCallPush, type PushKind, pushSender } from './push.ts'
import { deleteExpiredRecordings } from './recording-retention.ts'
import { recordingStoreCache } from './recording-store.ts'
import { deleteClonedVoice } from './voices.ts'
import { sendSpendingAlert, type SpendingAlert } from './spending-cap.ts'
import { attemptDelivery, clearOldPayloads, WEBHOOK_ATTEMPTS } from './webhooks.ts'

type Env = Record<string, string | undefined>

export const RECORDING_CLEANUP = 'recordings.cleanup'
/** Every day at 03:17 UTC: quiet hours for US businesses. */
const RECORDING_CLEANUP_CRON = '17 3 * * *'
/** Emails about one finished call. Retried a few times when no email could go out at all. */
export const CALL_NOTIFY = 'call.notify'
/** Push notifications about one call (push.ts): flagged urgent, message taken, or ended. */
export const CALL_PUSH = 'call.push'
/** The confirmation email to a caller who booked. */
export const BOOKING_CONFIRM = 'booking.confirm'
/** How the assistant handled a finished call, judged by the language model (evaluations.ts). */
export const CALL_EVALUATE = 'call.evaluate'
/** One webhook delivery (webhooks.ts). Retried with backoff: 1, 2, 4 … 32 minutes, about an hour in all. */
export const WEBHOOK_DELIVER = 'webhook.deliver'
/** Webhook deliveries one API process sends at the same time. */
export const WEBHOOK_WORKERS = 5
/** Every day: webhook payloads older than 30 days are cleared (webhooks.ts). */
export const WEBHOOK_CLEANUP = 'webhooks.cleanup'
/** Deletes a cloned voice at its provider once no assistant uses it (voices.ts). Retried for a day. */
export const VOICE_DELETE = 'voice.delete'
const WEBHOOK_CLEANUP_CRON = '37 3 * * *'
/** The email to owners and instance admins when a workspace reaches 80 % or 100 % of its spending cap. */
export const SPENDING_CAP_ALERT = 'spending.capAlert'

let boss: PgBoss | null = null

/** The running queue, or null when jobs are not started (tests). */
export const jobQueue = () => boss

async function runJobs(instance: PgBoss, env: Env) {
  await instance.work<{ provider: string; voiceId: string }>(VOICE_DELETE, async ([job]) => {
    if (job) await deleteClonedVoice(job.data.provider, job.data.voiceId)
  })
  await instance.schedule(RECORDING_CLEANUP, RECORDING_CLEANUP_CRON)
  await instance.work(RECORDING_CLEANUP, async () => {
    const result = await deleteExpiredRecordings(db, recordingStoreCache(db, env))
    if (result.deleted || result.failed)
      console.log(`recordings cleanup: ${result.deleted} deleted, ${result.failed} failed`)
    return result
  })
  await instance.work<{ callId: string }>(CALL_NOTIFY, async ([job]) => {
    const result = await notifyCallFinished(db, emailSender, job!.data.callId)
    // Nothing went out (mail server down?): fail, so pg-boss tries again later.
    if (result.failed && !result.sent) throw new Error(`no call email could be sent (${result.failed} failed)`)
    return result
  })
  await instance.work<{ callId: string; kind: PushKind }>(CALL_PUSH, async ([job]) => {
    const result = await notifyCallPush(db, pushSender(), job!.data.callId, job!.data.kind)
    // Nothing went out (push services unreachable?): fail, so pg-boss tries again shortly.
    if (result.failed && !result.sent) throw new Error(`no push could be sent (${result.failed} failed)`)
    return result
  })
  await instance.work<SpendingAlert>(SPENDING_CAP_ALERT, async ([job]) => {
    const result = await sendSpendingAlert(db, emailSender, job!.data)
    if (result.failed && !result.sent) throw new Error(`no spending cap email could be sent (${result.failed} failed)`)
    return result
  })
  await instance.work<{ bookingId: string }>(BOOKING_CONFIRM, async ([job]) => sendBookingConfirmation(db, emailSender, job!.data.bookingId))
  // No language model set up: nothing to do, and no retry. A failed request (provider down) is retried.
  await instance.work<{ callId: string }>(CALL_EVALUATE, async ([job]) => evaluateCall(db, job!.data.callId, await evaluationModel(db)))
  await instance.schedule(WEBHOOK_CLEANUP, WEBHOOK_CLEANUP_CRON)
  await instance.work(WEBHOOK_CLEANUP, async () => ({ cleared: await clearOldPayloads(db) }))
  // Several at once, so a few slow endpoints (each up to the 10 s timeout) do not hold up everyone's deliveries.
  await instance.work<{ deliveryId: string }>(WEBHOOK_DELIVER, { localConcurrency: WEBHOOK_WORKERS }, async ([job]) => {
    const outcome = await attemptDelivery(db, job!.data.deliveryId, env)
    if (outcome === 'retry') throw new Error(`webhook delivery ${job!.data.deliveryId} failed; retrying`)
    return { outcome }
  })
}

export async function startJobs(env: Env = process.env): Promise<PgBoss> {
  const workHere = env.JOBS_ENABLED !== 'false'
  const instance = new PgBoss({
    connectionString: env.DATABASE_URL!,
    schema: 'pgboss',
    ...(workHere ? {} : { supervise: false, schedule: false }),
  })
  instance.on('error', error => console.error('jobs:', error))
  await instance.start()
  await instance.createQueue(RECORDING_CLEANUP)
  await instance.createQueue(CALL_NOTIFY, { retryLimit: 4, retryDelay: 60, retryBackoff: true })
  // Few, quick retries: a push about a call is news only for a while.
  await instance.createQueue(CALL_PUSH, { retryLimit: 2, retryDelay: 30, retryBackoff: true })
  await instance.createQueue(SPENDING_CAP_ALERT, { retryLimit: 4, retryDelay: 60, retryBackoff: true })
  await instance.createQueue(BOOKING_CONFIRM, { retryLimit: 4, retryDelay: 60, retryBackoff: true })
  await instance.createQueue(CALL_EVALUATE, { retryLimit: 2, retryDelay: 120, retryBackoff: true })
  await instance.createQueue(WEBHOOK_CLEANUP)
  await instance.createQueue(VOICE_DELETE, { retryLimit: 24, retryDelay: 3600 })
  await instance.createQueue(WEBHOOK_DELIVER, { retryLimit: WEBHOOK_ATTEMPTS - 1, retryDelay: 60, retryBackoff: true })
  if (workHere) await runJobs(instance, env)
  boss = instance
  return instance
}

export async function stopJobs() {
  await boss?.stop({ graceful: true, timeout: 2000 })
  boss = null
}

/** For tests: a queue to send to without starting workers. */
export const setJobQueue = (queue: PgBoss | null) => {
  boss = queue
}

/**
 * Queues the emails for a finished call in the same transaction as the call: the job exists only
 * if the call was saved, and is sent after it is visible. Without a queue (tests) nothing is sent.
 */
export async function queueCallNotification(tx: Tx, callId: string) {
  await boss?.send(CALL_NOTIFY, { callId }, { db: fromDrizzle(tx, sql) })
}

/** Queues the pushes about a call in the caller's transaction. Without a queue (tests) nothing is sent. */
export async function queueCallPush(tx: Tx, callId: string, kind: PushKind) {
  await boss?.send(CALL_PUSH, { callId, kind }, { db: fromDrizzle(tx, sql) })
}

/** Queues a spending-cap email in the caller's transaction. Without a queue (tests) nothing is sent. */
export async function queueSpendingCapAlert(tx: Tx, alert: SpendingAlert) {
  await boss?.send(SPENDING_CAP_ALERT, alert, { db: fromDrizzle(tx, sql) })
}

/** Queues the caller's confirmation email in the booking's transaction. Without a queue (tests) nothing is sent. */
export async function queueBookingConfirmation(tx: Tx, bookingId: string) {
  await boss?.send(BOOKING_CONFIRM, { bookingId }, { db: fromDrizzle(tx, sql) })
}

/** Queues the evaluation of a finished call, in the caller's transaction (like the notification). */
export async function queueCallEvaluation(tx: Tx, callId: string) {
  await boss?.send(CALL_EVALUATE, { callId }, { db: fromDrizzle(tx, sql), singletonKey: callId, singletonSeconds: 60 })
}

/** Queues one webhook delivery in the transaction of the event. Without a queue (tests) it stays pending. */
export async function queueWebhookDelivery(tx: Tx, deliveryId: string) {
  await boss?.send(WEBHOOK_DELIVER, { deliveryId }, { db: fromDrizzle(tx, sql) })
}

/** Queues the deletion of a cloned voice at its provider, in the transaction that stopped using it. */
export async function queueVoiceDeletion(tx: Tx, provider: string, voiceId: string) {
  await boss?.send(VOICE_DELETE, { provider, voiceId }, { db: fromDrizzle(tx, sql) })
}
