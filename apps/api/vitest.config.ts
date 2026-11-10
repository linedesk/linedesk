import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

// Handler tests run against the dev database (inside a transaction that is rolled back).
const envFile = new URL('../../.env', import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)
// Tests must never reach a carrier, whatever .env selects.
process.env.TELEPHONY_PROVIDER = 'dev'

export default defineConfig({})
