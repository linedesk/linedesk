// Agent setup keys (LIN-125, docs/api.md "Setup MCP"): an instance admin lets an AI agent set up the install. The key
// acts as that admin through the short list of setup tools of setup-mcp.ts only, for SETUP_KEY_HOURS: the providers
// once per server, and each workspace the admin is owner or admin of, named by every business tool (LIN-237). Stored
// as a SHA-256 hash (256 random bits, so a fast hash is enough), like a workspace API key.
//
// One access level (Janik's decision 2026-11-15): making a key is an instance-admin action, so it needs the session's
// passkey check (admin-second-factor.ts); the key then may do everything the setup needs, email and sign-in included,
// for SETUP_KEY_HOURS (4). There is no second "Allow" step any more (#694's agentSetup.confirmPasskey, withdrawn with
// it; the column allow_request stays unread until a later contract step). The key row records whether the session that
// made it had passed the passkey check (passkey_confirmed_until, its expiry then; null without one, which only an
// install with ADMIN_SECOND_FACTOR=off allows): while the rule is on, a key without it does not work (setupKeyAccess),
// so a link made with the switch off never acts as passkey-confirmed once the switch is back on.
//
// What the key can never do, whatever tool it reaches: anything outside setup-mcp.ts's list (users, admins, workspaces
// where the admin is not owner or admin, impersonation, deleting), skipping the number-purchase caps, and outliving
// its creator's admin role, account or the 4 hours. Resetting the admin's passkeys, disabling them or ending all their
// sessions revokes their keys (passkey-enrolment.ts revokeSetupKeysOf). A revoked or expired key's row and hash stay:
// an agent still using it gets 401 SETUP_KEY_ENDED with a coarse reason (setupKeyAccess), which does not count towards
// the address's limit on unknown keys. Removing the admin role ends them too. At the end of the setup the agent ends
// its own key (agentSetup.endOwnAccess, setup MCP setup_endAccess): that key only, nothing else.
import { createHash, randomBytes } from 'node:crypto'
import {
  type AgentSetupKeyCreated,
  type AgentSetupState,
  reachableFromCloud,
  rolePermissions,
  SETUP_KEY_HOURS,
  SETUP_KEY_PREFIX,
} from '@linedesk/actions'
import { agent_setup_keys, member, organization, user } from '@linedesk/db'
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { adminSecondFactorRequired } from './admin-second-factor.ts'
import { mustConfirmEmail } from './auth-methods.ts'
import { addressBucket } from './client-ip.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
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

/** Per key, working or ended, checked in setupKeyAccess before any other work on it. */
const allowRequest = createRateLimiter({ max: SETUP_KEY_REQUESTS_PER_MINUTE, windowMs: 60_000 })
/** Unknown setup keys per address: 10 in 10 minutes, then unknown keys from that address get a 429 (a working key never). */
const refused = createFailureLimiter({ max: 10, windowMs: 10 * 60_000 })
export const tooManyRefusedSetupKeys = (ip: string | null) => refused.blocked(addressBucket(ip))

/** A workspace the setup key's admin may set up: they are its owner or admin there, and it is not disabled. */
export type ManagedWorkspace = { id: string; name: string; role: 'owner' | 'admin' }

/**
 * Every workspace the admin may set up through the setup MCP and the setup page, oldest membership first: where they
 * are owner or admin. Never one where they are only a member, and never a disabled one (nothing there can change).
 */
export async function managedWorkspaces(userId: string): Promise<ManagedWorkspace[]> {
  const rows = await db
    .select({ id: organization.id, name: organization.name, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), inArray(member.role, ['owner', 'admin']), isNull(organization.disabledAt)))
    .orderBy(asc(member.createdAt))
  return rows.map(r => ({ id: r.id, name: r.name, role: r.role as ManagedWorkspace['role'] }))
}

/**
 * The actor of a setup key's creator, as setup-mcp.ts runs their tools. Exported for the tests. It is in no workspace:
 * every business tool names its workspace (setupActorIn), so nothing lands in a workspace by default.
 */
export async function setupActor(
  userId: string,
  keyId: string,
  { passkeyConfirmed }: { passkeyConfirmed: boolean },
): Promise<Actor | null> {
  const [account] = await db.select().from(user).where(eq(user.id, userId))
  if (!account || account.disabledAt || !isInstanceAdmin(account)) return null
  return {
    actorId: userId,
    role: 'member',
    workspaceId: null,
    permissions: ['instance:admin'],
    setupKeyId: keyId,
    // A key made in a session that passed the admin's passkey check carries that check for its 4 hours
    // (keyPasskeyConfirmed). setup-mcp.ts keeps it to the provider and install tools.
    ...(passkeyConfirmed ? { passkeyConfirmed: true as const } : {}),
    ...(mustConfirmEmail(account.emailVerified) ? { emailUnverified: true as const } : {}),
  }
}

