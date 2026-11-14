// Passkeys through Better Auth's plugin: who may add, list and remove them, and that a passkey never
// creates an account. A full WebAuthn ceremony needs an authenticator, so registration is checked up
// to its options; sign-in with an unknown credential is checked to make nobody.
// Impersonation (no passkey changes as the user) is in admin.test.ts, the file with instance admins.
import { auth_events, passkey, session, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { readAuthConfig } from '../src/auth-methods.ts'
import { PASSKEY_CHALLENGE_LIMIT, PASSKEY_CHALLENGE_PATH } from '../src/auth.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { notifyPasskeyChange, PASSKEY_CONFIRMATION_REQUIRED, PASSKEY_ENROLMENT_REQUIRED, passkeyChangeRefusal, passkeyRelyingParty } from '../src/passkeys.ts'
import { enrolmentCodeValid, issuePasskeyEnrolment } from '../src/passkey-enrolment.ts'
import { anonymous, appRequest, type Caller, createWorkspace, randomIp, request, signUp, FROM, type User } from './helpers.ts'

const ORIGIN = { origin: 'http://localhost:5173' }
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const authGet = (who: Caller, path: string) =>
  request(who, 'GET', `/api/auth${path}`, undefined, { ...ORIGIN, [FROM]: randomIp() })
const authPost = (who: Caller, path: string, body: unknown) =>
  request(who, 'POST', `/api/auth${path}`, body, { ...ORIGIN, [FROM]: randomIp() })

/** A member whose address is confirmed: an unconfirmed one cannot add passkeys (see below). */
async function verifiedSignUp(email: string) {
  const member = await signUp(email)
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, member.userId))
  return member
}

/** Makes the caller's session look as if it started two days ago (Better Auth's fresh age is one day). */
async function ageSession(who: User) {
  await db
    .update(session)
    .set({ createdAt: new Date(Date.now() - 2 * 24 * 3_600_000) })
    .where(eq(session.userId, who.userId))
}

async function addPasskeyRow(who: User) {
  const id = `pk_${crypto.randomUUID().slice(0, 12)}`
  await db.insert(passkey).values({
    id,
    userId: who.userId,
    name: 'Laptop',
    publicKey: 'cHVibGlj',
    credentialID: `cred-${id}`,
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: 'internal',
    createdAt: new Date(),
  })
  return id
}
/** Marks the caller's session as started by a passkey sign-in at `at` (what the session.create hook does). */
async function confirmWithPasskey(who: User, at = new Date()) {
  await db.update(session).set({ passkeyVerifiedAt: at }).where(eq(session.userId, who.userId))
}

const passkeyExists = async (id: string) => (await db.select().from(passkey).where(eq(passkey.id, id))).length === 1

afterEach(() => {
  process.env.AUTH_SIGNUP_ENABLED = 'true'
  vi.restoreAllMocks()
})

describe('passkey settings', () => {
  test('the relying party is the address people open: PUBLIC_URL, else WEB_ORIGIN', () => {
    expect(passkeyRelyingParty({ PUBLIC_URL: 'https://app.linedesk.example', WEB_ORIGIN: 'http://web:5173' })).toEqual({
      rpID: 'app.linedesk.example',
      rpName: 'Linedesk',
      origin: 'https://app.linedesk.example',
    })
    expect(passkeyRelyingParty({ WEB_ORIGIN: 'http://signin.localhost:5128' })).toMatchObject({
      rpID: 'signin.localhost',
      origin: 'http://signin.localhost:5128',
    })
  })

  test('the sign-in page is told whether passkeys are on (default on, AUTH_PASSKEY_ENABLED=false turns them off)', () => {
    expect(readAuthConfig({}).methods.passkey).toBe(true)
    expect(readAuthConfig({ AUTH_PASSKEY_ENABLED: 'false' }).methods.passkey).toBe(false)
  })
})

describe('adding a passkey', () => {
  test('needs a session: nobody adds a passkey (or an account) without signing in first', async () => {
    expect((await authGet(anonymous, '/passkey/generate-register-options')).status).toBe(401)
    expect(
      (
        await authPost(anonymous, '/passkey/verify-registration', {
          response: { id: 'x', rawId: 'x', type: 'public-key', response: {} },
        })
      ).status,
    ).toBe(401)
  })

  test('a signed-in member gets options for their own account, bound to our relying party', async () => {
    const member = await verifiedSignUp(address('pk-add'))
    const res = await authGet(member, '/passkey/generate-register-options')
    expect(res.status).toBe(200)
    expect(res.body.rp).toEqual({ name: 'Linedesk', id: 'localhost' })
    expect(res.body.challenge).toEqual(expect.any(String))
    expect(res.body.authenticatorSelection).toBeDefined()
  })

  test('needs a recent sign-in', async () => {
    const member = await verifiedSignUp(address('pk-stale'))
    await ageSession(member)
    expect(await authGet(member, '/passkey/generate-register-options')).toMatchObject({
      status: 403,
      body: { code: 'SESSION_NOT_FRESH' },
    })
  })
})

