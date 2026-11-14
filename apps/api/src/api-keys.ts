// Workspace API keys: created and revoked through the registry, stored as a SHA-256 hash (the key
// has 256 random bits, so a fast hash is enough), resolved to an actor for Bearer requests.
import { createHash, randomBytes } from 'node:crypto'
import { API_KEY_PREFIX, type ApiKeyCreated, type ApiKeyListData, rolePermissions, teamRoles } from '@linedesk/actions'
import { api_keys, member, organization, user } from '@linedesk/db'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { mustConfirmEmail } from './auth-methods.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { addressBucket } from './client-ip.ts'
import { type Handler, Forbidden, Reject } from './handler-context.ts'
import { createFailureLimiter, createRateLimiter } from './rate-limit.ts'

/** Shown in lists to tell keys apart: the prefix and 8 characters of the key. */
const SHOWN_LENGTH = API_KEY_PREFIX.length + 8
/** last_used_at is written at most this often per key. */
const LAST_USED_EVERY_MS = 60_000
/** Requests per key and minute, across every endpoint the key reaches. */
export const API_KEY_REQUESTS_PER_MINUTE = 300

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex')
const newKey = () => `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
const newId = () => `key_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

export const isApiKey = (bearer: string) => bearer.startsWith(API_KEY_PREFIX)
/** The shape every issued key has (newKey): the prefix and 32 bytes in base64url. */
const WELL_FORMED_KEY = new RegExp(`^${API_KEY_PREFIX}[A-Za-z0-9_-]{43}$`)
export const isWellFormedApiKey = (key: string) => WELL_FORMED_KEY.test(key)

const allowRequest = createRateLimiter({ max: API_KEY_REQUESTS_PER_MINUTE, windowMs: 60_000 })
/** Whether a key may make another request now (per key, sliding minute). */
export const apiKeyWithinLimit = (apiKeyId: string) => allowRequest(apiKeyId)

/** Refused keys per client address in INVALID_API_KEY_WINDOW_MS; then only well-formed keys are looked up from it until they age out. */
export const INVALID_API_KEYS_PER_IP = 20
export const INVALID_API_KEY_WINDOW_MS = 10 * 60_000
const invalidKeys = createFailureLimiter({ max: INVALID_API_KEYS_PER_IP, windowMs: INVALID_API_KEY_WINDOW_MS })
/** IPv6 counts per /64 (client-ip.ts). */
const ipBucket = addressBucket
/** Too many refused keys came from this address lately: refused keys from it answer 429. */
export const tooManyInvalidApiKeys = (ip: string | null) => invalidKeys.blocked(ipBucket(ip))

/** How long a key that worked stays known, so a throttled address can still use it. */
export const RECENT_KEY_MS = 24 * 60 * 60_000
const RECENT_KEYS_MAX = 10_000
/** Hashes of keys that worked lately, oldest first (a Map keeps insertion order). In memory, like the limiters. */
const recentKeys = new Map<string, number>()
function noteWorkingKey(hash: string) {
  recentKeys.delete(hash)
  recentKeys.set(hash, Date.now())
  if (recentKeys.size > RECENT_KEYS_MAX) recentKeys.delete(recentKeys.keys().next().value!)
}
const workedRecently = (hash: string) => Date.now() - (recentKeys.get(hash) ?? 0) < RECENT_KEY_MS

/** A key is as strong as its creator today: still a member, not disabled, with at least the key's role. */
const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 }
const creatorStillAllows = (keyRole: string, creatorRole: string | null, creatorDisabled: Date | null) =>
  creatorRole !== null && !creatorDisabled && (ROLE_RANK[creatorRole] ?? 0) >= ROLE_RANK[keyRole]!

/** Key management is for people: a key never creates, lists or revokes keys. */
function refuseKeyActor(actor: Actor) {
  if (actor.apiKeyId) throw new Forbidden('API keys cannot manage API keys: do it in Workspace settings, Developers')
  if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
  if (!actor.workspaceId) throw new Reject('no workspace')
  return actor.workspaceId
}

