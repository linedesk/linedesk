// First start of an install: nobody has an account yet. The API prints a one-time setup code to its
// log; whoever enters it on the sign-in page (Login.tsx shows the setup form while `setupNeeded`)
// becomes the first instance admin. Reading the log needs access to the server, so the code proves
// what INSTANCE_ADMIN_EMAILS proves otherwise: this is the operator. That person's address counts as
// confirmed, as with `user:create --admin` (instance-admin.ts): there may be no email set up yet.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { account, type Db, instance_settings, type Tx, user } from '@linedesk/db'
import { hashPassword } from 'better-auth/crypto'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { createFailureLimiter } from './rate-limit.ts'

const CODE_KEY = 'setup.code_sha256'
/**
 * Wrong codes: 5 per address and 20 in all per 15 minutes, then the endpoint waits. The code itself
 * stays (a new one only at the next start), so nobody can rotate it away from the operator; 40 bits
 * at this rate take far longer than anyone waits.
 */
const wrongPerAddress = createFailureLimiter({ max: 5, windowMs: 15 * 60_000 })
const wrongInAll = createFailureLimiter({ max: 20, windowMs: 15 * 60_000 })
const ALL = 'all'
/** Unambiguous letters and digits: no 0/O, 1/I/L. 8 of them: about 40 bits. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

const sha256 = (code: string) => createHash('sha256').update(code).digest('hex')
const normalise = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

export const setupNeeded = async (tx: Pick<Tx, 'select'>) =>
  !(await tx.select({ id: user.id }).from(user).limit(1))[0]

/** On an install without users: makes a new setup code, stores its hash and prints it. */
export async function issueSetupCode(tx: Tx, publicUrl = process.env.PUBLIC_URL || 'http://localhost') {
  if (!(await setupNeeded(tx))) return
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
  const now = new Date().toISOString()
  await tx
    .insert(instance_settings)
    .values({ key: CODE_KEY, value: sha256(code), updated_at: now })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value: sha256(code), updated_at: now } })
  const shown = `${code.slice(0, 4)}-${code.slice(4)}`
  console.log(
    `\n  Linedesk has no admin yet. Open ${publicUrl} and enter this setup code:\n\n      ${shown}\n\n  It works once; a restart makes a new one.\n`,
  )
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

/** Checks the code and creates the first instance admin, with the password they chose. */
export async function completeSetup(db: Db, input: SetupInput, clientIp: string | null) {
  const address = clientIp ?? 'unknown'
  if (wrongPerAddress.blocked(address) || wrongInAll.blocked(ALL))
    throw new SetupError('Too many wrong codes. Wait 15 minutes, then try again.', 429)
  // Cheap checks first: an install that is set up, or a wrong code, costs no password hash.
  if (!(await setupNeeded(db))) throw new SetupError('This install is set up already. Sign in instead.', 409)
  if (!(await codeMatches(db, input.code))) {
    wrongPerAddress.fail(address)
    wrongInAll.fail(ALL)
    throw new SetupError('That setup code is not right. It is in the server log (docker compose logs api).', 403)
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
    console.log(`First instance admin created with the setup code: ${input.email}`)
    return { userId: id }
  })
}

async function codeMatches(tx: Pick<Tx, 'select'>, code: string) {
  const [stored] = await tx.select().from(instance_settings).where(eq(instance_settings.key, CODE_KEY))
  if (!stored) return false
  return timingSafeEqual(Buffer.from(sha256(normalise(code)), 'hex'), Buffer.from(stored.value, 'hex'))
}
