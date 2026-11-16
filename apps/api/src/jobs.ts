// Background jobs with pg-boss, in the API process: its tables live in the `pgboss` schema of the
// same database, so self-hosting needs nothing extra. Several API replicas share the work.
// JOBS_ENABLED=false: this process only queues jobs and runs none (another replica does them).
import type { RecordingStoreName } from '@linedesk/actions'
import { BillingSetupError } from '@linedesk/billing'
import { calls, type Tx } from '@linedesk/db'
import { lt, sql } from 'drizzle-orm'
import { fromDrizzle, PgBoss } from 'pg-boss'
import { notifyAssigned } from './assign-notifications.ts'
import { sendBookingConfirmation } from './booking-confirmation.ts'
import { notifyCallFinished } from './call-notifications.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { type WorkspaceDeletedEmail, workspaceDeletedEmail } from './emails/templates.ts'
import { runForwardingCheck } from './forwarding-check.ts'
import { evaluateCall, evaluationModel } from './evaluations.ts'
import { transcribeCallAgain, transcriberInEffect, transcribesAfterCalls } from './after-call-transcript.ts'
import { releaseHeldNews } from './call-news.ts'
import { notifyCallPush, type PushKind, pushSender } from './push.ts'
import { deleteCallRecording, deleteExpiredRecordings } from './recording-retention.ts'
import { clearOldDemoCalls, demoTranscriptDays, stripOldDemoIpHashes } from './demo-rooms.ts'
import { pruneOldCommands } from './command-log.ts'
import { pruneExpiredVerifications } from './verifications.ts'
import { pruneOldAdminDevices } from './admin-devices.ts'
import {
  healthCheckCron,
  healthCheckHours,
  PROVIDER_HEALTH_CHECK,
  runProviderHealthCheck,
} from './provider-health-check.ts'
import { syncDerivedDays, workspacesWithDerivedDays } from './public-holidays.ts'
import { recordingStoreCache } from './recording-store.ts'
import { deleteClonedVoice } from './voices.ts'
import { sendDueSetupEmails } from './setup-emails.ts'
import { sendSpendingAlert, type SpendingAlert } from './spending-cap.ts'
import { attemptAnyDelivery } from './integrations.ts'
import { clearOldPayloads, WEBHOOK_ATTEMPTS } from './webhooks.ts'
import { localeForEmail } from './email-locale.ts'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { ledgerCheckAlert, stuckRechargesAlert } from './emails/alerts.ts'
import { checkLedger } from './ledger.ts'
import {
  type BillingAlertJob,
  chargeRecharge,
  rechargeGaveUp,
  sendBillingAlert,
  stuckRecharges,
} from './billing-recharge.ts'
import { createReconcileQueue, runReconcileJob } from './billing-reconcile.ts'
import { createStripeEventQueues, runStripeEventJobs } from './stripe-events.ts'

type Env = Record<string, string | undefined>

export const RECORDING_CLEANUP = 'recordings.cleanup'
/** Every day at 03:17 UTC: quiet hours for US businesses. */
const RECORDING_CLEANUP_CRON = '17 3 * * *'
/**
 * Deletes one call's recording right after the call, for a workspace that keeps none. Retried with backoff
 * for about a day; the daily cleanup catches anything left after that.
 */