describe('an address nobody has confirmed yet', () => {
  test('cannot add a passkey: one added by whoever signed up with it would survive the owner confirming it', async () => {
    const member = await signUp(address('pk-unverified'))
    for (const res of [
      await authGet(member, '/passkey/generate-register-options'),
      await authPost(member, '/passkey/verify-registration', { response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } }),
    ])
      expect(res).toMatchObject({ status: 403, body: { code: 'EMAIL_NOT_VERIFIED' } })
  })
})

describe('signing in with a passkey', () => {
  test('anyone may ask for a challenge; an unknown credential signs nobody in and creates nobody, also with sign-up closed', async () => {
    process.env.AUTH_SIGNUP_ENABLED = 'false'
    expect((await authGet(anonymous, '/passkey/generate-authenticate-options')).status).toBe(200)
    const res = await appRequest('/api/auth/passkey/verify-authentication', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ORIGIN, [FROM]: randomIp() },
      body: JSON.stringify({
        response: {
          id: 'unknown-credential',
          rawId: 'unknown-credential',
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON: '', authenticatorData: '', signature: '' },
        },
      }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    // No session: the endpoint only ever signs in the owner of a stored passkey; it has no way to create a user.
    expect(res.headers.getSetCookie().some(c => c.includes('session_token=') && !c.includes('Max-Age=0'))).toBe(false)
  })
})

describe('the passkey-first sign-in page (LIN-215)', () => {
  test('the challenge names no account: the page learns nothing about which addresses have a passkey', async () => {
    const member = await verifiedSignUp(address('enum'))
    await addPasskeyRow(member)
    const res = await authGet(anonymous, '/passkey/generate-authenticate-options')
    expect(res.status).toBe(200)
    // Discoverable credentials: the browser offers what it holds; the server lists none.
    expect(res.body.allowCredentials ?? []).toEqual([])
    expect(JSON.stringify(res.body)).not.toContain(member.userId)
  })

  test('one address may ask for at most PASSKEY_CHALLENGE_LIMIT challenges a minute', async () => {
    const ip = randomIp()
    const ask = () => request(anonymous, 'GET', `/api/auth${PASSKEY_CHALLENGE_PATH}`, undefined, { ...ORIGIN, [FROM]: ip })
    for (let i = 0; i < PASSKEY_CHALLENGE_LIMIT.max; i++) expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(429)
    // Another address is not held up.
    expect((await authGet(anonymous, PASSKEY_CHALLENGE_PATH)).status).toBe(200)
  })

  test('/v1/me says whether the signed-in member has a passkey (their own account only)', async () => {
    const { owner } = await createWorkspace('Passkey first')
    const { owner: other } = await createWorkspace('Passkey first, other')
    expect((await request(owner, 'GET', '/v1/me')).body.hasPasskey).toBe(false)
    await addPasskeyRow(owner)
    expect((await request(owner, 'GET', '/v1/me')).body.hasPasskey).toBe(true)
    expect((await request(other, 'GET', '/v1/me')).body.hasPasskey).toBe(false)
  })
})

describe('listing and removing passkeys', () => {
  test("lists only the member's own passkeys", async () => {
    const owner = await verifiedSignUp(address('pk-owner'))
    const stranger = await verifiedSignUp(address('pk-stranger'))
    const id = await addPasskeyRow(owner)
    expect((await authGet(owner, '/passkey/list-user-passkeys')).body.map((p: { id: string }) => p.id)).toEqual([id])
    expect((await authGet(stranger, '/passkey/list-user-passkeys')).body).toEqual([])
    expect((await authGet(anonymous, '/passkey/list-user-passkeys')).status).toBe(401)
  })

  test("removing needs a passkey sign-in and a recent session, and works only on the member's own passkey", async () => {
    const owner = await verifiedSignUp(address('pk-remove'))
    const stranger = await verifiedSignUp(address('pk-other'))
    const id = await addPasskeyRow(owner)

    expect((await authPost(anonymous, '/passkey/delete-passkey', { id })).status).toBe(401)
    expect((await authPost(stranger, '/passkey/delete-passkey', { id })).status).toBeGreaterThanOrEqual(400)
    expect(await passkeyExists(id)).toBe(true)

    // Signed in with the password only: the account has a passkey, so that is not enough.
    expect(await authPost(owner, '/passkey/delete-passkey', { id })).toMatchObject({
      status: 403,
      body: { code: PASSKEY_CONFIRMATION_REQUIRED },
    })
    await confirmWithPasskey(owner)
    await ageSession(owner)
    expect(await authPost(owner, '/passkey/delete-passkey', { id })).toMatchObject({
      status: 403,
      body: { code: 'SESSION_NOT_FRESH' },
    })
    expect(await passkeyExists(id)).toBe(true)

    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const fresh = await verifiedSignUp(address('pk-fresh'))
    const own = await addPasskeyRow(fresh)
    await confirmWithPasskey(fresh)
    expect((await authPost(fresh, '/passkey/delete-passkey', { id: own })).status).toBe(200)
    expect(await passkeyExists(own)).toBe(false)
    // The account is told, and the audit log has it; the refused attempts above are not there.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'A passkey was removed from your Linedesk account' }))
    const events = await db.select().from(auth_events).where(eq(auth_events.user_id, fresh.userId))
    expect(events.map(e => e.event)).toEqual(expect.arrayContaining(['sign_up', 'passkey_removed']))
    expect((await db.select().from(auth_events).where(eq(auth_events.user_id, owner.userId))).some(e => e.event === 'passkey_removed')).toBe(false)
  })
})

