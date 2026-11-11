// Safe defaults for a fresh self-hosted install: `cp .env.example .env` must not leave sign-up open or
// sign-in codes in the logs, and scripts/tunnel.sh must not publish LiveKit with the development secret.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
const activeValue = (name: string) => envExample.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]

describe('.env.example', () => {
  test('sign-up is closed', () => {
    expect(activeValue('AUTH_SIGNUP_ENABLED')).toBe('false')
  })

  test('emails are not printed to the log', () => {
    expect(activeValue('EMAIL_TO_LOG')).toBeUndefined()
    expect(envExample).toMatch(/^# EMAIL_TO_LOG=true$/m)
  })
})

describe('scripts/tunnel.sh', () => {
  const tunnel = fileURLToPath(new URL('../../../scripts/tunnel.sh', import.meta.url))
  // NGROK_BASIC_AUTH empty: a run that gets past the LiveKit check stops at the basic-auth (or ngrok) check, nothing starts.
  const run = (secret: string) =>
    spawnSync('sh', [tunnel], {
      env: { PATH: process.env.PATH, LIVEKIT_API_SECRET: secret, NGROK_BASIC_AUTH: '' },
      encoding: 'utf8',
    })

  test('refuses the development LiveKit secret', () => {
    const result = run('devsecret-change-me-at-least-32-chars')
    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/LIVEKIT_API_SECRET is not set or still the development value/)
  })

  test('refuses a quoted development secret and a short one', () => {
    expect(run('"devsecret-change-me-at-least-32-chars"').stdout).toMatch(/still the development value/)
    expect(run("'devsecret-change-me-at-least-32-chars'").stdout).toMatch(/still the development value/)
    const short = run('"my-own-secret"')
    expect(short.status).toBe(1)
    expect(short.stdout).toMatch(/LIVEKIT_API_SECRET is shorter than 32 characters/)
  })

  test('reads the secret from .env without its quotes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'linedesk-tunnel-'))
    try {
      mkdirSync(join(repo, 'scripts'))
      copyFileSync(tunnel, join(repo, 'scripts/tunnel.sh'))
      const runIn = (envFile: string) => {
        writeFileSync(join(repo, '.env'), envFile)
        return spawnSync('sh', [join(repo, 'scripts/tunnel.sh')], {
          env: { PATH: process.env.PATH, NGROK_BASIC_AUTH: '' },
          encoding: 'utf8',
        })
      }
      expect(runIn('LIVEKIT_API_SECRET="devsecret-change-me-at-least-32-chars"\n').stdout).toMatch(
        /still the development value/,
      )
      expect(runIn("LIVEKIT_API_SECRET='short'\n").stdout).toMatch(/shorter than 32 characters/)
      expect(runIn('LIVEKIT_API_SECRET="a-secret-of-this-install-0123456789"\n').stdout).not.toMatch(
        /LIVEKIT_API_SECRET/,
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('goes on with a secret of your own', () => {
    const result = run('a-secret-of-this-install-0123456789')
    expect(result.status).toBe(1)
    expect(result.stdout).not.toMatch(/LIVEKIT_API_SECRET/)
    expect(result.stdout).toMatch(/NGROK_BASIC_AUTH|ngrok is not installed/)
  })
})
