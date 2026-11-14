// The first admin of a fresh install (setup.ts, LIN-189): the setup code from the server log makes them, signs them in
// and, where admins need a passkey, gives that browser their passkey enrolment code at once, so the first passkey needs
// no command on the server. Later admins never get one this way. Needs a database without users, so it is one of the
// instance-wide files (vitest.config.ts).
import { instance_settings, passkey, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { enrolmentCodeValid } from '../src/passkey-enrolment.ts'
import { issueSetupCode, SETUP_CODE_LIFETIME_MS, setupNeeded } from '../src/setup.ts'
import { appRequest, FROM, randomIp, signUp } from './helpers.ts'

const ORIGIN = 'http://localhost:5173'
const before = process.env.ADMIN_SECOND_FACTOR

/** The setup code a start prints (`fresh`: setup-code.ts --new), read from the log line. */
async function newSetupCode(fresh = false): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await db.transaction(tx => issueSetupCode(tx, { fresh }))
    const line = log.mock.calls.map(c => String(c[0])).find(l => l.includes('setup code'))
    const code = line?.match(/\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/)?.[1]
    if (!code) throw new Error('no setup code printed')
    return code
  } finally {
    log.mockRestore()
  }
}

const setUp = (code: string, email: string) =>
  appRequest('/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, [FROM]: randomIp() },
    body: JSON.stringify({ code, name: 'Mike Brennan', email, password: 'a-long-enough-password' }),
  })

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')

beforeAll(async () => {
  process.env.ADMIN_SECOND_FACTOR = 'on'
  // global-setup.ts puts a first user into every test database; this file needs an install without users.
  await db.delete(user)
})
afterAll(() => {
  process.env.ADMIN_SECOND_FACTOR = before
})

const storedCode = async () =>
  (await db.select().from(instance_settings).where(eq(instance_settings.key, 'setup.code')))[0]

describe('the setup code', () => {
  test('stays the same across restarts, also when two APIs start at once', async () => {
    expect(await setupNeeded(db)).toBe(true)
    const first = await newSetupCode()
    expect(await newSetupCode()).toBe(first)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const both = await Promise.all([1, 2].map(() => db.transaction(tx => issueSetupCode(tx))))
      expect(both.map(issued => issued?.code)).toEqual([first, first])
      // Also when neither finds a code yet: the first insert wins, both print it.
      await db.delete(instance_settings).where(eq(instance_settings.key, 'setup.code'))
      const racing = await Promise.all([1, 2].map(() => db.transaction(tx => issueSetupCode(tx))))
      expect(racing[0]?.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      expect(racing[1]?.code).toBe(racing[0]?.code)
    } finally {
      log.mockRestore()
    }
  })

  test('a wrong code is refused and the right one still works afterwards', async () => {
    const code = await newSetupCode()
    const wrong = code === 'ABCD-EFGH' ? 'ABCD-EFGJ' : 'ABCD-EFGH'
    const res = await setUp(wrong, 'mike@brightwater.test')
    expect(res.status).toBe(403)
    expect(await setupNeeded(db)).toBe(true)
    expect(await newSetupCode()).toBe(code)
  })

  test('--new replaces it: the old code no longer works', async () => {
    const old = await newSetupCode()
    const replaced = await newSetupCode(true)
    expect(replaced).not.toBe(old)
    expect(await newSetupCode()).toBe(replaced)
    expect((await setUp(old, 'mike@brightwater.test')).status).toBe(403)
    expect(await setupNeeded(db)).toBe(true)
  })

  test('after 7 days it no longer works, and the next start prints a new one', async () => {
    const old = await newSetupCode()
    const longAgo = new Date(Date.now() - SETUP_CODE_LIFETIME_MS - 60_000).toISOString()
    await db.update(instance_settings).set({ updated_at: longAgo }).where(eq(instance_settings.key, 'setup.code'))
    expect((await setUp(old, 'mike@brightwater.test')).status).toBe(403)
    const next = await newSetupCode()
    expect(next).not.toBe(old)
    expect(await newSetupCode()).toBe(next)
  })

  test('is deleted once the first admin exists, and none is printed after that', async () => {
    const res = await setUp(await newSetupCode(), 'mike@brightwater.test')
    expect(res.status).toBe(200)
    expect(await storedCode()).toBeUndefined()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(await db.transaction(tx => issueSetupCode(tx))).toBeNull()
      expect(log.mock.calls.some(c => String(c[0]).includes('setup code'))).toBe(false)
    } finally {
      log.mockRestore()
    }
    // A code left from before an account was made another way (user:create) goes at the next start.
    await db
      .insert(instance_settings)
      .values({ key: 'setup.code', value: 'ABCDEFGH', updated_at: new Date().toISOString() })
    await db.transaction(tx => issueSetupCode(tx))
    expect(await storedCode()).toBeUndefined()
    // Back to an install without users for the tests below.
    await db.delete(user)
  })
})

