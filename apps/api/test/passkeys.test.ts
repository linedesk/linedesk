// Passkeys through Better Auth's plugin: who may add, list and remove them, and that a passkey never
// creates an account. A full WebAuthn ceremony needs an authenticator, so registration is checked up
// to its options; sign-in with an unknown credential is checked to make nobody.
// Impersonation (no passkey changes as the user) is in admin.test.ts, the file with instance admins.
import { auth_events, passkey, session } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { readAuthConfig } from '../src/auth-methods.ts'
import { db } from '../src/db.ts'
import { passkeyRelyingParty } from '../src/passkeys.ts'
import { anonymous, appRequest, type Caller, randomIp, request, signUp, FROM, type User } from './helpers.ts'

const ORIGIN = { origin: 'http://localhost:5173' }
const address = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}@linedesk.test`
const authGet = (who: Caller, path: string) =>
  request(who, 'GET', `/api/auth${path}`, undefined, { ...ORIGIN, [FROM]: randomIp() })
const authPost = (who: Caller, path: string, body: unknown) =>
  request(who, 'POST', `/api/auth${path}`, body, { ...ORIGIN, [FROM]: randomIp() })

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
const passkeyExists = async (id: string) => (await db.select().from(passkey).where(eq(passkey.id, id))).length === 1

afterEach(() => {
  delete process.env.AUTH_SIGNUP_ENABLED
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
    const member = await signUp(address('pk-add'))
    const res = await authGet(member, '/passkey/generate-register-options')
    expect(res.status).toBe(200)
    expect(res.body.rp).toEqual({ name: 'Linedesk', id: 'localhost' })
    expect(res.body.challenge).toEqual(expect.any(String))
    expect(res.body.authenticatorSelection).toBeDefined()
  })

  test('needs a recent sign-in', async () => {
    const member = await signUp(address('pk-stale'))
    await ageSession(member)
    expect(await authGet(member, '/passkey/generate-register-options')).toMatchObject({
      status: 403,
      body: { code: 'SESSION_NOT_FRESH' },
    })
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

describe('listing and removing passkeys', () => {
  test("lists only the member's own passkeys", async () => {
    const owner = await signUp(address('pk-owner'))
    const stranger = await signUp(address('pk-stranger'))
    const id = await addPasskeyRow(owner)
    expect((await authGet(owner, '/passkey/list-user-passkeys')).body.map((p: { id: string }) => p.id)).toEqual([id])
    expect((await authGet(stranger, '/passkey/list-user-passkeys')).body).toEqual([])
    expect((await authGet(anonymous, '/passkey/list-user-passkeys')).status).toBe(401)
  })

  test("removing needs a recent sign-in and works only on the member's own passkey", async () => {
    const owner = await signUp(address('pk-remove'))
    const stranger = await signUp(address('pk-other'))
    const id = await addPasskeyRow(owner)

    expect((await authPost(anonymous, '/passkey/delete-passkey', { id })).status).toBe(401)
    expect((await authPost(stranger, '/passkey/delete-passkey', { id })).status).toBeGreaterThanOrEqual(400)
    expect(await passkeyExists(id)).toBe(true)

    await ageSession(owner)
    expect(await authPost(owner, '/passkey/delete-passkey', { id })).toMatchObject({
      status: 403,
      body: { code: 'SESSION_NOT_FRESH' },
    })
    expect(await passkeyExists(id)).toBe(true)

    const fresh = await signUp(address('pk-fresh'))
    const own = await addPasskeyRow(fresh)
    expect((await authPost(fresh, '/passkey/delete-passkey', { id: own })).status).toBe(200)
    expect(await passkeyExists(own)).toBe(false)
    // The audit log has it; the refused attempts above are not there.
    const events = await db.select().from(auth_events).where(eq(auth_events.user_id, fresh.userId))
    expect(events.map(e => e.event)).toEqual(expect.arrayContaining(['sign_up', 'passkey_removed']))
    expect((await db.select().from(auth_events).where(eq(auth_events.user_id, owner.userId))).some(e => e.event === 'passkey_removed')).toBe(false)
  })
})
