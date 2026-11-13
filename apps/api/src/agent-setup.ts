// Agent setup keys (LIN-125, docs/api.md "Setup MCP"): an instance admin lets an AI agent set up the install. The key
// acts as that admin, in their first workspace, through the short list of setup tools of setup-mcp.ts only, for
// SETUP_KEY_HOURS. Stored as a SHA-256 hash (256 random bits, so a fast hash is enough), like a workspace API key.
//
// What the key can never do, whatever tool it reaches: anything outside setup-mcp.ts's list (users, admins, other
// workspaces, impersonation, deleting), changing email, sign-in or recording storage (setup-mcp.ts refuses those: the
// admin does them in the app), skipping the number-purchase caps, and outliving its creator's admin role, account or
// the 24 hours.
import { createHash, randomBytes } from 'node:crypto'
import {
  type AgentSetupKeyCreated,
  type AgentSetupState,
  reachableFromCloud,
  rolePermissions,
  SETUP_KEY_HOURS,
  SETUP_KEY_PREFIX,
  type Role,
  teamRoles,
} from '@linedesk/actions'
import { agent_setup_keys, member, user } from '@linedesk/db'
import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm'
import { mustConfirmEmail } from './auth-methods.ts'
import { addressBucket } from './client-ip.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { Forbidden, type Handler } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { createFailureLimiter, createRateLimiter } from './rate-limit.ts'

/** Shown to tell keys apart: the prefix and 8 characters of the key. */
const SHOWN_LENGTH = SETUP_KEY_PREFIX.length + 8
const LAST_USED_EVERY_MS = 60_000
/** Requests per key and minute: an agent setting up is a handful a minute; this leaves room for retries. */
export const SETUP_KEY_REQUESTS_PER_MINUTE = 120

export const hashSetupKey = (key: string) => createHash('sha256').update(key).digest('hex')
const newKey = () => `${SETUP_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
const newId = () => `sk_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const WELL_FORMED = new RegExp(`^${SETUP_KEY_PREFIX}[A-Za-z0-9_-]{43}$`)
export const isSetupKey = (key: string) => WELL_FORMED.test(key)

/** Where people open the app (PUBLIC_URL on a server, Vite's address under pnpm dev): agents connect there too. */
export const webAddress = () =>
  (process.env.PUBLIC_URL || process.env.WEB_ORIGIN || 'http://localhost:5173').replace(/\/+$/, '')
export const setupMcpUrl = () => `${webAddress()}/mcp/setup`

const allowRequest = createRateLimiter({ max: SETUP_KEY_REQUESTS_PER_MINUTE, windowMs: 60_000 })
export const setupKeyWithinLimit = (keyId: string) => allowRequest(keyId)
/** Unknown setup keys per address: 10 in 10 minutes, then unknown keys from that address get a 429 (a working key never). */
const refused = createFailureLimiter({ max: 10, windowMs: 10 * 60_000 })
export const tooManyRefusedSetupKeys = (ip: string | null) => refused.blocked(addressBucket(ip))

/** The person the key acts for: a member of a workspace (owner or admin there sets it up), or none yet. */
async function workspaceOf(userId: string): Promise<{ workspaceId: string; role: Role } | null> {
  const rows = await db.select().from(member).where(eq(member.userId, userId)).orderBy(asc(member.createdAt))
  // The first workspace where they may change settings: the business they set up.
  const m = rows.find(r => r.role === 'owner' || r.role === 'admin') ?? rows[0]
  if (!m) return null
  const role: Role = (teamRoles as readonly string[]).includes(m.role) ? (m.role as Role) : 'member'
  return { workspaceId: m.organizationId, role }
}

/** The actor of a setup key's creator, as setup-mcp.ts runs their tools. Exported for the tests. */
export async function setupActor(userId: string, keyId: string): Promise<Actor | null> {
  const [account] = await db.select().from(user).where(eq(user.id, userId))
  if (!account || account.disabledAt || !isInstanceAdmin(account)) return null
  const ws = await workspaceOf(userId)
  const base = ws ? rolePermissions[ws.role] : []
  return {
    actorId: userId,
    role: ws?.role ?? 'member',
    workspaceId: ws?.workspaceId ?? null,
    // Never team:write (inviting people, roles) or key management: setup only.
    permissions: [...base.filter(p => p !== 'team:write'), 'instance:admin'],
    setupKeyId: keyId,
    // Never passkeyConfirmed: the key is a bearer URL kept in agent settings and transcripts.
    ...(mustConfirmEmail(account.emailVerified) ? { emailUnverified: true as const } : {}),
  }
}

