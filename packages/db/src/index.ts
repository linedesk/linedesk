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
  return { db: drizzle(pool, { schema }), pool }
}
export type Db = ReturnType<typeof createDb>['db']
/** A transaction handle or the db itself; handlers accept either. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db
