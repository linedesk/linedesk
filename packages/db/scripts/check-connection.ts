/**
 * Runs before `pnpm db:migrate`: drizzle-kit prints only "applying migrations..." and exits when it cannot reach the
 * database, so this says why (no DATABASE_URL, Postgres not running, wrong password) first.
 */
import pg from 'pg'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set: run scripts/setup.sh (it writes .env), then pnpm db:up.')
  process.exit(1)
}
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 })
try {
  await client.connect()
  await client.query('select 1')
} catch (error) {
  const where = new URL(url)
  console.error(`Cannot reach the database at ${where.host}${where.pathname}: ${(error as Error).message || error}`)
  console.error('Is Postgres running (pnpm db:up), and do DATABASE_URL and POSTGRES_PASSWORD in .env match?')
  process.exit(1)
} finally {
  await client.end().catch(() => {})
}
