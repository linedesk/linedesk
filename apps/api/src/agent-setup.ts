// Agent setup keys (LIN-125, docs/api.md "Setup MCP"): an instance admin lets an AI agent set up the install. The key
// acts as that admin, in their first workspace, through the short list of setup tools of setup-mcp.ts only, for
// SETUP_KEY_HOURS. Stored as a SHA-256 hash (256 random bits, so a fast hash is enough), like a workspace API key.
//
// What the key can never do, whatever tool it reaches: anything outside setup-mcp.ts's list (users, admins, other
// workspaces, impersonation, deleting), skipping the number-purchase caps, and outliving its creator's admin role,
// account or the 24 hours. Email and sign-in (whoever controls them can sign in as anyone) keep the passkey step-up of
// admin-step-up.ts: only a key the admin confirmed with a passkey changes them (LIN-182), for the 12 hours that passkey
// sign-in counts; made right after one, or afterwards with agentSetup.confirmPasskey ("Allow" on the setup page, opened
// from the link the agent gives, which names the key), until agentSetup.withdrawPasskey. Resetting the admin's passkeys,
// disabling them or ending all their sessions revokes their keys (passkey-enrolment.ts revokeSetupKeysOf); a code for
// the admin's first passkey (user.issuePasskeyEnrolment, user:passkeys --enrol) does not. A revoked or expired key's
// row and hash stay: an agent still using it gets 401 SETUP_KEY_ENDED with a coarse reason (setupKeyAccess), which
// does not count towards the address's limit on unknown keys. Removing the admin role ends them too.
import { createHash, randomBytes } from 'node:crypto'
import {
  type AgentSetupAllowRequest,
  type AgentSetupKeyCreated,
  type AgentSetupState,
  type Role,
  reachableFromCloud,
  rolePermissions,
  SETUP_KEY_HOURS,
  SETUP_KEY_PREFIX,
  providerCategories,
  providerNames,
  providerSpec,
  teamRoles,
} from '@linedesk/actions'
import { agent_setup_keys, member, session, type Tx, user } from '@linedesk/db'
import { and, asc, desc, eq, gt, isNull } from 'drizzle-orm'
import { adminSecondFactorRequired, PASSKEY_CONFIRM_HOURS } from './admin-second-factor.ts'
import { passkeySignInForGrant } from './admin-step-up.ts'
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
export async function setupActor(
  userId: string,
  keyId: string,
  passkeyConfirmedUntil: string | null = null,
): Promise<Actor | null> {
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
    // The key is a bearer URL kept in agent settings and transcripts: it passes the passkey step-up (email and
    // sign-in) only while the admin's passkey confirmation of it lasts. setup-mcp.ts keeps it to the provider tools.
    ...(passkeyConfirmedUntil && Date.parse(passkeyConfirmedUntil) > Date.now()
      ? { passkeyConfirmed: true as const }
      : {}),
    ...(mustConfirmEmail(account.emailVerified) ? { emailUnverified: true as const } : {}),
  }
}

/** Answered for a key that existed and ended; `reason` never says more than the key's holder could already know. */
export const SETUP_KEY_ENDED = 'SETUP_KEY_ENDED'
export type SetupKeyEndedReason = 'replaced' | 'expired' | 'ended'

const endedMessages: Record<SetupKeyEndedReason, string> = {
  replaced:
    'This setup link was replaced: the admin made a newer one, and only the newest works. Ask the admin for the new link.',
  ended: 'This setup link was ended and no longer works. Ask the admin for a new one (Linedesk, Set up with an agent).',
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
  if (row.revoked_at) return { kind: 'ended', reason: row.ended_reason === 'replaced' ? 'replaced' : 'ended' }
  const now = new Date().toISOString()
  if (new Date(row.expires_at).getTime() <= Date.parse(now)) return { kind: 'ended', reason: 'expired' }
  const actor = await setupActor(row.created_by, row.id, row.passkey_confirmed_until)
  if (!actor) return { kind: 'ended', reason: 'ended' }
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > LAST_USED_EVERY_MS)
    void db
      .update(agent_setup_keys)
      .set({ last_used_at: now })
      .where(eq(agent_setup_keys.id, row.id))
      .catch(e => console.error(`could not note the use of setup key ${row.id}: ${e instanceof Error ? e.message : e}`))
  return { kind: 'ok', actor }
}

