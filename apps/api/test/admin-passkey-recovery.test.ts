// Recovery when an admin has no passkey (Server admin needs one, admin-second-factor.ts): the CLI's codes
// (user-passkeys.ts) and the codes the API prints at start for every admin without one (admin-passkey-codes.ts).
// In INSTANCE_WIDE_FILES: it reads every instance admin of the database.
import { passkey, session, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { printMissingAdminEnrolments } from '../src/admin-passkey-codes.ts'
import { db } from '../src/db.ts'
import { emailSender } from '../src/email.ts'
import { passkeysCommand } from '../src/user-passkeys.ts'
import { request, signUp, type User } from './helpers.ts'

async function newAdmin() {
  const admin = await signUp()
  await db.update(user).set({ emailVerified: true, instanceAdmin: true }).where(eq(user.id, admin.userId))
  return admin
}
const emailOf = async (who: User) => (await db.select().from(user).where(eq(user.id, who.userId)))[0]!.email
const addPasskey = (who: User) =>
  db.insert(passkey).values({
    id: `pk_${crypto.randomUUID().slice(0, 12)}`,
    userId: who.userId,
    publicKey: 'cHVibGlj',
    credentialID: `cred-${crypto.randomUUID()}`,
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
  })
const codeIn = (lines: string[]) => lines.join('\n').match(/\n {2}(\S+)\n/)?.[1]

beforeEach(() => {
  process.env.ADMIN_SECOND_FACTOR = 'on'
  vi.spyOn(emailSender, 'send').mockResolvedValue(undefined)
})
afterEach(() => {
  process.env.ADMIN_SECOND_FACTOR = 'off'
  vi.restoreAllMocks()
})

describe('the recovery CLI (user-passkeys.ts)', () => {
  test('--enrol prints a one-time code for an admin without a passkey; nothing else ends', async () => {
    const admin = await newAdmin()
    const email = await emailOf(admin)
    const lines: string[] = []
    await passkeysCommand(['--enrol', '--email', email.toUpperCase()], l => lines.push(l))
    expect(codeIn(lines)).toMatch(/\S{8,}/)
    expect(lines.join('\n')).toContain(`Passkey enrolment code for ${email}`)
    expect(lines.join('\n')).toMatch(/Nothing else changed/)
    expect(await db.select().from(session).where(eq(session.userId, admin.userId))).not.toEqual([])
    // /v1/me then says the admin enrols with that code.
    expect((await request(admin, 'GET', '/v1/me')).body).toMatchObject({
      adminSecondFactor: 'enrol',
      passkeyEnrolment: true,
    })
  })

  test('--remove resets a lost passkey: signs the admin out everywhere and prints the code for the new one', async () => {
    const admin = await newAdmin()
    await addPasskey(admin)
    const email = await emailOf(admin)
    // With a passkey, --enrol is refused and says to reset.
    await expect(passkeysCommand(['--enrol', '--email', email], () => {})).rejects.toThrow(/--remove/)
    const lines: string[] = []
    await passkeysCommand(['--remove', '--email', email], l => lines.push(l))
    expect(lines.join('\n')).toMatch(/Removed 1 passkey of .*, ended 1 session/)
    expect(codeIn(lines)).toMatch(/\S{8,}/)
    expect(await db.select().from(passkey).where(eq(passkey.userId, admin.userId))).toEqual([])
    expect(await db.select().from(session).where(eq(session.userId, admin.userId))).toEqual([])
  })

  test('refuses what it cannot do, saying why', async () => {
    await expect(passkeysCommand(['--email', 'x@linedesk.test'], () => {})).rejects.toThrow(/Usage/)
    await expect(passkeysCommand(['--enrol', '--email', 'nobody@linedesk.test'], () => {})).rejects.toThrow(
      /No account/,
    )
    const plain = await signUp()
    await expect(passkeysCommand(['--enrol', '--email', await emailOf(plain)], () => {})).rejects.toThrow(
      /not an instance admin/,
    )
  })
})

describe('codes in the log at start (admin-passkey-codes.ts)', () => {
  test('one code per enabled admin without a passkey and without a working code; never a second one', async () => {
    const without = await newAdmin()
    const withPasskey = await newAdmin()
    await addPasskey(withPasskey)
    const disabled = await newAdmin()
    await db.update(user).set({ disabledAt: new Date() }).where(eq(user.id, disabled.userId))
    const lines: string[] = []
    const printed = await printMissingAdminEnrolments(l => lines.push(l))
    expect(printed).toContain(await emailOf(without))
    expect(printed).not.toContain(await emailOf(withPasskey))
    expect(printed).not.toContain(await emailOf(disabled))
    expect(lines.join('\n')).toMatch(/Server admin needs a passkey/)
    // The next start leaves the code someone may already have alone.
    expect(await printMissingAdminEnrolments(() => {})).not.toContain(await emailOf(without))
  })

  test('nothing while the passkey rule is off', async () => {
    await newAdmin()
    process.env.ADMIN_SECOND_FACTOR = 'off'
    expect(await printMissingAdminEnrolments(() => {})).toEqual([])
  })

  test('nothing, and no email, while passkeys are off as a sign-in method: the start warns instead', async () => {
    const without = await newAdmin()
    const send = vi.mocked(emailSender.send)
    send.mockClear()
    process.env.AUTH_PASSKEY_ENABLED = 'false'
    try {
      const lines: string[] = []
      expect(await printMissingAdminEnrolments(l => lines.push(l))).toEqual([])
      expect(lines).toEqual([])
      expect(send).not.toHaveBeenCalled()
      const [account] = await db.select().from(user).where(eq(user.id, without.userId))
      expect(account!.passkeyEnrolmentHash ?? null).toBeNull()
    } finally {
      delete process.env.AUTH_PASSKEY_ENABLED
    }
    expect(await printMissingAdminEnrolments(() => {})).toContain(await emailOf(without))
  })
})