export const RECORDING_DELETE = 'recording.delete'
/** Deletes one recording file by store and key, for calls whose rows are gone already (a deleted workspace). Retried for about a day. */
export const RECORDING_FILE_DELETE = 'recording.deleteFile'
/** Emails about one finished call. Retried a few times when no email could go out at all. */
export const CALL_NOTIFY = 'call.notify'
/** Push notifications about one call (push.ts): flagged urgent, message taken, or ended. */
export const CALL_PUSH = 'call.push'
/** Email and push to a member a teammate assigned a call to (assign-notifications.ts). */
export const CALL_ASSIGNED = 'call.assigned'
/** Seconds before the assignee hears of it: an undo or a quick reassignment in between sends nothing. */
const ASSIGNED_DELAY_SECONDS = 10
/** The confirmation email to a caller who booked. */
export const BOOKING_CONFIRM = 'booking.confirm'
/** How the assistant handled a finished call, judged by the language model (evaluations.ts). */
export const CALL_EVALUATE = 'call.evaluate'
/** After-call transcription of a call whose recording was saved (after-call-transcript.ts). */
export const CALL_TRANSCRIBE = 'call.transcribe'
/** A finished call whose news still waits for its corrected transcript gets it sent now (call-news.ts). */
export const CALL_RELEASE = 'call.release'
/** Every 5 minutes: holds older than 5 minutes past their end (call-news.ts) are released. */
const HELD_NEWS_SWEEP = 'call.held-news-sweep'
const HELD_NEWS_SWEEP_CRON = '*/5 * * * *'
/** One webhook or integration delivery (webhooks.ts, integrations.ts). Retried with backoff: 1, 2, 4 … 32 minutes, about an hour in all. */
export const WEBHOOK_DELIVER = 'webhook.deliver'
/** Webhook deliveries one API process sends at the same time. */
export const WEBHOOK_WORKERS = 5
/** Every day: webhook payloads older than 30 days are cleared (webhooks.ts). */
export const WEBHOOK_CLEANUP = 'webhooks.cleanup'
/** Deletes a cloned voice at its provider once no assistant uses it (voices.ts). Retried for a day. */
export const VOICE_DELETE = 'voice.delete'
const WEBHOOK_CLEANUP_CRON = '37 3 * * *'
/** Daily: command log inputs and results older than 90 days keep only ids (command-log.ts). */
export const COMMAND_PRUNE = 'commands.prune'
const COMMAND_PRUNE_CRON = '47 3 * * *'
/** Nightly: the ledger guards and the billing sums (ledger.ts checkLedger); instance admins hear about what is wrong. */
export const LEDGER_CHECK = 'billing.ledgerCheck'
const LEDGER_CHECK_CRON = '57 3 * * *'
/**
 * Charges one auto-recharge attempt (billing-recharge.ts), queued in the transaction that decided it. Retried with
 * backoff for about an hour; every try sends the same Stripe idempotency keys, so a retry never charges twice.
 */
export const BILLING_RECHARGE = 'billing.recharge'
/** How often the recharge job is retried; after the last one the attempt gives up (billing-recharge.ts rechargeGaveUp). */
const BILLING_RECHARGE_RETRIES = 6
/** Hourly: recharge attempts that crossed 2 hours pending in the last hour are named to the instance admins. */
export const STUCK_RECHARGE_CHECK = 'billing.stuckRecharges'
const STUCK_RECHARGE_CHECK_CRON = '27 * * * *'
/** One billing email: to the bill owner (a failed recharge, the cap, a low balance), or a capped call to the admins. */
export const BILLING_ALERT = 'billing.alert'
/** Daily: the public holidays and yearly days of the next twelve months move one day on (public-holidays.ts). */
export const HOLIDAY_SYNC = 'holidays.sync'
const HOLIDAY_SYNC_CRON = '17 2 * * *'
/** One forwarding check (forwarding-check.ts): dials, waits up to a minute, never retried (each try is a real call). */
export const FORWARDING_CHECK = 'forwarding.check'
/** Checks one API process runs at the same time; each mostly waits on the phone ringing. */
const FORWARDING_CHECK_WORKERS = 5

/** Hourly: public demo calls older than DEMO_TRANSCRIPT_DAYS lose their transcript and summary, demo tokens older than a day their visitor hash (demo-rooms.ts). */
export const DEMO_CALL_CLEANUP = 'demoCalls.cleanup'
// Every hour: a demo token's visitor hash is kept DEMO_IP_HASH_HOURS, so at most an hour longer.
const DEMO_CALL_CLEANUP_CRON = '27 * * * *'

