// Background jobs with pg-boss, in the API process: its tables live in the `pgboss` schema of the
// same database, so self-hosting needs nothing extra. Several API replicas share the work.
// JOBS_ENABLED=false: this process only queues jobs and runs none (another replica does them).
import type { Tx } from '@linedesk/db'
import { sql } from 'drizzle-orm'
import { fromDrizzle, PgBoss } from 'pg-boss'
import { notifyCallFinished } from './call-notifications.ts'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { deleteExpiredRecordings } from './recording-retention.ts'
import { recordingStoreCache } from './recording-store.ts'

type Env = Record<string, string | undefined>

export const RECORDING_CLEANUP = 'recordings.cleanup'
/** Every day at 03:17 UTC: quiet hours for US businesses. */
const RECORDING_CLEANUP_CRON = '17 3 * * *'
/** Emails about one finished call. Retried a few times when no email could go out at all. */
export const CALL_NOTIFY = 'call.notify'

let boss: PgBoss | null = null

/** The running queue, or null when jobs are not started (tests). */
export const jobQueue = () => boss

async function runJobs(instance: PgBoss, env: Env) {
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