/** Only a signed-in admin hands out a setup key: never a key, an agent or an admin signed in as someone else. */
function refuseNonPerson(actor: Actor) {
  if (actor.apiKeyId || actor.setupKeyId || actor.callId || actor.role === 'agent')
    throw new Forbidden('Make a setup key in the app, signed in as an instance admin.')
  if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
}

/**
 * The email and sign-in grant this session can give a key it makes or confirms: only from a passkey sign-in of the last
 * few minutes that gave no grant yet (admin-step-up.ts passkeySignInForGrant), for 12 hours from it, never past the
 * key's own end. Null otherwise: the key then needs Allow with a new passkey prompt.
 */
async function grantFrom(tx: Tx, actor: Actor, keyExpiresAt: string, now: string) {
  const at = await passkeySignInForGrant(actor, tx)
  if (!at || !actor.sessionId) return null
  // Used up at once, and only if nothing else used it meanwhile (two requests at the same time give one grant).
  const [used] = await tx
    .update(session)
    .set({ passkeyGrantUsedAt: new Date(now) })
    .where(and(eq(session.id, actor.sessionId), isNull(session.passkeyGrantUsedAt)))
    .returning({ id: session.id })
  if (!used) return null
  const until = at.getTime() + PASSKEY_CONFIRM_HOURS * 3_600_000
  return { passkey_confirmed_until: new Date(Math.min(until, Date.parse(keyExpiresAt))).toISOString() }
}

export const agentSetupHandlers: Record<string, Handler> = {
  'agentSetup.createKey': async ({ tx, actor, now }) => {
    refuseNonPerson(actor)
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
        // Made within minutes of a passkey sign-in that gave no grant yet (step 1 of the page, right before the link):
        // the agent may change email and sign-in too. Otherwise it asks for Allow.
        ...(await grantFrom(tx, actor, expiresAt, now)),
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

  // Needs a passkey sign-in of the last few minutes (admin-step-up.ts FRESH: the page asks for it on every Allow): that
  // sign-in is what the key then carries, for 12 hours from it. Only for the key
  // the agent's link names (#setup-agent?allow=<keyId>), and only the admin's own working one: an Allow never lands on
  // a key someone else made meanwhile with the admin's mailbox (a newer key would be the working one, not this id).
  'agentSetup.confirmPasskey': async ({ tx, actor, now }, input: { keyId: string }) => {
    refuseNonPerson(actor)
    const [key] = await tx
      .select()
      .from(agent_setup_keys)
      .where(
        and(
          eq(agent_setup_keys.id, input.keyId),
          eq(agent_setup_keys.created_by, actor.actorId),
          isNull(agent_setup_keys.revoked_at),
          gt(agent_setup_keys.expires_at, now),
        ),
      )
    if (!key)
      throw new Reject(
        'That setup link is not your working one: it ended, expired or is not yours. Nothing was allowed; open the newest link from your agent.',
      )
    const expiresAt = new Date(key.expires_at).toISOString()
    // Checked before the handler too (run-action.ts); here once more, so no other way in skips it. One passkey sign-in
    // gives one grant: Withdraw and Allow again needs a new passkey prompt.
    const grant = adminSecondFactorRequired()
      ? await grantFrom(tx, actor, expiresAt, now)
      : { passkey_confirmed_until: expiresAt }
    if (!grant) throw new Forbidden('Confirm with your passkey to do this.')
    // The request it allows is answered.
    await tx
      .update(agent_setup_keys)
      .set({ ...grant, allow_request: null })
      .where(eq(agent_setup_keys.id, key.id))
    return { rows: {}, data: { keyId: key.id, emailAndSignInUntil: grant.passkey_confirmed_until } }
  },

  // Lowering rights needs no passkey: the admin's setup links can no longer change email and sign-in.
  'agentSetup.withdrawPasskey': async ({ tx, actor }) => {
    refuseNonPerson(actor)
    const withdrawn = await tx
      .update(agent_setup_keys)
      .set({ passkey_confirmed_until: null })
      .where(and(eq(agent_setup_keys.created_by, actor.actorId), isNull(agent_setup_keys.revoked_at)))
      .returning({ id: agent_setup_keys.id })
    return { rows: {}, data: { withdrawn: withdrawn.length } }
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
}

/** Whether a key may change email and sign-in now: its passkey confirmation lasts, or the install has the rule off. */
export const emailAndSignInAllowed = (passkeyConfirmedUntil: string | null) =>
  !adminSecondFactorRequired() || Boolean(passkeyConfirmedUntil && Date.parse(passkeyConfirmedUntil) > Date.now())

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
          id: row.id,
          prefix: row.prefix,
          createdAt: new Date(row.created_at).toISOString(),
          expiresAt: new Date(row.expires_at).toISOString(),
          lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
          emailAndSignIn: emailAndSignInAllowed(row.passkey_confirmed_until),
          // Only a passkey confirmation that lasts (not the passkey rule turned off): the page offers Withdraw.
          emailAndSignInUntil:
            adminSecondFactorRequired() &&
            row.passkey_confirmed_until &&
            Date.parse(row.passkey_confirmed_until) > Date.now()
              ? new Date(row.passkey_confirmed_until).toISOString()
              : null,
          // Only while it still waits: a key that may already do it has nothing to allow.
          request: emailAndSignInAllowed(row.passkey_confirmed_until) ? null : (row.allow_request ?? null),
        }
      : null,
  }
}

