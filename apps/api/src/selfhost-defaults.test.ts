// Safe defaults for a fresh self-hosted install: `cp .env.example .env` must not set the removed sign-up switch or
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
  test('there is no sign-up switch (no open sign-up at all)', () => {
    expect(activeValue('AUTH_SIGNUP_ENABLED')).toBeUndefined()
  })

  test('emails are not printed to the log', () => {
    expect(activeValue('EMAIL_TO_LOG')).toBeUndefined()
    expect(envExample).toMatch(/^# EMAIL_TO_LOG=true$/m)
  })
})

describe('scripts/setup.sh', () => {
  const setup = fileURLToPath(new URL('../../../scripts/setup.sh', import.meta.url))
  const value = (env: string, name: string) => env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]
  const secrets = ['BETTER_AUTH_SECRET', 'SECRETS_KEY', 'ELECTRIC_SECRET', 'AGENT_API_TOKEN', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'POSTGRES_PASSWORD']
  const inRepo = (fn: (repo: string, run: (...args: string[]) => ReturnType<typeof spawnSync>) => void) => {
    const repo = mkdtempSync(join(tmpdir(), 'linedesk-setup-'))
    try {
      mkdirSync(join(repo, 'scripts'))
      copyFileSync(setup, join(repo, 'scripts/setup.sh'))
      writeFileSync(join(repo, '.env.example'), envExample)
      fn(repo, (...args) => spawnSync('sh', [join(repo, 'scripts/setup.sh'), ...args], { env: { PATH: process.env.PATH }, encoding: 'utf8' }))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }

  test('makes every shared secret and PUBLIC_URL, and keeps them when run again', () => {
    inRepo((repo, run) => {
      expect(run('https://desk.example.com').status).toBe(0)
      const env = readFileSync(join(repo, '.env'), 'utf8')
      for (const name of secrets) expect(value(env, name), name).toMatch(/^[A-Za-z0-9+/=]{12,}$/)
      expect(Buffer.from(value(env, 'SECRETS_KEY')!, 'base64')).toHaveLength(32)
      // docker/api-entrypoint.sh refuses a shorter one.
      expect(value(env, 'BETTER_AUTH_SECRET')!.length).toBeGreaterThanOrEqual(32)
      expect(value(env, 'PUBLIC_URL')).toBe('https://desk.example.com')
      expect(value(env, 'DATABASE_URL')).toBe(`postgres://linedesk:${value(env, 'POSTGRES_PASSWORD')}@localhost:5433/linedesk`)
      expect(run().status).toBe(0)
      expect(readFileSync(join(repo, '.env'), 'utf8')).toBe(env)
    })
  })

  test('never sets a database password in an existing .env', () => {
    inRepo((repo, run) => {
      writeFileSync(join(repo, '.env'), envExample)
      expect(run().status).toBe(0)
      const env = readFileSync(join(repo, '.env'), 'utf8')
      expect(value(env, 'POSTGRES_PASSWORD')).toBeUndefined()
      expect(value(env, 'BETTER_AUTH_SECRET')).not.toMatch(/change-me/)
    })
  })

  test('refuses an address without http(s)', () => {
    inRepo((_repo, run) => expect(run('desk.example.com').status).toBe(1))
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

describe('docker/api-entrypoint.sh', () => {
  const entrypoint = fileURLToPath(new URL('../../../docker/api-entrypoint.sh', import.meta.url))
  // Run in an empty directory: a run that passes every check stops at the migration (no packages there), nothing starts.
  const run = (secret: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'linedesk-entrypoint-'))
    try {
      return spawnSync('sh', [entrypoint], {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          BETTER_AUTH_SECRET: secret,
          DATABASE_URL: 'postgres://linedesk:a-password-of-this-install@db:5432/linedesk',
          ELECTRIC_SECRET: 'an-electric-secret-of-this-install',
        },
        encoding: 'utf8',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('refuses an empty BETTER_AUTH_SECRET and the placeholder', () => {
    for (const secret of ['', 'change-me-to-a-long-random-string']) {
      const result = run(secret)
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/BETTER_AUTH_SECRET is not set/)
    }
  })

  test('refuses a BETTER_AUTH_SECRET shorter than 32 characters', () => {
    const result = run('a'.repeat(31))
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/BETTER_AUTH_SECRET is shorter than 32 characters/)
  })

  test('goes on with a secret of 32 characters or more', () => {
    for (const secret of ['a'.repeat(32), 'q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c='])
      expect(run(secret).stderr).not.toMatch(/BETTER_AUTH_SECRET/)
  })
})
