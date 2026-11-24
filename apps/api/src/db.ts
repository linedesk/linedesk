import { createDb } from '@linedesk/db'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')
export const { db, pool } = createDb(url)
/**
 * Writes that must commit on their own while the action's transaction still holds its connection (the number
 * purchase log). Its own two connections, so they never wait for the main pool, which a burst of requests can
 * fill with transactions that are waiting for exactly this write: that would hang the whole API.
 */
export const { db: ownCommitDb } = createDb(url, { max: 2, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 1_000, allowExitOnIdle: true })