/**
 * The actor for a setup key, or null when it is unknown, revoked or expired, or its creator is no longer an enabled
 * instance admin. A refused key counts against the address (tooManyRefusedSetupKeys); a working key is looked up
 * first, so others' wrong keys from a shared address (a cloud agent's) never lock it out.
 */
export async function actorForSetupKey(key: string, ip: string | null): Promise<Actor | null> {
  const fail = () => {
    refused.fail(addressBucket(ip))
    return null
  }
  if (!isSetupKey(key)) return fail()
  const now = new Date().toISOString()
  const [row] = await db
    .select()
    .from(agent_setup_keys)
    .where(
      and(
        eq(agent_setup_keys.key_hash, hashSetupKey(key)),
        isNull(agent_setup_keys.revoked_at),
        gt(agent_setup_keys.expires_at, now),
      ),
    )
  if (!row) return fail()
  const actor = await setupActor(row.created_by, row.id)
  if (!actor) return fail()
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > LAST_USED_EVERY_MS)
    void db
      .update(agent_setup_keys)
      .set({ last_used_at: now })
      .where(eq(agent_setup_keys.id, row.id))
      .catch(e => console.error(`could not note the use of setup key ${row.id}: ${e instanceof Error ? e.message : e}`))
  return actor
}

/** Only a signed-in admin hands out a setup key: never a key, an agent or an admin signed in as someone else. */
function refuseNonPerson(actor: Actor) {
  if (actor.apiKeyId || actor.setupKeyId || actor.callId || actor.role === 'agent')
    throw new Forbidden('Make a setup key in the app, signed in as an instance admin.')
  if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
}

export const agentSetupHandlers: Record<string, Handler> = {
  'agentSetup.createKey': async ({ tx, actor, now }) => {
    refuseNonPerson(actor)
    // One key at a time per admin: making a new one ends the old ones (a copied prompt from earlier stops working).
    await tx
      .update(agent_setup_keys)
      .set({ revoked_at: now })
      .where(and(eq(agent_setup_keys.created_by, actor.actorId), isNull(agent_setup_keys.revoked_at)))
    const key = newKey()
    const expiresAt = new Date(Date.parse(now) + SETUP_KEY_HOURS * 3_600_000).toISOString()
    const [row] = await tx
      .insert(agent_setup_keys)
      .values({
        id: newId(),
        prefix: key.slice(0, SHOWN_LENGTH),
        key_hash: hashSetupKey(key),
        created_by: actor.actorId,
        expires_at: expiresAt,
      })
      .returning()
    const data: AgentSetupKeyCreated = {
      keyId: row!.id,
      key,
      url: `${setupMcpUrl()}/${key}`,
      prefix: row!.prefix,
      expiresAt,
    }
    return { rows: {}, data }
  },

  'agentSetup.revoke': async ({ tx, actor, now }) => {
    refuseNonPerson(actor)
    const ended = await tx
      .update(agent_setup_keys)
      .set({ revoked_at: now })
      .where(and(eq(agent_setup_keys.created_by, actor.actorId), isNull(agent_setup_keys.revoked_at)))
      .returning({ id: agent_setup_keys.id })
    return { rows: {}, data: { ended: ended.length } }
  },
}

/** GET /v1/admin/agent-setup: the admin's working key (never the key itself) and where agents connect. */
export async function agentSetupState(userId: string): Promise<Omit<AgentSetupState, 'progress'>> {
  const [row] = await db
    .select()
    .from(agent_setup_keys)
    .where(
      and(
        eq(agent_setup_keys.created_by, userId),
        isNull(agent_setup_keys.revoked_at),
        gt(agent_setup_keys.expires_at, new Date().toISOString()),
      ),
    )
    .orderBy(desc(agent_setup_keys.created_at))
    .limit(1)
  return {
    mcpUrl: setupMcpUrl(),
    reachableFromCloud: reachableFromCloud(webAddress()),
    key: row
      ? {
          prefix: row.prefix,
          expiresAt: new Date(row.expires_at).toISOString(),
          lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
        }
      : null,
  }
}
