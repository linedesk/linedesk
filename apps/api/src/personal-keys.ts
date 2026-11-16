// Personal API keys (LIN-339, decision 2026-11-16): a key a person makes for themselves, for the `linedesk` CLI, MCP
// clients and scripts. It acts exactly as its maker does today (context.ts personActor): every workspace they belong
// to (x-workspace-id picks one, else their first), their role there, read only in a disabled one, and instance:admin
// when they are an instance admin and made the key in a session that passed the passkey check (as a session gets it).
// No session: what needs a fresh sign-in, a passkey or a browser is refused (PERSONAL_KEY_REFUSED, run-action.ts).
// Stored as a SHA-256 hash (the key has 256 random bits); the same per-address and per-key limits as workspace keys.
import { createHash, randomBytes } from 'node:crypto'
import {
  PERSONAL_KEY_PREFIX,
  type PersonalKeyCreated,
  type PersonalKeyListData,
  type Permission,
} from '@linedesk/actions'
import { personal_keys, user } from '@linedesk/db'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { adminSecondFactorRequired } from './admin-second-factor.ts'
import { mustConfirmEmail } from './auth-methods.ts'
import { noteRefusedKey, noteWorkingKey, tooManyInvalidApiKeys, workedRecently } from './api-keys.ts'
import { type Actor, personActor } from './context.ts'
import { db } from './db.ts'
import { type Handler, Forbidden, Reject } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'

/** Shown in lists to tell keys apart: the prefix and 8 characters of the key. */
const SHOWN_LENGTH = PERSONAL_KEY_PREFIX.length + 8
/** last_used_at is written at most this often per key. */
const LAST_USED_EVERY_MS = 60_000
/** Keys one person may have that are not revoked. */
export const PERSONAL_KEYS_MAX = 25

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')
const newKey = () => `${PERSONAL_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
const newId = () => `pkey_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

export const isPersonalKey = (bearer: string) => bearer.startsWith(PERSONAL_KEY_PREFIX)
const WELL_FORMED_KEY = new RegExp(`^${PERSONAL_KEY_PREFIX}[A-Za-z0-9_-]{43}$`)

/**
 * The actor for a Bearer personal key, or null when the key is unknown or revoked, or its maker's account is gone or
 * disabled. Worked out on every request from the maker's account as it is now: a role change, a removal from a
 * workspace or a lost instance-admin flag apply to the key at once. `requested` is the workspace the request names.
 */
export async function actorForPersonalKey(
  key: string,
  ip: string | null,
  requested: string | null,
): Promise<Actor | null> {
  const hash = hashKey(key)
  // From an address with too many refused keys, only a key that worked lately is looked up (api-keys.ts).
  if (tooManyInvalidApiKeys(ip) && !(WELL_FORMED_KEY.test(key) && workedRecently(hash))) return null
  const [found] = await db
    .select({ row: personal_keys, account: user })
    .from(personal_keys)
    .innerJoin(user, eq(user.id, personal_keys.user_id))
    .where(and(eq(personal_keys.key_hash, hash), isNull(personal_keys.revoked_at)))
  if (!found || found.account.disabledAt) {
    noteRefusedKey(ip)
    return null
  }
  const { row, account } = found
  // Server admin as a session has it: where the install asks for the passkey check, only with it, which a key carries
  // from the session it was made in (until revoked). Without it the key is refused as such a session is ('confirm').
  const admin = isInstanceAdmin(account)
  const adminConfirmed = admin && row.passkey_confirmed
  const adminOpen = admin && (adminConfirmed || !adminSecondFactorRequired())
  const extraPermissions: Permission[] = admin
    ? adminOpen
      ? ['instance:admin', 'setupLink:end']
      : ['setupLink:end']
    : []
  const actor = await personActor(account.id, requested, extraPermissions, [], {
    personalKeyId: row.id,
    ...(adminConfirmed ? { passkeyConfirmed: true as const } : {}),
    ...(admin && !adminOpen ? { adminSecondFactor: 'confirm' as const } : {}),
    ...(mustConfirmEmail(account.emailVerified) ? { emailUnverified: true as const } : {}),
  })
  if (!actor) {
    noteRefusedKey(ip)
    return null
  }
  noteWorkingKey(hash)
  const now = Date.now()
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > LAST_USED_EVERY_MS) {
    void db
      .update(personal_keys)
      .set({ last_used_at: new Date(now).toISOString() })
      .where(eq(personal_keys.id, row.id))
      .catch(e =>
        console.error(`could not note the use of personal key ${row.id}: ${e instanceof Error ? e.message : e}`),
      )
  }
  return actor
}

