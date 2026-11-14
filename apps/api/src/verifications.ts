// Better Auth's `verification` rows (sign-in and confirmation codes, passkey challenges, provider sign-in state) are
// only read until they expire, and Better Auth deletes one only when it is looked up again. A passkey challenge is
// stored for every sign-in page that asks for one, so the expired rows are deleted daily (jobs.ts, with the command log).
import { verification } from '@linedesk/db'
import { inArray, lt } from 'drizzle-orm'
import type { db as Db } from './db.ts'

/** Rows deleted per statement, so the job never holds a long lock on the table. */
const BATCH = 2000

/** Deletes the verification rows that expired before `now`; returns how many. */
export async function pruneExpiredVerifications(db: typeof Db, now = new Date()): Promise<number> {
  let total = 0
  for (;;) {
    const expired = db
      .select({ id: verification.id })
      .from(verification)
      .where(lt(verification.expiresAt, now))
      .limit(BATCH)
    const deleted = await db
      .delete(verification)
      .where(inArray(verification.id, expired))
      .returning({ id: verification.id })
    total += deleted.length
    if (deleted.length < BATCH) return total
  }
}