describe('once an account has a passkey, it guards the passkeys', () => {
  test('adding or renaming another one needs a session started by a passkey sign-in in the last 12 hours', async () => {
    const member = await verifiedSignUp(address('pk-second'))
    const id = await addPasskeyRow(member)
    for (const res of [
      await authGet(member, '/passkey/generate-register-options'),
      await authPost(member, '/passkey/verify-registration', { response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } }),
      await authPost(member, '/passkey/update-passkey', { id, name: 'Attacker' }),
    ])
      expect(res).toMatchObject({ status: 403, body: { code: PASSKEY_CONFIRMATION_REQUIRED } })

    await confirmWithPasskey(member, new Date(Date.now() - 13 * 3_600_000))
    expect((await authGet(member, '/passkey/generate-register-options')).body.code).toBe(PASSKEY_CONFIRMATION_REQUIRED)

    await confirmWithPasskey(member)
    expect((await authGet(member, '/passkey/generate-register-options')).status).toBe(200)
    expect((await authPost(member, '/passkey/update-passkey', { id, name: 'Work laptop' })).status).toBe(200)
  })

  test('the rule (unit): passkey first; an admin without one needs the enrolment code; others as before', () => {
    const now = Date.now()
    const session = { createdAt: new Date(now - 60_000) }
    const confirmed = { ...session, passkeyVerifiedAt: new Date(now - 3_600_000) }
    const account = (a: Partial<Parameters<typeof passkeyChangeRefusal>[0]>) => ({
      isAdmin: false, hasPasskey: false, enrolmentPending: false, enrolmentCodeValid: false, ...a,
    })
    const store = '/passkey/verify-registration'
    const options = '/passkey/generate-register-options'
    expect(passkeyChangeRefusal(account({ hasPasskey: true }), session, store, now)?.code).toBe(PASSKEY_CONFIRMATION_REQUIRED)
    expect(passkeyChangeRefusal(account({ isAdmin: true, hasPasskey: true, enrolmentCodeValid: true }), session, store, now)?.code).toBe(PASSKEY_CONFIRMATION_REQUIRED)
    expect(passkeyChangeRefusal(account({ isAdmin: true, hasPasskey: true }), confirmed, store, now)).toBeNull()
    expect(passkeyChangeRefusal(account({ isAdmin: true }), session, options, now)?.code).toBe(PASSKEY_ENROLMENT_REQUIRED)
    expect(passkeyChangeRefusal(account({ isAdmin: true, enrolmentPending: true }), session, options, now)).toBeNull()
    expect(passkeyChangeRefusal(account({ isAdmin: true, enrolmentPending: true }), session, store, now)?.code).toBe(PASSKEY_ENROLMENT_REQUIRED)
    expect(passkeyChangeRefusal(account({ isAdmin: true, enrolmentPending: true, enrolmentCodeValid: true }), session, store, now)).toBeNull()
    expect(passkeyChangeRefusal(account({}), session, store, now)).toBeNull()
  })

  test('a code works only as issued and until it expires', async () => {
    const member = await verifiedSignUp(address('pk-code'))
    const { enrolmentCode } = await issuePasskeyEnrolment(db, member.userId)
    const row = async () => (await db.select().from(user).where(eq(user.id, member.userId)))[0]!
    expect(enrolmentCodeValid(await row(), enrolmentCode)).toBe(true)
    expect(enrolmentCodeValid(await row(), `${enrolmentCode}x`)).toBe(false)
    expect(enrolmentCodeValid(await row(), '')).toBe(false)
    expect(enrolmentCodeValid(await row(), enrolmentCode, Date.now() + 25 * 3_600_000)).toBe(false)
    // Only the hash is stored.
    expect(JSON.stringify(await row())).not.toContain(enrolmentCode)
  })
})

describe('emails about passkeys', () => {
  test('a passkey added: the account is told and an enrolment code is used up', async () => {
    const send = vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
    const member = await verifiedSignUp(address('pk-added'))
    await issuePasskeyEnrolment(db, member.userId)
    const [account] = await db.select().from(user).where(eq(user.id, member.userId))
    const ctx = { path: '/passkey/verify-registration', context: { returned: { id: 'pk' }, session: { user: { id: member.userId, email: account!.email } } } }
    await notifyPasskeyChange(ctx as unknown as Parameters<typeof notifyPasskeyChange>[0])
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: account!.email,
        subject: 'A passkey was added to your Linedesk account',
        text: expect.stringContaining('Reset passkeys'),
      }),
    )
    expect((await db.select().from(user).where(eq(user.id, member.userId)))[0]!.passkeyEnrolmentHash).toBeNull()
  })

})