/** Where a setup MCP request came from, as the server saw it: shown to the admin with a request that waits for Allow. */
export type RequestOrigin = { ip: string | null; client: string | null }

/** The agent's User-Agent, shortened and without links: a name to recognise, never trusted. */
export const clientName = (userAgent: string | null | undefined) =>
  userAgent
    ?.replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || null

/** A secret URL field (an SMTP URL holds the password) said by its server only: host and port, never the rest. */
function serverOf(value: string): string | null {
  try {
    const url = new URL(value)
    return url.host || null
  } catch {
    return null
  }
}

/**
 * What a refused provider change asks for, in words for the admin's Allow dialog, without any secret: the provider, its
 * fields that are not secret, and the server of a secret URL. Null for anything else.
 */
export function describeAllowRequest(name: string, input: unknown): string | null {
  const { provider, values, category } = (input ?? {}) as {
    provider?: unknown
    values?: Record<string, unknown>
    category?: unknown
  }
  if (name === 'provider.setActive' && typeof category === 'string' && category in providerCategories) {
    const label =
      typeof provider === 'string' && (providerNames as string[]).includes(provider)
        ? providerSpec(provider as (typeof providerNames)[number]).label
        : 'none'
    return `Use ${label} for ${providerCategories[category as keyof typeof providerCategories].toLowerCase()}`
  }
  if (typeof provider !== 'string' || !(providerNames as string[]).includes(provider)) return null
  const spec = providerSpec(provider as (typeof providerNames)[number])
  const what = providerCategories[spec.category].toLowerCase()
  if (name === 'provider.clearKeys') return `Disconnect ${spec.label} (${what})`
  if (name !== 'provider.setKeys') return null
  const details = Object.entries(values ?? {}).flatMap(([field, value]) => {
    const f = (spec.fields as Record<string, { label: string; secret?: boolean }>)[field]
    if (!f || typeof value !== 'string' || !value.trim()) return []
    if (!f.secret) return [`${f.label.toLowerCase()} ${value.trim().slice(0, 120)}`]
    const server = serverOf(value.trim())
    return server ? [`server ${server}`] : []
  })
  return `Set up ${what} with ${spec.label}${details.length ? ` (${details.join(', ')})` : ''}`
}

/**
 * The agent asked for a change that waits for the admin's Allow (setup-mcp.ts, PASSKEY_NEEDED): kept on its key, so the
 * Allow dialog says when, from where and what. Only the last one; a failure to note it never fails the answer.
 */
export async function noteAllowRequest(keyId: string, name: string, input: unknown, from: RequestOrigin) {
  const what = describeAllowRequest(name, input)
  if (!what) return
  const request: AgentSetupAllowRequest = { at: new Date().toISOString(), ip: from.ip, client: from.client, what }
  await db
    .update(agent_setup_keys)
    .set({ allow_request: request })
    .where(eq(agent_setup_keys.id, keyId))
    .catch(e =>
      console.error(`could not note the allow request of setup key ${keyId}: ${e instanceof Error ? e.message : e}`),
    )
}
