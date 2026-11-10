// Background jobs with pg-boss, in the API process: its tables live in the `pgboss` schema of the
// same database, so self-hosting needs nothing extra. Several API replicas share the work.
// JOBS_ENABLED=false starts the API without them (one replica can do the jobs for all).
import { PgBoss } from 'pg-boss'
import { db } from './db.ts'
import { deleteExpiredRecordings } from './recording-retention.ts'
import { recordingStoreFromEnv } from './recording-store.ts'

type Env = Record<string, string | undefined>

export const RECORDING_CLEANUP = 'recordings.cleanup'
/** Every day at 03:17 UTC: quiet hours for US businesses. */
const RECORDING_CLEANUP_CRON = '17 3 * * *'

let boss: PgBoss | null = null

/** The running queue, or null when jobs are off (tests, JOBS_ENABLED=false). */
export const jobQueue = () => boss

export async function startJobs(env: Env = process.env): Promise<PgBoss | null> {
  if (env.JOBS_ENABLED === 'false') return null
  const instance = new PgBoss({ connectionString: env.DATABASE_URL!, schema: 'pgboss' })
  instance.on('error', error => console.error('jobs:', error))
  await instance.start()
  await instance.createQueue(RECORDING_CLEANUP)
  await instance.schedule(RECORDING_CLEANUP, RECORDING_CLEANUP_CRON)
  await instance.work(RECORDING_CLEANUP, async () => {
    const result = await deleteExpiredRecordings(db, recordingStoreFromEnv(env))
    if (result.deleted || result.failed)
      console.log(`recordings cleanup: ${result.deleted} deleted, ${result.failed} failed`)
    return result
  })
  boss = instance
  return instance
}

export async function stopJobs() {
  await boss?.stop({ graceful: true, timeout: 2000 })
  boss = null
}