/**
 * Whether a key carries its maker's passkey check now: its session had passed it (passkey_confirmed_until, set to the
 * key's expiry when it was made), and that time has not passed. Rows from #694 keep their own time there.
 */
export const keyPasskeyConfirmed = (row: { passkey_confirmed_until: string | null }, now = Date.now()) =>
  Boolean(row.passkey_confirmed_until && Date.parse(row.passkey_confirmed_until) > now)

/**
 * The setup key's admin acting in one of their workspaces, as its owner or admin would: that role's permissions without
 * team:write (inviting people, roles), never instance:admin or the passkey confirmation. Null when the admin is not
 * owner or admin of `workspaceId` (or it is disabled): the agent never reaches another workspace.
 */
export async function setupActorIn(actor: Actor, workspaceId: string): Promise<Actor | null> {
  const ws = (await managedWorkspaces(actor.actorId)).find(w => w.id === workspaceId)
  if (!ws) return null
  const { passkeyConfirmed: _, ...rest } = actor
  return {
    ...rest,
    workspaceId: ws.id,
    role: ws.role,
    // Never the team or the owner's own rights (hand-over, deleting the workspace), as for API keys (api-keys.ts).
    permissions: rolePermissions[ws.role].filter(p => p !== 'team:write' && p !== 'workspace:own'),
  }
}

/** Answered for a key that existed and ended; `reason` never says more than the key's holder could already know. */
export const SETUP_KEY_ENDED = 'SETUP_KEY_ENDED'
export type SetupKeyEndedReason = 'replaced' | 'expired' | 'ended' | 'ended_by_agent'

const endedMessages: Record<SetupKeyEndedReason, string> = {
  replaced:
    'This setup link was replaced: the admin made a newer one, and only the newest works. Ask the admin for the new link.',
  ended: 'This setup link was ended and no longer works. Ask the admin for a new one (Linedesk, Set up with an agent).',
  // Only the key's holder ended it this way (agentSetup.endOwnAccess), so saying so tells it nothing new.
  ended_by_agent:
    'You ended this setup link yourself (setup_endAccess), so it no longer works. If the admin wants more changes, they make a new link (Linedesk, Set up with an agent).',
  expired: `This setup link expired (a link works for ${SETUP_KEY_HOURS} hours). Ask the admin for a new one (Linedesk, Set up with an agent).`,
}
export const setupKeyEndedMessage = (reason: SetupKeyEndedReason) => endedMessages[reason]

/** The setup MCP's answer to an ended key: 401 SETUP_KEY_ENDED, with what to ask the admin for. */
export const setupKeyEndedResponse = (reason: SetupKeyEndedReason) =>
  Response.json(
    { error: setupKeyEndedMessage(reason), code: SETUP_KEY_ENDED, reason },
    { status: 401, headers: { 'www-authenticate': 'Bearer realm="linedesk-setup", error="invalid_token"' } },
  )

/**
 * What a setup key gets: `ok` with the actor; `limited` when the key (working or ended) is past its per-key limit;
 * `ended` when it existed and no longer works; `unknown` otherwise.
 */
export type SetupKeyAccess =
  | { kind: 'ok'; actor: Actor }
  | { kind: 'limited' }
  | { kind: 'ended'; reason: SetupKeyEndedReason }
  | { kind: 'unknown' }

/**
 * One lookup of a setup key, on the stored SHA-256 of the key alone (unique index), so an `ended` answer says nothing
 * about any key the caller does not hold: 256 random bits, an ended key is as unguessable as a working one. Only an
 * unknown key (or one that is not even well formed) counts against the address (tooManyRefusedSetupKeys). A key that
 * exists, working or ended, is never counted there: a link that stopped working is not a guess. The per-key limit
 * comes before any other work on the key. A working key is looked up first, so others' wrong keys from a shared
 * address (a cloud agent's) never lock it out. Shown reasons are coarse: replaced and expired, everything else (End,
 * passkey reset, disabling the admin, password reset, account recovery, admin role removed) is `ended`.
 */
export async function setupKeyAccess(key: string, ip: string | null): Promise<SetupKeyAccess> {
  const unknown = (): SetupKeyAccess => {
    refused.fail(addressBucket(ip))
    return { kind: 'unknown' }
  }
  if (!isSetupKey(key)) return unknown()
  const [row] = await db
    .select()
    .from(agent_setup_keys)
    .where(eq(agent_setup_keys.key_hash, hashSetupKey(key)))
  if (!row) return unknown()
  if (!allowRequest(row.id)) return { kind: 'limited' }
  if (row.revoked_at) return { kind: 'ended', reason: shownEndReason(row.ended_reason) }
  const now = new Date().toISOString()
  if (new Date(row.expires_at).getTime() <= Date.parse(now)) return { kind: 'ended', reason: 'expired' }
  // Made without the passkey check (ADMIN_SECOND_FACTOR=off then) while the rule is on now: the link does not work.
  const passkeyConfirmed = keyPasskeyConfirmed(row)
  if (!passkeyConfirmed && adminSecondFactorRequired()) return { kind: 'ended', reason: 'ended' }
  const actor = await setupActor(row.created_by, row.id, { passkeyConfirmed })
  if (!actor) return { kind: 'ended', reason: 'ended' }
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > LAST_USED_EVERY_MS)
    void db
      .update(agent_setup_keys)
      .set({ last_used_at: now })
      .where(eq(agent_setup_keys.id, row.id))
      .catch(e => console.error(`could not note the use of setup key ${row.id}: ${e instanceof Error ? e.message : e}`))
  return { kind: 'ok', actor }
}

