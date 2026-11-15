// An instance admin's authenticator app (authenticator.ts), the fallback to the passkey: only an admin with a passkey
// adds it, a code opens Server admin for this session like a passkey check, the passkey stays required, a code works
// once, the lock after wrong codes, removal and the passkey reset.
import { admin_authenticators, passkey, session, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { issuePasskeyEnrolment } from '../src/passkey-enrolment.ts'
import { codeAt, stepAt } from '../src/totp.ts'
import { act, request, signUp, type User } from './helpers.ts'

let before: string | undefined
beforeAll(() => {
  before = process.env.ADMIN_SECOND_FACTOR
  process.env.ADMIN_SECOND_FACTOR = 'on'
})
afterAll(() => {
  if (before === undefined) delete process.env.ADMIN_SECOND_FACTOR
  else process.env.ADMIN_SECOND_FACTOR = before
})

async function admin(): Promise<User> {
  const who = await signUp()
  await db.update(user).set({ instanceAdmin: true, emailVerified: true }).where(eq(user.id, who.userId))
  return who
}
async function addPasskey(who: User) {
  await db.insert(passkey).values({
    id: crypto.randomUUID(),
    userId: who.userId,
    name: 'Laptop',
    publicKey: 'cHVibGlj',
    credentialID: `cred-${crypto.randomUUID()}`,
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    createdAt: new Date(),
  })
}
/** As a passkey sign-in sets it (markPasskeySession). */
const checked = (who: User) =>
  db
    .update(session)
    .set({ passkeyVerifiedAt: new Date(), secondFactorMethod: 'passkey' })
    .where(eq(session.userId, who.userId))
const unchecked = (who: User) =>
  db.update(session).set({ passkeyVerifiedAt: null }).where(eq(session.userId, who.userId))
/** An admin with a passkey whose session passed the passkey check. */
async function adminWithPasskey(): Promise<User> {
  const who = await admin()
  await addPasskey(who)
  await checked(who)
  return who
}
const step = (who: User, name: 'confirm' | 'check', body: unknown) =>
  request(who, 'POST', `/v1/account/authenticator/${name}`, body)
const me = async (who: User) => (await request(who, 'GET', '/v1/me')).body
const adminPage = async (who: User) => (await request(who, 'GET', '/v1/admin/users')).status
const current = (secret: string, offset = 0) => codeAt(secret, stepAt(Date.now()) + offset)

/** Adds and confirms an app for an admin whose session passed the check; returns its secret. */
async function addApp(who: User): Promise<string> {
  await checked(who)
  const started = await act(who, 'account.authenticatorStart', {})
  expect(started.status).toBe(200)
  const { secret } = started.body.data
  expect((await step(who, 'confirm', { code: current(secret, -1) })).status).toBe(200)
  return secret
}

describe('adding an authenticator app', () => {
  test('needs a passkey and the passkey check; the enrolment code does not add it', async () => {
    const who = await admin()
    const { enrolmentCode } = await db.transaction(tx => issuePasskeyEnrolment(tx, who.userId))
    const none = await act(who, 'account.authenticatorStart', {})
    expect(none.status).toBe(403)
    expect(none.body.error).toMatch(/Add a passkey first/)
    expect((await act(who, 'account.authenticatorStart', { enrolmentCode })).status).not.toBe(200)

    await addPasskey(who)
    const notChecked = await act(who, 'account.authenticatorStart', {})
    expect(notChecked.status).toBe(403)
    expect(notChecked.body.error).toMatch(/Confirm with your passkey first/)
  })

  test('with the passkey check: QR secret, first code, emailed; stored encrypted', async () => {
    const who = await adminWithPasskey()
    const started = await act(who, 'account.authenticatorStart', {})
    expect(started.status).toBe(200)
    expect(started.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//)
    const { secret } = started.body.data
    const [row] = await db.select().from(admin_authenticators).where(eq(admin_authenticators.user_id, who.userId))
    expect(row!.secret).not.toContain(secret)
    expect(row!.confirmed_at).toBeNull()

    const send = vi.spyOn(emailSender, 'send')
    expect((await step(who, 'confirm', { code: current(secret) })).status).toBe(200)
    expect(send.mock.calls.some(([m]) => /authenticator app was added/i.test(m.subject))).toBe(true)
    send.mockRestore()
    expect((await me(who)).hasAuthenticator).toBe(true)
  })

  test('not for members who are no server admin, and not through the generic action route', async () => {
    const member = await signUp()
    expect([401, 403]).toContain((await act(member, 'account.authenticatorStart', {})).status)
    const who = await adminWithPasskey()
    expect((await act(who, 'account.authenticatorCheck', { code: '123456' })).status).toBe(400)
    expect((await act(who, 'account.authenticatorConfirm', { code: '123456' })).status).toBe(400)
  })

  test('a second app waits until the first is removed', async () => {
    const who = await adminWithPasskey()
    await addApp(who)
    expect((await act(who, 'account.authenticatorStart', {})).status).toBe(409)
  })
})

describe('checking with the app', () => {
  test('the fallback: a code opens Server admin for this session, and works once', async () => {
    const who = await adminWithPasskey()
    const secret = await addApp(who)
    // A new sign-in has not passed the check.
    await unchecked(who)
    expect((await me(who)).adminSecondFactor).toBe('confirm')
    expect(await adminPage(who)).toBe(403)

    const code = current(secret)
    expect((await step(who, 'check', { code })).status).toBe(200)
    expect(await adminPage(who)).toBe(200)

    // The same code again: refused (and the next step's code still works).
    await unchecked(who)
    expect((await step(who, 'check', { code })).status).toBe(403)
    expect((await step(who, 'check', { code: current(secret, 1) })).status).toBe(200)
  })

  test('the passkey stays required: without one the app opens nothing and Server admin asks for a passkey', async () => {
    const who = await adminWithPasskey()
    const secret = await addApp(who)
    await db.delete(passkey).where(eq(passkey.userId, who.userId))
    await unchecked(who)
    expect((await me(who)).adminSecondFactor).toBe('enrol')
    const res = await step(who, 'check', { code: current(secret) })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/Add a passkey first/)
    // Even a session that passed a check before: no passkey, no Server admin.
    await checked(who)
    expect((await me(who)).adminSecondFactor).toBe('enrol')
    expect(await adminPage(who)).toBe(403)
  })

  test('a check with the app opens Server admin and adds a passkey, but changes nothing else a passkey guards', async () => {
    const who = await adminWithPasskey()
    const secret = await addApp(who)
    await unchecked(who)
    expect((await step(who, 'check', { code: current(secret) })).status).toBe(200)
    expect(await adminPage(who)).toBe(200)
    expect((await me(who)).passkeySignedIn).toBe(false)
    // The app cannot be swapped or removed with a (phishable) code: that needs the passkey.
    const remove = await act(who, 'account.authenticatorRemove', {})
    expect(remove.status).toBe(403)
    expect(remove.body.error).toMatch(/Confirm with your passkey first/)
    // Removing a passkey needs a passkey sign-in.
    const [pk] = await db.select().from(passkey).where(eq(passkey.userId, who.userId))
    const del = await request(
      who,
      'POST',
      '/api/auth/passkey/delete-passkey',
      { id: pk!.id },
      { origin: 'http://localhost:5173' },
    )
    expect(del.status).toBe(403)
    expect(await db.select().from(passkey).where(eq(passkey.userId, who.userId))).toHaveLength(1)
  })

  test('parallel wrong codes are each counted: the lock holds, also for the right code', async () => {
    const who = await adminWithPasskey()
    const secret = await addApp(who)
    const wrong = current(secret) === '000000' ? '111111' : '000000'
    const results = await Promise.all(Array.from({ length: 20 }, () => step(who, 'check', { code: wrong })))
    expect(results.every(r => r.status === 403)).toBe(true)
    expect(results.some(r => /Too many wrong codes/.test(r.body.error))).toBe(true)
    const after = await step(who, 'check', { code: current(secret, 1) })
    expect(after.status).toBe(403)
    expect(after.body.error).toMatch(/Too many wrong codes/)
  })

  test('after a check with the app, a passkey can be added on this computer without a code', async () => {
    const who = await adminWithPasskey()
    const secret = await addApp(who)
    await unchecked(who)
    expect((await step(who, 'check', { code: current(secret) })).status).toBe(200)
    expect((await me(who)).passkeyEnrolment).toBe(false)
    const options = await request(who, 'GET', '/api/auth/passkey/generate-register-options', undefined, {
      origin: 'http://localhost:5173',
    })
    expect(options.status).toBe(200)
  })

  test('five wrong codes lock the app, also for the right one', async () => {
    const who = await adminWithPasskey()
    const secret = await addApp(who)
    const wrong = current(secret) === '000000' ? '111111' : '000000'
    for (let i = 0; i < 5; i++) expect((await step(who, 'check', { code: wrong })).status).toBe(403)
    const locked = await step(who, 'check', { code: current(secret, 1) })
    expect(locked.status).toBe(403)
    expect(locked.body.error).toMatch(/Too many wrong codes/)
  })
})

describe('removing the app', () => {
  test('needs a passkey sign-in in this session', async () => {
    const who = await adminWithPasskey()
    await addApp(who)
    await unchecked(who)
    expect((await act(who, 'account.authenticatorRemove', {})).status).toBe(403)
    await checked(who)
    expect((await act(who, 'account.authenticatorRemove', {})).status).toBe(200)
    expect((await me(who)).hasAuthenticator).toBe(false)
  })

  test("resetting an admin's passkeys removes the app too", async () => {
    const who = await adminWithPasskey()
    await addApp(who)
    const other = await adminWithPasskey()
    expect((await act(other, 'user.resetPasskeys', { userId: who.userId })).status).toBe(200)
    expect(
      await db.select().from(admin_authenticators).where(eq(admin_authenticators.user_id, who.userId)),
    ).toHaveLength(0)
  })
})
