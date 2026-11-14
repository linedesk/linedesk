// First start of an install: nobody has an account yet. The API prints a one-time setup code to its
// log; whoever enters it on the sign-in page (Login.tsx shows the setup form while `setupNeeded`)
// becomes the first instance admin. Reading the log needs access to the server, so the code proves
// what INSTANCE_ADMIN_EMAILS proves otherwise: this is the operator. That person's address counts as
// confirmed, as with `user:create --admin` (instance-admin.ts): there may be no email set up yet. For the same reason
// they get their passkey enrolment code at once (what `user:passkeys --enrol` would print): email and sign-in need a
// passkey, and the first admin has nobody to ask for the code.
//
// The code stays the same across restarts (dev reloads, container restarts) for 7 days, so a restart in the middle of
// the first run does not take it away from the operator. It is kept in instance_settings as it is printed, not hashed:
// it has to be printed again, and whoever can read that table can make an admin there directly anyway. It is deleted
// once an account exists. `node apps/api/src/setup-code.ts` prints it again; `--new` replaces it.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { account, type Db, instance_settings, type Tx, user } from '@linedesk/db'
import { hashPassword } from 'better-auth/crypto'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { adminSecondFactorRequired } from './admin-second-factor.ts'
import { issuePasskeyEnrolment, type PasskeyEnrolment } from './passkey-enrolment.ts'
import { createFailureLimiter } from './rate-limit.ts'

const CODE_KEY = 'setup.code'
/** Before codes outlived a restart only their hash was kept: such a row cannot be printed again, so it goes. */
const OLD_HASH_KEY = 'setup.code_sha256'
/** How long one code lasts; a start after that prints a new one. */
export const SETUP_CODE_LIFETIME_MS = 7 * 24 * 3_600_000
/**
 * Wrong codes: 5 per address and 20 in all per 15 minutes, then the endpoint waits. The code itself
 * stays (a new one only after 7 days or from the server's shell), so nobody can rotate it away from the
 * operator; 40 bits at this rate take far longer than anyone waits.
 */
const wrongPerAddress = createFailureLimiter({ max: 5, windowMs: 15 * 60_000 })
const wrongInAll = createFailureLimiter({ max: 20, windowMs: 15 * 60_000 })
const ALL = 'all'
/** Unambiguous letters and digits: no 0/O, 1/I/L. 8 of them: about 40 bits. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const sha256 = (code: string) => createHash('sha256').update(code).digest('hex')
const normalise = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

export const setupNeeded = async (tx: Pick<Tx, 'select'>) => !(await tx.select({ id: user.id }).from(user).limit(1))[0]

/** Where the web app is: PUBLIC_URL on a server, WEB_ORIGIN (Vite's address) under pnpm dev; auth.ts's default. */
const webAddress = () => process.env.PUBLIC_URL || process.env.WEB_ORIGIN || 'http://localhost:5173'

/** Where the setup code is printed, said the same way here and on the setup page (Login.tsx). */
const WHERE_THE_CODE_IS = "the API's log (docker compose logs api, or the terminal running pnpm dev)"

const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
const expiresAt = (issuedAt: string) => new Date(Date.parse(issuedAt) + SETUP_CODE_LIFETIME_MS)
const cutoff = () => new Date(Date.now() - SETUP_CODE_LIFETIME_MS).toISOString()

/**
 * On an install without users: prints the setup code, the same one at every start until it is 7 days old (then a new
 * one). `fresh` replaces it at once (setup-code.ts --new). Once an account exists it removes any code left and returns null.
 */