/**
 * Only the person, signed in as themselves, manages their keys: never a key (it has no account:own either), never an
 * instance admin signed in as them, never a setup link.
 */
function refuseNonPerson(actor: Actor): string {
  if (
    actor.personalKeyId ||
    actor.apiKeyId ||
    actor.setupKeyId ||
    actor.callId ||
    actor.role === 'agent' ||
    !actor.sessionId
  )
    throw new Forbidden('personal API keys are managed in the app, signed in as yourself')
  if (actor.impersonation) throw new Forbidden('not while signed in as someone else')
  return actor.actorId
}

export const personalKeyHandlers: Record<string, Handler> = {
  'personalKey.create': async ({ tx, actor }, input: { name: string }) => {
    const userId = refuseNonPerson(actor)
    // One create at a time per person, so two at once cannot both pass the count.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`personal_keys:${userId}`}))`)
    const open = await tx
      .select({ id: personal_keys.id })
      .from(personal_keys)
      .where(and(eq(personal_keys.user_id, userId), isNull(personal_keys.revoked_at)))
    if (open.length >= PERSONAL_KEYS_MAX)
      throw new Reject(`at most ${PERSONAL_KEYS_MAX} personal keys: revoke one first`)
    const key = newKey()
    const [row] = await tx
      .insert(personal_keys)
      .values({
        id: newId(),
        user_id: userId,
        name: input.name,
        prefix: key.slice(0, SHOWN_LENGTH),
        key_hash: hashKey(key),
        // Only an instance admin's key carries the check: a passkey sign-in before becoming one gives a key nothing.
        passkey_confirmed: actor.passkeyConfirmed === true && actor.permissions.includes('instance:admin'),
      })
      .returning()
    const data: PersonalKeyCreated = { personalKeyId: row!.id, key, prefix: row!.prefix }
    return { rows: {}, data }
  },

  'personalKey.list': async ({ tx, actor }) => {
    const userId = refuseNonPerson(actor)
    const rows = await tx
      .select({
        id: personal_keys.id,
        name: personal_keys.name,
        prefix: personal_keys.prefix,
        passkey_confirmed: personal_keys.passkey_confirmed,
        created_at: personal_keys.created_at,
        last_used_at: personal_keys.last_used_at,
        revoked_at: personal_keys.revoked_at,
      })
      .from(personal_keys)
      .where(eq(personal_keys.user_id, userId))
      .orderBy(desc(personal_keys.created_at))
    const data: PersonalKeyListData = { keys: rows }
    return { rows: {}, data }
  },

  'personalKey.revoke': async ({ tx, actor, now }, input: { personalKeyId: string }) => {
    const userId = refuseNonPerson(actor)
    const [row] = await tx
      .update(personal_keys)
      .set({ revoked_at: now })
      .where(
        and(
          eq(personal_keys.id, input.personalKeyId),
          eq(personal_keys.user_id, userId),
          isNull(personal_keys.revoked_at),
        ),
      )
      .returning({ id: personal_keys.id })
    if (!row) throw new Reject('personal key not found')
    return { rows: {}, data: { personalKeyId: row.id } }
  },
}
