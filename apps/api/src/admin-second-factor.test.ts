import { expect, test } from 'vitest'
import { adminSecondFactorRequired, localOnlyInstall, secondFactorOffWarning } from './admin-second-factor.ts'

test('an install on this machine only (PUBLIC_URL is a local address) needs no passkey for Server admin', () => {
  for (const url of ['http://localhost:8490', 'http://127.0.0.1:3100', 'http://[::1]:3100', 'http://tx.localhost:5196']) {
    expect(localOnlyInstall({ PUBLIC_URL: url })).toBe(true)
    expect(adminSecondFactorRequired({ PUBLIC_URL: url })).toBe(false)
  }
  // ADMIN_SECOND_FACTOR=on turns the check on locally, to try it.
  expect(adminSecondFactorRequired({ PUBLIC_URL: 'http://localhost:8490', ADMIN_SECOND_FACTOR: 'on' })).toBe(true)
})

test('any other address keeps the passkey check, unless it is turned off', () => {
  for (const env of [
    { PUBLIC_URL: 'https://app.linedesk.ai' },
    { PUBLIC_URL: 'https://abc.ngrok-free.app' },
    { PUBLIC_URL: 'https://localhost.example.com' },
    { PUBLIC_URL: 'not a url' },
    {},
  ]) {
    expect(localOnlyInstall(env)).toBe(false)
    expect(adminSecondFactorRequired(env)).toBe(true)
  }
  expect(adminSecondFactorRequired({ PUBLIC_URL: 'https://app.linedesk.ai', ADMIN_SECOND_FACTOR: 'off' })).toBe(false)
})

test('at start: one line for a local install, the loud warning when it is turned off', () => {
  expect(secondFactorOffWarning({ PUBLIC_URL: 'http://localhost:8490' })).toMatch(/^Server admin opens without a passkey: this install has only local addresses/)
  expect(secondFactorOffWarning({ PUBLIC_URL: 'https://app.linedesk.ai', ADMIN_SECOND_FACTOR: 'off' })).toContain('WARNING: ADMIN_SECOND_FACTOR=off')
  expect(secondFactorOffWarning({ PUBLIC_URL: 'https://app.linedesk.ai' })).toBeNull()
})

test('a tunnel or server address in any of PUBLIC_URL, WEB_ORIGIN, BETTER_AUTH_URL keeps the check (scripts/tunnel.sh)', () => {
  expect(localOnlyInstall({ PUBLIC_URL: 'http://localhost:8490', WEB_ORIGIN: 'https://abc.ngrok-free.app' })).toBe(false)
  expect(localOnlyInstall({ PUBLIC_URL: 'http://localhost:8490', BETTER_AUTH_URL: 'https://abc.ngrok-free.app' })).toBe(false)
  expect(localOnlyInstall({ WEB_ORIGIN: 'http://localhost:5173', BETTER_AUTH_URL: 'http://localhost:5173' })).toBe(true)
  expect(adminSecondFactorRequired({ PUBLIC_URL: 'http://localhost:8490', WEB_ORIGIN: 'https://abc.ngrok-free.app' })).toBe(true)
})