/** What an ended key's holder is told: replaced, ended by itself, or a plain `ended` for everything else. */
const shownEndReason = (reason: string | null): SetupKeyEndedReason =>
  reason === 'replaced' ? 'replaced' : reason === 'ended_by_agent' ? 'ended_by_agent' : 'ended'

/** Only a signed-in admin hands out a setup key: never a key, an agent or an admin signed in as someone else. */
function refuseNonPerson(actor: Actor) {
  if (actor.apiKeyId || actor.setupKeyId || actor.callId || actor.role === 'agent')
    throw new Forbidden('Make a setup key in the app, signed in as an instance admin.')
  if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
}

export const agentSetupHandlers: Record<string, Handler> = {
  'agentSetup.createKey': async ({ tx, actor, now }) => {
    refuseNonPerson(actor)
    // Checked before the handler too (run-action.ts): only a session that passed the passkey check makes a link.
    if (adminSecondFactorRequired() && !actor.passkeyConfirmed)
      throw new Forbidden('Confirm with your passkey to create a setup link.')
    // One key at a time per admin: making a new one ends the old ones (a copied prompt from earlier stops working).
    await tx
      .update(agent_setup_keys)
      .set({ revoked_at: now, ended_reason: 'replaced' })
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
        // Whether this session passed the passkey check: a key made without it (the rule off) stops working once the
        // rule is on again (setupKeyAccess).
        passkey_confirmed_until: actor.passkeyConfirmed ? expiresAt : null,
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
      .set({ revoked_at: now, ended_reason: 'ended_by_admin' })
      .where(and(eq(agent_setup_keys.created_by, actor.actorId), isNull(agent_setup_keys.revoked_at)))
      .returning({ id: agent_setup_keys.id })
    return { rows: {}, data: { ended: ended.length } }
  },

  // The agent at the end of the setup (setup MCP setup_endAccess): only the key it calls with, never another key of the
  // admin's (a newer one made meanwhile keeps working). Nobody else may: a
  // person signed in ends access with agentSetup.revoke. The command log keeps it with the key (audit log).
  'agentSetup.endOwnAccess': async ({ tx, actor, now }) => {
    if (!actor.setupKeyId || actor.apiKeyId || actor.callId || actor.impersonation)
      throw new Forbidden('Only an AI agent ends its own setup link this way. To end agent access, use End access.')
    const [ended] = await tx
      .update(agent_setup_keys)
      .set({ revoked_at: now, ended_reason: 'ended_by_agent' })
      .where(
        and(
          eq(agent_setup_keys.id, actor.setupKeyId),
          eq(agent_setup_keys.created_by, actor.actorId),
          isNull(agent_setup_keys.revoked_at),
        ),
      )
      .returning({ id: agent_setup_keys.id, prefix: agent_setup_keys.prefix })
    if (!ended) throw new Reject('This setup link has already ended.')
    return { rows: {}, data: { ended: ended.prefix, at: now } }
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
  // A key made with the passkey rule off does not work while it is on (setupKeyAccess): the page offers a new one.
  const working = row && (keyPasskeyConfirmed(row) || !adminSecondFactorRequired()) ? row : undefined
  return {
    mcpUrl: setupMcpUrl(),
    reachableFromCloud: reachableFromCloud(webAddress()),
    endedByAgentAt: working ? null : await endedByAgentAt(userId),
    key: working
      ? {
          id: working.id,
          prefix: working.prefix,
          createdAt: new Date(working.created_at).toISOString(),
          expiresAt: new Date(working.expires_at).toISOString(),
          lastUsedAt: working.last_used_at ? new Date(working.last_used_at).toISOString() : null,
        }
      : null,
  }
}

/** When the agent ended the admin's newest setup link itself, within a link's lifetime; null otherwise (agentSetupState). */
async function endedByAgentAt(userId: string): Promise<string | null> {
  const [newest] = await db
    .select({ reason: agent_setup_keys.ended_reason, at: agent_setup_keys.revoked_at })
    .from(agent_setup_keys)
    .where(eq(agent_setup_keys.created_by, userId))
    .orderBy(desc(agent_setup_keys.created_at))
    .limit(1)
  if (newest?.reason !== 'ended_by_agent' || !newest.at) return null
  const at = new Date(newest.at)
  return Date.now() - at.getTime() < SETUP_KEY_HOURS * 3_600_000 ? at.toISOString() : null
}