/**
 * The actor for a Bearer API key, or null when the key is unknown or revoked, its workspace is gone
 * or disabled, or the member who created it was removed, disabled or now has a lower role than the
 * key. Permissions are the key's role's, never an owner's and never the team's (team:write); key
 * management refuses keys in its handlers. A refused key counts against the client's address. From
 * an address with too many, only a key that worked in the last RECENT_KEY_MS is looked up: a working
 * integration behind a shared address is not locked out by another host, and random keys from the
 * address cost no database query.
 */
export async function actorForApiKey(key: string, ip: string | null): Promise<Actor | null> {
  const hash = hashApiKey(key)
  if (tooManyInvalidApiKeys(ip) && !(isWellFormedApiKey(key) && workedRecently(hash))) return null
  const [found] = await db
    .select({ row: api_keys, workspaceDisabled: organization.disabledAt, creatorRole: member.role, creatorDisabled: user.disabledAt, creatorEmailVerified: user.emailVerified })
    .from(api_keys)
    .innerJoin(organization, eq(organization.id, api_keys.workspace_id))
    .leftJoin(member, and(eq(member.organizationId, api_keys.workspace_id), eq(member.userId, api_keys.created_by)))
    .leftJoin(user, eq(user.id, api_keys.created_by))
    .where(and(eq(api_keys.key_hash, hash), isNull(api_keys.revoked_at)))
  // A key carries a team role; any other stored role ("agent") never maps to its permissions.
  const teamRole = !!found && (teamRoles as readonly string[]).includes(found.row.role)
  if (!found || !teamRole || found.workspaceDisabled || !creatorStillAllows(found.row.role, found.creatorRole, found.creatorDisabled)) {
    invalidKeys.fail(ipBucket(ip))
    return null
  }
  noteWorkingKey(hash)
  const { row } = found
  const now = Date.now()
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > LAST_USED_EVERY_MS) {
    void db.update(api_keys).set({ last_used_at: new Date(now).toISOString() }).where(eq(api_keys.id, row.id))
      .catch(e => console.error(`could not note the use of API key ${row.id}: ${e instanceof Error ? e.message : e}`))
  }
  return {
    actorId: `apikey:${row.id}`,
    role: row.role,
    workspaceId: row.workspace_id,
    permissions: rolePermissions[row.role].filter(p => p !== 'team:write'),
    apiKeyId: row.id,
    ...(mustConfirmEmail(found.creatorEmailVerified) ? { emailUnverified: true as const } : {}),
  }
}

export const apiKeyHandlers: Record<string, Handler> = {
  'apiKey.create': async ({ tx, actor }, input: { name: string; role: 'member' | 'admin' }) => {
    const workspace_id = refuseKeyActor(actor)
    const key = newKey()
    const [row] = await tx.insert(api_keys).values({
      id: newId(), workspace_id, name: input.name, prefix: key.slice(0, SHOWN_LENGTH), key_hash: hashApiKey(key), role: input.role, created_by: actor.actorId,
    }).returning()
    const data: ApiKeyCreated = { apiKeyId: row!.id, key, prefix: row!.prefix }
    return { rows: {}, data }
  },

  'apiKey.list': async ({ tx, actor }) => {
    const workspace_id = refuseKeyActor(actor)
    const rows = await tx.select().from(api_keys).where(eq(api_keys.workspace_id, workspace_id)).orderBy(desc(api_keys.created_at))
    const data: ApiKeyListData = { keys: rows.map(({ key_hash: _hash, workspace_id: _ws, ...summary }) => summary) }
    return { rows: {}, data }
  },

  'apiKey.revoke': async ({ tx, actor, now }, input: { apiKeyId: string }) => {
    const workspace_id = refuseKeyActor(actor)
    const [row] = await tx.update(api_keys).set({ revoked_at: now })
      .where(and(eq(api_keys.id, input.apiKeyId), eq(api_keys.workspace_id, workspace_id), isNull(api_keys.revoked_at))).returning({ id: api_keys.id })
    if (!row) throw new Reject('API key not found')
    return { rows: {}, data: { apiKeyId: row.id } }
  },
}