describe('the first admin', () => {
  let firstId = ''

  test('gets their passkey enrolment code with the setup, signed in at once', async () => {
    expect(await setupNeeded(db)).toBe(true)
    const res = await setUp(await newSetupCode(), 'mike@brightwater.test')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as {
      user: { id: string }
      enrolment: { enrolmentCode: string; enrolmentExpiresAt: string } | null
    }
    firstId = body.user.id
    expect(body.enrolment?.enrolmentCode).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(Date.parse(body.enrolment!.enrolmentExpiresAt)).toBeGreaterThan(Date.now() + 23 * 3_600_000)
    // The code is the one their first passkey needs; only its hash is stored.
    const [row] = await db.select().from(user).where(eq(user.id, firstId))
    expect(row!.instanceAdmin).toBe(true)
    expect(row!.passkeyEnrolmentHash).not.toContain(body.enrolment!.enrolmentCode)
    expect(enrolmentCodeValid(row!, body.enrolment!.enrolmentCode)).toBe(true)

    // Signed in by the same answer: the install setup says a passkey comes first.
    const headers = { cookie: cookieOf(res), origin: ORIGIN }
    expect(headers.cookie).toMatch(/session_token/)
    const state = await appRequest('/v1/admin/install-setup', { headers })
    expect(state.status).toBe(200)
    expect(((await state.json()) as { passkeyNeeded: boolean }).passkeyNeeded).toBe(true)

    // With a passkey it is not needed any more.
    await db.insert(passkey).values({
      id: 'pk_first_admin',
      userId: firstId,
      publicKey: 'cHVibGlj',
      credentialID: 'cred-first-admin',
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
    })
    const again = await appRequest('/v1/admin/install-setup', { headers })
    expect(((await again.json()) as { passkeyNeeded: boolean }).passkeyNeeded).toBe(false)
  })

  test('later admins get no code from the setup: it works only while nobody has an account', async () => {
    const later = await signUp('ann@brightwater.test')
    await db.update(user).set({ instanceAdmin: true }).where(eq(user.id, later.userId))
    const res = await setUp('ABCD-EFGH', 'someone@brightwater.test')
    expect(res.status).toBe(409)
    expect(JSON.stringify(await res.json())).not.toContain('enrolment')
    const [row] = await db.select().from(user).where(eq(user.id, later.userId))
    expect(row!.passkeyEnrolmentHash).toBeNull()
  })

  test('no code where admins need no passkey (ADMIN_SECOND_FACTOR=off)', async () => {
    // Back to an install without users.
    await db.delete(user)
    process.env.ADMIN_SECOND_FACTOR = 'off'
    const res = await setUp(await newSetupCode(), 'mike@brightwater.test')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { id: string }; enrolment: unknown }
    expect(body.enrolment).toBeNull()
    const [row] = await db.select().from(user).where(eq(user.id, body.user.id))
    expect(row!.passkeyEnrolmentHash).toBeNull()
  })
})
