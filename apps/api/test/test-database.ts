// The database the API tests run in. Every run gets its own, created from the migrations and
// dropped afterwards, so parallel runs (several checkouts, one Postgres) cannot disturb each other.
// Its name starts with a base name that must end in `_test`: the database of TEST_DATABASE_URL,
// or the one of DATABASE_URL with `_test` appended. The dev database is never touched.
import { createDb } from '@callfront/db'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

const STALE_AFTER_MS = 60 * 60 * 1000
const databaseName = (url: string) => new URL(url).pathname.slice(1)
const withDatabase = (url: string, name: string) => Object.assign(new URL(url), { pathname: `/${name}` }).href

/** Where test databases are created, or null when no Postgres is configured. */
export function testDatabaseBaseUrl(env: Record<string, string | undefined>): string | null {
  const base =
    env.TEST_DATABASE_URL ??
    (env.DATABASE_URL ? withDatabase(env.DATABASE_URL, `${databaseName(env.DATABASE_URL)}_test`) : null)
  if (base && !databaseName(base).endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL must name a database ending in _test, got ${databaseName(base)}`)
  }
  return base
}

/** The database of one test run: `<base>_<start time>_<random>`. */
export const runDatabaseUrl = (baseUrl: string) =>
  withDatabase(baseUrl, `${databaseName(baseUrl)}_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`)

type Pool = ReturnType<typeof createDb>['pool']

/** Run statements on the server's maintenance database. */
async function onServer(url: string, run: (pool: Pool) => Promise<unknown>) {
  const { pool } = createDb(withDatabase(url, 'postgres'))
  try {
    await run(pool)
  } finally {
    await pool.end()
  }
}

export async function isReachable(baseUrl: string): Promise<boolean> {
  try {
    await onServer(baseUrl, pool => pool.query('select 1'))
    return true
  } catch {
    return false
  }
}

/** Only databases this file created are ever dropped: `<something>_test_<digits>_<random>`. */
const isRunDatabase = (name: string) => /_test_\d+_[0-9a-f]{6}$/.test(name)

export async function dropTestDatabase(url: string) {
  const name = databaseName(url)
  if (!isRunDatabase(name)) throw new Error(`refusing to drop ${name}: not a test run database`)
  await onServer(url, pool => pool.query(`drop database if exists "${name}" with (force)`))
}

/** Runs that crashed leave their database behind; remove those older than an hour. */
async function dropStaleDatabases(url: string) {
  const prefix = databaseName(url).replace(/_\d+_[0-9a-f]{6}$/, '')
  await onServer(url, async pool => {
    const { rows } = await pool.query<{ datname: string }>('select datname from pg_database where datname like $1', [
      `${prefix}\\_%`,
    ])
    for (const { datname } of rows) {
      const startedAt = Number(datname.match(/_(\d+)_[0-9a-f]{6}$/)?.[1])
      if (isRunDatabase(datname) && Date.now() - startedAt > STALE_AFTER_MS)
        await pool.query(`drop database if exists "${datname}" with (force)`)
    }
  })
}

/** Create the run's database and apply every migration. */
export async function createTestDatabase(url: string) {
  const name = databaseName(url)
  if (!isRunDatabase(name)) throw new Error(`refusing to create ${name}: not a test run database`)
  await dropStaleDatabases(url)
  await onServer(url, pool => pool.query(`create database "${name}"`))
  const { db, pool } = createDb(url)
  try {
    await migrate(db, { migrationsFolder: new URL('../../../packages/db/migrations', import.meta.url).pathname })
  } finally {
    await pool.end()
  }
}
