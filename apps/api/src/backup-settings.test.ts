// The offsite backup's bucket key can delete every backup, so it must never reach a container: it lives in
// backup.env, not in .env (which the API reads whole), and goes to rclone's container by name, not on the
// command line. scripts/backup.sh runs here with a fake `docker` that records what it was given.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

const root = new URL('../../../', import.meta.url).pathname
const SECRET = 'bucket-secret-0123456789abcdef'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'linedesk-backup-test-'))
  // The fake docker: its arguments in one file, the secret it got through the environment in another.
  writeFileSync(
    join(dir, 'docker'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/args"\nprintf '%s' "\${RCLONE_CONFIG_B_SECRET_ACCESS_KEY:-}" > "${dir}/env-secret"\n`,
  )
  chmodSync(join(dir, 'docker'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function writeSettings(mode: number) {
  const file = join(dir, 'backup.env')
  writeFileSync(
    file,
    [
      'BACKUP_S3_ENDPOINT=https://example.r2.cloudflarestorage.com',
      'BACKUP_S3_BUCKET=backups',
      'BACKUP_S3_ACCESS_KEY_ID=key-id',
      `BACKUP_S3_SECRET_ACCESS_KEY=${SECRET}`,
    ].join('\n'),
  )
  chmodSync(file, mode)
  return file
}

/** backup.sh --list with only PATH, HOME and BACKUP_ENV_FILE set: nothing comes from the developer's environment. */
const listBackups = (settingsFile: string) =>
  spawnSync('bash', [join(root, 'scripts/backup.sh'), '--list'], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, BACKUP_ENV_FILE: settingsFile },
    encoding: 'utf8',
  })

test('the bucket key reaches rclone by name only, never on the docker command line', () => {
  const run = listBackups(writeSettings(0o600))
  expect(run.status, run.stderr).toBe(0)
  const args = readFileSync(join(dir, 'args'), 'utf8')
  expect(args).not.toContain(SECRET)
  expect(args.split('\n')).toContain('RCLONE_CONFIG_B_SECRET_ACCESS_KEY')
  expect(args).toContain('b:backups/linedesk')
  expect(readFileSync(join(dir, 'env-secret'), 'utf8')).toBe(SECRET)
})

test('a settings file that others can read is refused before anything runs', () => {
  const run = listBackups(writeSettings(0o644))
  expect(run.status).toBe(1)
  expect(run.stderr).toContain('chmod 600')
  expect(existsSync(join(dir, 'args'))).toBe(false)
})

test('a named settings file that is missing is refused', () => {
  const run = listBackups(join(dir, 'missing.env'))
  expect(run.status).toBe(1)
  expect(existsSync(join(dir, 'args'))).toBe(false)
})

test('the backup settings are not offered for .env, which the API container reads whole', () => {
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8')
  expect(compose).toMatch(/env_file: \[\{ path: \.env/)
  expect(compose).not.toContain('backup.env')
  expect(readFileSync(join(root, '.env.example'), 'utf8')).not.toMatch(/^#?BACKUP_S3_/m)
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^backup\.env$/m)
  expect(readFileSync(join(root, '.dockerignore'), 'utf8')).toMatch(/^backup\.env$/m)
})
