// Apply pending migrations with the runtime driver (no drizzle-kit): used when the API container starts.
// Same migrations table as `pnpm db:migrate`.
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

// Any fixed number: containers starting at the same time take turns instead of failing.
const MIGRATION_LOCK = 4_815_162_342

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK])
  await migrate(drizzle(client), { migrationsFolder: new URL('../migrations', import.meta.url).pathname })
  console.log('migrations applied')
} finally {
  await client.end() // closing the session releases the lock
}