export async function issueSetupCode(
  tx: Pick<Tx, 'select' | 'insert' | 'delete'>,
  { fresh = false, publicUrl = webAddress() }: { fresh?: boolean; publicUrl?: string } = {},
) {
  if (!(await setupNeeded(tx))) {
    await tx.delete(instance_settings).where(inArray(instance_settings.key, [CODE_KEY, OLD_HASH_KEY]))
    return null
  }
  await tx.delete(instance_settings).where(eq(instance_settings.key, OLD_HASH_KEY))
  await tx
    .delete(instance_settings)
    .where(
      fresh
        ? eq(instance_settings.key, CODE_KEY)
        : and(eq(instance_settings.key, CODE_KEY), lt(instance_settings.updated_at, cutoff())),
    )
  // Two APIs starting at once: the first insert wins and both print that code.
  await tx
    .insert(instance_settings)
    .values({ key: CODE_KEY, value: newCode(), updated_at: new Date().toISOString() })
    .onConflictDoNothing({ target: instance_settings.key })
  const [stored] = await tx.select().from(instance_settings).where(eq(instance_settings.key, CODE_KEY))
  if (!stored) return null
  const code = stored.value
  const until = expiresAt(stored.updated_at)
  const shown = `${code.slice(0, 4)}-${code.slice(4)}`
  console.log(
    `\n  Linedesk has no admin yet. Open ${publicUrl} and enter this setup code:\n\n      ${shown}\n\n  It works once and stays the same across restarts until ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC.\n`,
  )
  return { code: shown, expiresAt: until.toISOString() }
}

export const setupInput = z.object({
  code: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12, 'use at least 12 characters').max(256),
})
export type SetupInput = z.infer<typeof setupInput>

export class SetupError extends Error {
  readonly status: 403 | 409 | 429
  constructor(message: string, status: 403 | 409 | 429) {
    super(message)
    this.status = status
  }
}

const newId = () => crypto.randomUUID().replaceAll('-', '')

/** Checks the code and creates the first instance admin, with the password they chose, and their passkey enrolment code. */
export async function completeSetup(db: Db, input: SetupInput, clientIp: string | null) {
  const address = clientIp ?? 'unknown'
  if (wrongPerAddress.blocked(address) || wrongInAll.blocked(ALL))
    throw new SetupError('Too many wrong codes. Wait 15 minutes, then try again.', 429)
  // Cheap checks first: an install that is set up, or a wrong code, costs no password hash.
  if (!(await setupNeeded(db))) throw new SetupError('This install is set up already. Sign in instead.', 409)
  if (!(await codeMatches(db, input.code))) {
    wrongPerAddress.fail(address)
    wrongInAll.fail(ALL)
    throw new SetupError(`That setup code is not right. It is in ${WHERE_THE_CODE_IS}.`, 403)
  }
  const hashed = await hashPassword(input.password)
  return db.transaction(async tx => {
    // One setup at a time: the second waits here and then finds a user.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('linedesk.setup'))`)
    if (!(await setupNeeded(tx))) throw new SetupError('This install is set up already. Sign in instead.', 409)
    if (!(await codeMatches(tx, input.code))) throw new SetupError('That setup code was used already.', 409)
    const id = newId()
    await tx.insert(user).values({ id, name: input.name, email: input.email, emailVerified: true, instanceAdmin: true })
    await tx
      .insert(account)
      .values({ id: newId(), accountId: id, providerId: 'credential', userId: id, password: hashed })
    await tx.delete(instance_settings).where(eq(instance_settings.key, CODE_KEY))
    const enrolment: PasskeyEnrolment | null = adminSecondFactorRequired() ? await issuePasskeyEnrolment(tx, id) : null
    console.log(`First instance admin created with the setup code: ${input.email}`)
    return { userId: id, enrolment }
  })
}

/**
 * The first admin is signed in right after setup (app.ts): that sign-in is not one to warn about, the account is
 * seconds old and its only admin is the person signing in (admin-alerts.ts skips it). In memory, one request long.
 */
const setupSignIns = new Set<string>()
export const markSetupSignIn = (userId: string) => void setupSignIns.add(userId)
/** True once for a sign-in marked by markSetupSignIn; forgets it. */
export const takeSetupSignIn = (userId: string) => setupSignIns.delete(userId)

async function codeMatches(tx: Pick<Tx, 'select'>, code: string) {
  const [stored] = await tx.select().from(instance_settings).where(eq(instance_settings.key, CODE_KEY))
  if (!stored || expiresAt(stored.updated_at).getTime() <= Date.now()) return false
  // Hashes of both: the same length whatever was typed, so the comparison takes the same time.
  return timingSafeEqual(Buffer.from(sha256(normalise(code)), 'hex'), Buffer.from(sha256(stored.value), 'hex'))
}
