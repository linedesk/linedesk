// Business owners never read server settings: no environment variable names in the app's own
// screens. Admin mode (apps/web/src/admin) is for operators and may name them.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'

const root = new URL('.', import.meta.url).pathname
/** Names an operator sets in .env; an owner cannot act on any of them. */
const SERVER_SETTING =
  /\b(LIVEKIT_[A-Z_]+|SMTP_URL|EMAIL_TO_LOG|EMAIL_FROM|SECRETS_KEY|DATABASE_URL|AGENT_API_TOKEN|TELEPHONY_PROVIDER|RECORDING_STORE|RECORDINGS_DIR|JOBS_ENABLED|S3_[A-Z_]+|[A-Z]+_API_KEY|[A-Z]+_PROVIDER|AUTH_[A-Z_]+)\b/

/** Screens outside admin mode that only the instance admin sees. */
const FOR_THE_INSTANCE_ADMIN = new Set([
  // The install walkthrough: the person installing Linedesk sets up its .env.
  'onboarding/InstallSetup.tsx',
])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'admin' ? [] : sources(path)
    if (FOR_THE_INSTANCE_ADMIN.has(relative(root, path))) return []
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

test('no server setting names outside admin mode', () => {
  const found = sources(root).flatMap(file =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ line, at: `${relative(root, file)}:${i + 1}` }))
      // Comments explain the code to developers; only what reaches the screen counts.
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && SERVER_SETTING.test(line))
      .map(({ at, line }) => `${at}: ${line.trim()}`),
  )
  expect(found).toEqual([])
})
