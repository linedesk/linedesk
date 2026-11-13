import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as authSchema from './auth-schema.ts'
import * as appSchema from './schema.ts'

export * from './schema.ts'
export * from './auth-schema.ts'
export * from './types.ts'

export const schema = { ...appSchema, ...authSchema }

export function createDb(url: string, options: Omit<pg.PoolConfig, 'connectionString'> = {}) {
  const pool = new pg.Pool({ ...options, connectionString: url })
  // An idle connection that drops (Postgres restarted, a network blip, a tunnel reconnecting) is reported on the pool.
  // Without a listener Node treats it as uncaught and the whole process dies; the pool already removed that
  // connection and opens a new one for the next query, so logging it is all there is to do.
  pool.on('error', error => console.error(`database: an idle connection failed and was dropped: ${error.message}`))
  return { db: drizzle(pool, { schema }), pool }
}
export type Db = ReturnType<typeof createDb>['db']
/** A transaction handle or the db itself; handlers accept either. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db
