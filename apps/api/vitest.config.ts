import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { configDefaults, defineConfig } from 'vitest/config'
import { isReachable, runDatabaseUrl, testDatabaseBaseUrl } from './test/test-database.ts'

const envFile = new URL('../../.env', import.meta.url)
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}

/** The database for this run. Without Postgres: null on a developer machine, an error in CI. */
async function testDatabase(): Promise<string | null> {
  const base = testDatabaseBaseUrl({ ...fileEnv, ...process.env })
  if (base && (await isReachable(base))) return runDatabaseUrl(base)
  const problem = base ? `no Postgres at ${new URL(base).host}` : 'DATABASE_URL is not set'
  if (process.env.CI) throw new Error(`The API tests need Postgres: ${problem}`)
  console.warn(`\nSkipping the API integration tests: ${problem} (run \`pnpm db:up\`, and \`cp .env.example .env\`).\n`)
  return null
}

// The API tests run against a real Postgres, in a database of their own (never the dev database).
export default defineConfig(async () => {
  const databaseUrl = await testDatabase()
  return {
    test: {
      globalSetup: './test/global-setup.ts',
      exclude: [...configDefaults.exclude, ...(databaseUrl ? [] : ['test/**'])],
      env: {
        DATABASE_URL: databaseUrl ?? '',
        BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret',
        BETTER_AUTH_URL: 'http://localhost:5173',
        WEB_ORIGIN: 'http://localhost:5173',
        AGENT_API_TOKEN: 'test-agent-token',
        ELECTRIC_URL: 'http://electric.test',
        // Tests must never reach a carrier, whatever .env selects.
        TELEPHONY_PROVIDER: 'dev',
      },
    },
  }
})