/** The email to owners and instance admins when a workspace reaches 80 % or 100 % of its spending cap. */
export const SPENDING_CAP_ALERT = 'spending.capAlert'
/** Every 15 minutes: the setup emails due to new workspaces (setup-emails.ts), when the install sends them. */
/** The email to a member that their workspace was deleted by its owner (workspace.deleteOwn). */
export const WORKSPACE_DELETED_EMAIL = 'workspace.deletedEmail'
export const SETUP_EMAILS = 'setup.emails'
const SETUP_EMAILS_CRON = '*/15 * * * *'

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
  await instance.work<{ callId: string }>(RECORDING_DELETE, async ([job]) => ({
    deleted: await deleteCallRecording(db, recordingStoreCache(db, env), job!.data.callId),
  }))
  await instance.work<RecordingFile>(RECORDING_FILE_DELETE, async ([job]) => {
    await (await recordingStoreCache(db, env)(job!.data.store)).delete(job!.data.key)
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
  await instance.work<{ eventId: string }>(CALL_ASSIGNED, async ([job]) => {
    const result = await notifyAssigned(db, emailSender, pushSender(), job!.data.eventId)
    if (result.email === 'failed' && !result.push?.sent)
      throw new Error('the assignment notification could not be sent')
    return result
  })
  await instance.work<SpendingAlert>(SPENDING_CAP_ALERT, async ([job]) => {
    const result = await sendSpendingAlert(db, emailSender, job!.data)
    if (result.failed && !result.sent) throw new Error(`no spending cap email could be sent (${result.failed} failed)`)
    return result
  })
  await instance.work<WorkspaceDeletedJob>(WORKSPACE_DELETED_EMAIL, async ([job]) => {
    const { to, ...content } = job!.data
    // The account may be gone with the workspace: then English.
    await emailSender.send({ to, ...workspaceDeletedEmail(content, undefined, await localeForEmail(db, to)) })
  })
  await instance.work<{ bookingId: string }>(BOOKING_CONFIRM, async ([job]) =>
    sendBookingConfirmation(db, emailSender, job!.data.bookingId),
  )
  // No language model set up: nothing to do, and no retry. A failed request (provider down) is retried.
  await instance.work<{ callId: string }>(CALL_EVALUATE, async ([job]) =>
    evaluateCall(db, job!.data.callId, await evaluationModel(db)),
  )
  // A failure (model or bucket down) is logged and tried again; after the last try the live transcript stays. No
  // transaction around it: the model takes seconds; the lines are written in one short transaction at the end.
  await instance.work<{ callId: string }>(CALL_TRANSCRIBE, async ([job]) => {
    const callId = job!.data.callId
    try {
      return await transcribeCallAgain(db, callId, await transcriberInEffect(db, env), recordingStoreCache(db, env))
    } catch (e) {
      console.warn(`after-call transcription of call ${callId} failed: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  })
  // The agent never brought the summary of the corrected transcript (call.finalize): the news goes with the one it has.
  const releaseCall = async (callId: string) => {
    // A recording reported meanwhile is still transcribed again, in the same transaction, unless call.correctTranscript
    // already started on it (it queues its own retry when it fails).
    const released = await db.transaction(async tx => {
      const call = await releaseHeldNews(tx, callId)
      if (call?.recording_key && !call.transcript_requested_at && (await transcribesAfterCalls(tx)))
        await queueCallTranscript(tx, callId)
      return call
    })
    if (released)
      console.warn(
        `call ${callId}: no summary of the corrected transcript came in time, its news went with the live one`,
      )
    return { released: !!released }
  }
  await instance.work<{ callId: string }>(CALL_RELEASE, async ([job]) => releaseCall(job!.data.callId))
  // Last resort: a hold whose CALL_RELEASE job never ran or gave up is released here, so no call's news is lost.
  await instance.schedule(HELD_NEWS_SWEEP, HELD_NEWS_SWEEP_CRON)
  await instance.work(HELD_NEWS_SWEEP, async () => {
    const held = await db
      .select({ id: calls.id })
      .from(calls)
      .where(lt(calls.awaiting_transcript_until, sql`now() - interval '5 minutes'`))
      .limit(100)
    let released = 0
    for (const { id } of held) {
      const result = await releaseCall(id).catch(e => {
        console.error(`held news sweep: call ${id} could not be released:`, e)
        return { released: false }
      })
      if (result.released) released++
    }
    return { released }
  })
  await instance.work<{ checkId: string }>(
    FORWARDING_CHECK,
    { localConcurrency: FORWARDING_CHECK_WORKERS },
    async ([job]) => ({
      status: await runForwardingCheck(job!.data.checkId),
    }),
  )
  // The free key check of every provider that is set up (provider-health-check.ts); off with PROVIDER_HEALTH_CHECK_HOURS=0.
  const healthHours = healthCheckHours(env)
  if (healthHours) await instance.schedule(PROVIDER_HEALTH_CHECK, healthCheckCron(healthHours))
  else await instance.unschedule(PROVIDER_HEALTH_CHECK)
  await instance.work(PROVIDER_HEALTH_CHECK, async () => {
    const result = await runProviderHealthCheck(db, { env })
    if (result.failing.length) console.log(`provider health check: failing ${result.failing.join(', ')}`)
    return result
  })
  await instance.schedule(SETUP_EMAILS, SETUP_EMAILS_CRON)
  await instance.work(SETUP_EMAILS, async () => sendDueSetupEmails(db, emailSender))
  await instance.schedule(COMMAND_PRUNE, COMMAND_PRUNE_CRON)
  // Daily: the command log's old inputs, expired codes and passkey challenges (verifications.ts), and admin browsers
  // not seen for longer than their cookie lives (admin-devices.ts).
  await instance.work(COMMAND_PRUNE, async () => ({
    pruned: await pruneOldCommands(db),
    expiredVerifications: await pruneExpiredVerifications(db),
    oldAdminDevices: await pruneOldAdminDevices(db),
  }))
  await instance.schedule(LEDGER_CHECK, LEDGER_CHECK_CRON)
  await instance.work(LEDGER_CHECK, async () => runLedgerCheck())
  await instance.work<{ rechargeId: string }>(BILLING_RECHARGE, async ([job]) => {
    try {
      return await chargeRecharge(db, job!.data.rechargeId)
    } catch (error) {
      // A setup error (our keys or account, not the card) gives up as an admin alert (recheck of #864, L2).
      if (job!.retryCount >= BILLING_RECHARGE_RETRIES)
        await rechargeGaveUp(db, job!.data.rechargeId, {
          setupError: error instanceof BillingSetupError ? error : undefined,
        }).catch(e => console.error(`billing: recharge ${job!.data.rechargeId} could not be given up:`, e))
      throw error
    }
  })
  await instance.schedule(STUCK_RECHARGE_CHECK, STUCK_RECHARGE_CHECK_CRON)
  await instance.work(STUCK_RECHARGE_CHECK, async () => runStuckRechargeCheck())
  await instance.work<BillingAlertJob>(BILLING_ALERT, async ([job]) => sendBillingAlert(db, emailSender, job!.data))
  // Stripe's webhook events and the nightly reconciliation with Stripe (stripe-events.ts, billing-reconcile.ts).
  await runStripeEventJobs(instance)
  await runReconcileJob(instance)
  await instance.schedule(HOLIDAY_SYNC, HOLIDAY_SYNC_CRON)
  await instance.work(HOLIDAY_SYNC, async () => {
    // One transaction per workspace, so a long run holds no locks for long.
    const ids = await workspacesWithDerivedDays(db)
    for (const id of ids) await db.transaction(tx => syncDerivedDays(tx, id))
    return { workspaces: ids.length }
  })
  await instance.schedule(DEMO_CALL_CLEANUP, DEMO_CALL_CLEANUP_CRON)
  await instance.work(DEMO_CALL_CLEANUP, async () => {
    const { cleared, ipHashes } = await db.transaction(async tx => ({
      cleared: await clearOldDemoCalls(tx, demoTranscriptDays(env)),
      ipHashes: await stripOldDemoIpHashes(tx),
    }))
    if (cleared.length) console.log(`demo calls cleanup: ${cleared.length} cleared`)
    return { cleared: cleared.length, ipHashes }
  })
  await instance.schedule(WEBHOOK_CLEANUP, WEBHOOK_CLEANUP_CRON)
  await instance.work(WEBHOOK_CLEANUP, async () => ({ cleared: await clearOldPayloads(db) }))
  // Several at once, so a few slow endpoints (each up to the 10 s timeout) do not hold up everyone's deliveries.
  await instance.work<{ deliveryId: string }>(WEBHOOK_DELIVER, { localConcurrency: WEBHOOK_WORKERS }, async ([job]) => {
    const outcome = await attemptAnyDelivery(db, job!.data.deliveryId, env)
    if (outcome === 'retry') throw new Error(`webhook delivery ${job!.data.deliveryId} failed; retrying`)
    return { outcome }
  })
}

/**
 * The nightly billing check. It is never retried (the next night is the retry), so a run that throws alerts the
 * instance admins itself instead of failing unheard (security review of #857, L4).
 */
export async function runLedgerCheck({
  alert = alertInstanceAdmins,
  check = checkLedger,
}: {
  alert?: typeof alertInstanceAdmins
  check?: typeof checkLedger
} = {}) {
  try {
    const found = await db.transaction(tx => check(tx))
    if (!found) return { bills: false }
    const problems = found.guardsMissing.length + found.differences.length
    if (problems) {
      console.error(`billing check: ${problems} problems (${JSON.stringify(found)})`)
      await alert(ledgerCheckAlert(found))
    }
    // Every recharge still pending after 2 hours, each night until it is settled (review of #864, M1).
    const stuck = await stuckRecharges(db, new Date().toISOString())
    if (stuck.length) await alert(stuckRechargesAlert(stuck))
    return { bills: true, problems, stuck: stuck.length }
  } catch (error) {
    console.error('billing check failed:', error)
    await alert(ledgerCheckAlert({ guardsMissing: [], differences: [], failed: true }))
    return { bills: true, failed: true }
  }
}

/**
 * The hourly check (review of #864, M1): recharge attempts that crossed 2 hours pending in the last hour are emailed
 * to the instance admins, so a stuck bill is noticed the same day; the nightly check names every one still pending.
 */
export async function runStuckRechargeCheck({
  alert = alertInstanceAdmins,
  now = new Date(),
}: {
  alert?: typeof alertInstanceAdmins
  now?: Date
} = {}) {
  const stuck = await stuckRecharges(db, now.toISOString(), new Date(now.getTime() - 60 * 60_000).toISOString())
  if (stuck.length) {
    console.error(`billing: ${stuck.length} recharge attempt(s) pending for more than 2 hours`)
    await alert(stuckRechargesAlert(stuck), undefined, { wait: true })
  }
  return { stuck: stuck.length }
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
  await instance.createQueue(RECORDING_DELETE, { retryLimit: 12, retryDelay: 60, retryBackoff: true })
  await instance.createQueue(RECORDING_FILE_DELETE, { retryLimit: 12, retryDelay: 60, retryBackoff: true })
  await instance.createQueue(CALL_NOTIFY, { retryLimit: 4, retryDelay: 60, retryBackoff: true })
  // Few, quick retries: a push about a call is news only for a while.
  await instance.createQueue(CALL_PUSH, { retryLimit: 2, retryDelay: 30, retryBackoff: true })
  await instance.createQueue(CALL_ASSIGNED, { retryLimit: 2, retryDelay: 30, retryBackoff: true })
  await instance.createQueue(SPENDING_CAP_ALERT, { retryLimit: 4, retryDelay: 60, retryBackoff: true })
  await instance.createQueue(WORKSPACE_DELETED_EMAIL, { retryLimit: 6, retryDelay: 60, retryBackoff: true })
  await instance.createQueue(BOOKING_CONFIRM, { retryLimit: 4, retryDelay: 60, retryBackoff: true })
  await instance.createQueue(CALL_EVALUATE, { retryLimit: 2, retryDelay: 120, retryBackoff: true })
  await instance.createQueue(CALL_TRANSCRIBE, {
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
  })
  await instance.createQueue(CALL_RELEASE, { retryLimit: 4, retryDelay: 30, retryBackoff: true })
  await instance.createQueue(FORWARDING_CHECK, { retryLimit: 0, expireInSeconds: 180 })
  await instance.createQueue(WEBHOOK_CLEANUP)
  await instance.createQueue(DEMO_CALL_CLEANUP)
  await instance.createQueue(COMMAND_PRUNE)
  await instance.createQueue(HOLIDAY_SYNC)
  await instance.createQueue(LEDGER_CHECK, { retryLimit: 0, expireInSeconds: 600 })
  await instance.createQueue(STUCK_RECHARGE_CHECK, { retryLimit: 0, expireInSeconds: 300 })
  await instance.createQueue(BILLING_RECHARGE, {
    retryLimit: BILLING_RECHARGE_RETRIES,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 120,
  })
  await instance.createQueue(BILLING_ALERT, { retryLimit: 4, retryDelay: 60, retryBackoff: true })
  await createStripeEventQueues(instance)
  await createReconcileQueue(instance)
  await instance.createQueue(SETUP_EMAILS)
  await instance.createQueue(HELD_NEWS_SWEEP)
  // One run at a time, never retried: the next scheduled run is the retry.
  await instance.createQueue(PROVIDER_HEALTH_CHECK, { retryLimit: 0, expireInSeconds: 600 })
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

/** A recording file in its store (calls.recording_store, calls.recording_key). */
export type RecordingFile = { store: RecordingStoreName | null; key: string }

/** Queues the deletion of recording files in the caller's transaction: they go once it commits, retried until the store takes it. */
export async function queueRecordingFileDeletions(tx: Tx, files: RecordingFile[]) {
  if (files.length)
    await boss?.insert(
      RECORDING_FILE_DELETE,
      files.map(data => ({ data })),
      { db: fromDrizzle(tx, sql) },
    )
}

/** Queues the deletion of a call's recording in the caller's transaction (a workspace that keeps none). */
export async function queueRecordingDeletion(tx: Tx, callId: string) {
  await boss?.send(RECORDING_DELETE, { callId }, { db: fromDrizzle(tx, sql), singletonKey: callId })
}

/** Queues the pushes about a call in the caller's transaction. Without a queue (tests) nothing is sent. */
export async function queueCallPush(tx: Tx, callId: string, kind: PushKind) {
  await boss?.send(CALL_PUSH, { callId, kind }, { db: fromDrizzle(tx, sql) })
}

/** Queues the assignee's notification in call.assign's transaction; sent after ASSIGNED_DELAY_SECONDS if it still stands. */
export async function queueAssignNotification(tx: Tx, eventId: string) {
  await boss?.send(CALL_ASSIGNED, { eventId }, { db: fromDrizzle(tx, sql), startAfter: ASSIGNED_DELAY_SECONDS })
}

/** Queues the charge of a recharge attempt in the transaction that decided it: it runs only if that commits. */
export async function queueRecharge(tx: Tx, rechargeId: string) {
  // Queued once per attempt; a second run of the same attempt only meets Stripe's idempotency keys.
  await boss?.send(BILLING_RECHARGE, { rechargeId }, { db: fromDrizzle(tx, sql) })
}

/** Queues a billing email in the transaction that made its occasion (a `billing_alerts` row, a posted entry). */
export async function queueBillingAlert(tx: Tx, alert: BillingAlertJob) {
  await boss?.send(BILLING_ALERT, alert, { db: fromDrizzle(tx, sql) })
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

/** Queues the after-call transcription of a call in call.setRecording's transaction: it runs once the recording is reported. */
export async function queueCallTranscript(tx: Tx, callId: string) {
  await boss?.send(
    CALL_TRANSCRIBE,
    { callId },
    { db: fromDrizzle(tx, sql), singletonKey: callId, singletonSeconds: 60 },
  )
}

/** Queues the release of a held call's news `afterSec` later, in call.finish's transaction (call-news.ts). */
export async function queueCallRelease(tx: Tx, callId: string, afterSec: number) {
  await boss?.send(CALL_RELEASE, { callId }, { db: fromDrizzle(tx, sql), singletonKey: callId, startAfter: afterSec })
}

/** Queues one webhook delivery in the transaction that caused it, `afterSec` later. Without a queue (tests) it stays pending. */
export async function queueWebhookDelivery(tx: Tx, deliveryId: string, afterSec = 0) {
  await boss?.send(
    WEBHOOK_DELIVER,
    { deliveryId },
    { db: fromDrizzle(tx, sql), ...(afterSec ? { startAfter: afterSec } : {}) },
  )
}

/** Queues the deletion of a cloned voice at its provider, in the transaction that stopped using it. */
export async function queueVoiceDeletion(tx: Tx, provider: string, voiceId: string) {
  await boss?.send(VOICE_DELETE, { provider, voiceId }, { db: fromDrizzle(tx, sql) })
}

/** Queues a forwarding check in the transaction that started it: it dials only once the check is committed. */
export async function queueForwardingCheck(tx: Tx, checkId: string) {
  await boss?.send(FORWARDING_CHECK, { checkId }, { db: fromDrizzle(tx, sql) })
}

/** One member's "your workspace was deleted" email: the address and what it says (already email-safe). */
export type WorkspaceDeletedJob = WorkspaceDeletedEmail & { to: string }

/**
 * Queues the emails about a deleted workspace in the delete's transaction: they go only if it commits, and outlive
 * the workspace (their data names no workspace, so dropping its queued jobs leaves them). Without a queue (tests)
 * nothing is sent.
 */
export async function queueWorkspaceDeletedEmails(tx: Tx, emails: WorkspaceDeletedJob[]) {
  if (emails.length)
    await boss?.insert(
      WORKSPACE_DELETED_EMAIL,
      emails.map(data => ({ data })),
      { db: fromDrizzle(tx, sql) },
    )
}
