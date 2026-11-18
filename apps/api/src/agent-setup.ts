// Agent setup keys (LIN-125, docs/api.md "Setup MCP"): an instance admin lets an AI agent set up the install. The key
// acts as that admin through the short list of setup tools of setup-mcp.ts only, for SETUP_KEY_HOURS: the providers
// once per server, and each workspace the admin is owner or admin of, named by every business tool (LIN-237). Stored
// as a SHA-256 hash (256 random bits, so a fast hash is enough), like a workspace API key.
//
// One access level (Janik's decision 2026-11-15): making a key is an instance-admin action, so it needs the session's
// passkey check (admin-second-factor.ts); the key then may do everything the setup needs, email and sign-in included,
// for SETUP_KEY_HOURS (4). There is no second "Allow" step any more (#694's agentSetup.confirmPasskey, withdrawn with
// it). The key row records whether the session that
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
//
// Workspace keys (2026-11-15): a workspace owner who is no server admin (a Linedesk Cloud customer) sets up their one
// business with an agent too. agentSetup.createWorkspaceKey makes a key with agent_setup_keys.workspace_id set to the
// session's workspace. It acts as the owner in that workspace only (workspaceSetupActor, setupActorIn): no
// instance:admin, no server step or tool (setup-mcp.ts leaves them out), any other workspaceId refused, and run-action.ts
// refuses everything outside the workspace once more. It works while its maker is still that workspace's owner, the
// account and the workspace are not disabled, and its 4 hours last; the same one-link-per-person rule, End access
// (agentSetup.revokeWorkspace), the agent's own end, the same revocations (revokeSetupKeysOf) and the command log with
// the key's id (audit log). Owners need no passkey for it (like API keys); a confirmed email address (run-action.ts).
//
// Partner keys (2026-11-18, white-label Cloud agent-first): a white-label partner's owner sets up the partner with an
// agent. agentSetup.createPartnerKey makes a key with agent_setup_keys.partner_id set. It acts as the partner's owner
// for the partner's profile, brand and team (PARTNER_KEY_PARTNER_ACTIONS, that partner only) and as the partner team's
// admin in the partner's client workspaces (setupActorIn): never the partner bill, a seat, a number, a real call, the
// server or a workspace that is not the partner's client; run-action.ts refuses everything else once more
// (partnerKeyOutOfScope). It works while its maker is the partner's owner and the partner is not suspended.
import { createHash, randomBytes } from 'node:crypto'
import {
  type AgentSetupKeyCreated,
  type AgentSetupState,
  reachableFromCloud,
  rolePermissions,
  SETUP_KEY_HOURS,
  SETUP_KEY_PREFIX,
} from '@linedesk/actions'
import {
  agent_setup_keys,
  member,
  organization,
  partner_members,
  partners,
  type SetupKeyEndReason,
  session,
  user,
} from '@linedesk/db'
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { adminSecondFactorRequired } from './admin-second-factor.ts'
import { mustConfirmEmail } from './auth-methods.ts'
import { addressBucket } from './client-ip.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { PARTNER_OWNER_ONLY } from './partner-refusals.ts'
import { lockSetupKeysOf } from './passkey-enrolment.ts'
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
/** Workspace setup links one person may make (security review #822 F6): each ends the one before, so this is only a brake. */
const allowWorkspaceKeyMint = createRateLimiter({ max: 10, windowMs: 10 * 60_000 })
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
    // setupLink:end: the agent ends its own link (agentSetup.endOwnAccess) without the passkey check.
    permissions: ['instance:admin', 'setupLink:end'],
    setupKeyId: keyId,
    // A key made in a session that passed the admin's passkey check carries that check for its 4 hours
    // (keyPasskeyConfirmed). setup-mcp.ts keeps it to the provider and install tools.
    ...(passkeyConfirmed ? { passkeyConfirmed: true as const } : {}),
    ...(mustConfirmEmail(account.emailVerified) ? { emailUnverified: true as const } : {}),
  }
}

/** The workspace roles that make a workspace setup link (agentSetup.createWorkspaceKey): the owner and admins. */
export const WORKSPACE_KEY_ROLES = ['owner', 'admin'] as const
export type WorkspaceKeyRole = (typeof WORKSPACE_KEY_ROLES)[number]
const isWorkspaceKeyRole = (role: string | null | undefined): role is WorkspaceKeyRole =>
  role === 'owner' || role === 'admin'

/**
 * The actor of a workspace key (agent_setup_keys.workspace_id): its maker, while their role in that workspace is still
 * the one the key was made with (`role`, owner or admin), with no permission of its own besides ending its link. Like
 * setupActor it is in no workspace: every business tool names it (setupActorIn, which allows only this one, with that
 * role's rights). Null when the account is gone or disabled, the maker's role there is another (or none), the key has
 * no role, or the workspace is disabled or gone: the key then answers as ended.
 */
export async function workspaceSetupActor(
  userId: string,
  keyId: string,
  workspaceId: string,
  role: string | null,
): Promise<Actor | null> {
  if (!isWorkspaceKeyRole(role)) return null
  const [found] = await db
    .select({ disabledAt: user.disabledAt, emailVerified: user.emailVerified, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), eq(member.organizationId, workspaceId), isNull(organization.disabledAt)))
  if (!found || found.disabledAt || found.role !== role) return null
  return {
    actorId: userId,
    role: 'member',
    workspaceId: null,
    permissions: ['setupLink:end'],
    setupKeyId: keyId,
    setupWorkspaceId: workspaceId,
    setupWorkspaceRole: role,
    ...(mustConfirmEmail(found.emailVerified) ? { emailUnverified: true as const } : {}),
  }
}

/**
 * What a partner key (agent_setup_keys.partner_id) may run, besides ending its own link: the partner's own actions
 * (that partner only, partnerKeyOutOfScope), and in a client workspace the workspace setup's own actions. Never the
 * partner bill, a client workspace (a seat on the bill: the owner adds it on the setup page), a client's owner, a
 * number, a forwarding check or a lookup (they cost money or call out: owner rows on the setup page).
 */
export const PARTNER_KEY_PARTNER_ACTIONS: ReadonlySet<string> = new Set([
  'partner.get',
  'partner.update',
  'partner.listClients',
  'partnerBrand.get',
  'partnerBrand.set',
  'partnerMember.invite',
  'partnerMember.revokeInvite',
  'partner.setSetupStep',
])
export const PARTNER_KEY_WORKSPACE_ACTIONS: ReadonlySet<string> = new Set([
  'business.search',
  'business.import',
  'workspace.rename',
  'workspace.setIcon',
  'workspace.removeIcon',
  'assistant.update',
  'workspace.updateSettings',
  'businessHours.set',
  'notifications.update',
  'phoneNumber.listCarrierNumbers',
  'phoneNumber.update',
  'phoneNumber.forwardingCheck',
  'onboarding.setStep',
])

/**
 * The actor of a partner key: its maker while they are still the partner's owner, the partner is not suspended and
 * the account is not disabled. In no workspace, with `partner` (the partner's actions, each naming the key's partner)
 * and ending its own link; in a client workspace setupActorIn gives the team's admin rights there. Null otherwise: the
 * key then answers as ended.
 */
export async function partnerSetupActor(userId: string, keyId: string, partnerId: string): Promise<Actor | null> {
  const [found] = await db
    .select({
      disabledAt: user.disabledAt,
      emailVerified: user.emailVerified,
      role: partner_members.role,
      status: partners.status,
    })
    .from(partner_members)
    .innerJoin(user, eq(user.id, partner_members.user_id))
    .innerJoin(partners, eq(partners.id, partner_members.partner_id))
    .where(and(eq(partner_members.user_id, userId), eq(partner_members.partner_id, partnerId)))
  if (!found || found.disabledAt || found.role !== 'owner' || found.status === 'suspended') return null
  return {
    actorId: userId,
    role: 'member',
    workspaceId: null,
    permissions: ['setupLink:end', 'partner'],
    setupKeyId: keyId,
    setupPartnerId: partnerId,
    ...(mustConfirmEmail(found.emailVerified) ? { emailUnverified: true as const } : {}),
  }
}

/** Why a partner key's maker may no longer use it (partnerSetupActor said no), for its `ended_reason`. */
async function partnerKeyEndReason(userId: string, partnerId: string): Promise<SetupKeyEndReason> {
  const [found] = await db
    .select({ accountDisabledAt: user.disabledAt, role: partner_members.role, status: partners.status })
    .from(user)
    .leftJoin(partner_members, and(eq(partner_members.user_id, user.id), eq(partner_members.partner_id, partnerId)))
    .leftJoin(partners, eq(partners.id, partnerId))
    .where(eq(user.id, userId))
  if (!found || found.accountDisabledAt) return 'account_disabled'
  if (found.status === 'suspended') return 'partner_suspended'
  return 'left_partner'
}

/**
 * The workspaces a setup key may set up: for an install key, every one its admin manages (managedWorkspaces); for a
 * workspace key, only its own, and only while its maker still has the role the key was made with there.
 */
export async function setupWorkspaces(actor: Actor): Promise<ManagedWorkspace[]> {
  const all = await managedWorkspaces(actor.actorId)
  if (actor.setupPartnerId) {
    // A partner key: the partner's client workspaces only, never the maker's own business or another partner's client.
    const clients = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.partnerId, actor.setupPartnerId))
    const ids = new Set(clients.map(c => c.id))
    return all.filter(w => ids.has(w.id))
  }
  if (!actor.setupWorkspaceId) return all
  return all.filter(w => w.id === actor.setupWorkspaceId && w.role === actor.setupWorkspaceRole)
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
  // A workspace key: its own workspace only (setupWorkspaces checks the owner role again).
  if (actor.setupWorkspaceId && workspaceId !== actor.setupWorkspaceId) return null
  const ws = (await setupWorkspaces(actor)).find(w => w.id === workspaceId)
  if (!ws) return null
  const { passkeyConfirmed: _, ...rest } = actor
  return {
    ...rest,
    workspaceId: ws.id,
    role: ws.role,
    // Never the team or the owner's own rights (hand-over, deleting the workspace), as for API keys (api-keys.ts).
    permissions: rolePermissions[ws.role].filter(
      p => p !== 'team:write' && p !== 'workspace:own' && p !== 'billing:manage',
    ),
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
  // A workspace owner's key: that workspace only, never instance admin rights, so the server's passkey rule is not its.
  // Tied to the session that made it (security review #822 N2): signed out, signed out from another device or expired,
  // the link ends for good with it.
  if (!(await makerSessionLives(row))) {
    await endForGood(row.id, now, 'session_ended')
    return { kind: 'ended', reason: 'ended' }
  }
  if (row.partner_id) {
    const actor = await partnerSetupActor(row.created_by, row.id, row.partner_id)
    if (!actor) {
      // Ended for good, as a workspace key: the link must not work again if the partner or the role comes back.
      await endForGood(row.id, now, await partnerKeyEndReason(row.created_by, row.partner_id))
      return { kind: 'ended', reason: 'ended' }
    }
    noteUse(row, now)
    return { kind: 'ok', actor }
  }
  if (row.workspace_id) {
    const actor = await workspaceSetupActor(row.created_by, row.id, row.workspace_id, row.role)
    if (!actor) {
      // Ended for good: the link must not work again if the role or the workspace comes back (review #822 F1).
      await endForGood(row.id, now, await workspaceKeyEndReason(row.created_by, row.workspace_id))
      return { kind: 'ended', reason: 'ended' }
    }
    noteUse(row, now)
    return { kind: 'ok', actor }
  }
  // Made without the passkey check (ADMIN_SECOND_FACTOR=off then) while the rule is on now: the link does not work.
  const passkeyConfirmed = keyPasskeyConfirmed(row)
  if (!passkeyConfirmed && adminSecondFactorRequired()) return { kind: 'ended', reason: 'ended' }
  const actor = await setupActor(row.created_by, row.id, { passkeyConfirmed })
  if (!actor) return { kind: 'ended', reason: 'ended' }
  noteUse(row, now)
  return { kind: 'ok', actor }
}

/**
 * Why a workspace key's maker may no longer use it there (workspaceSetupActor said no), for its `ended_reason`: the
 * account or the workspace disabled, the maker gone from the workspace, or another role (#832 N10).
 */
async function workspaceKeyEndReason(userId: string, workspaceId: string): Promise<SetupKeyEndReason> {
  const [found] = await db
    .select({ accountDisabledAt: user.disabledAt, role: member.role, workspaceDisabledAt: organization.disabledAt })
    .from(user)
    .leftJoin(member, and(eq(member.userId, user.id), eq(member.organizationId, workspaceId)))
    .leftJoin(organization, eq(organization.id, workspaceId))
    .where(eq(user.id, userId))
  if (!found || found.accountDisabledAt) return 'account_disabled'
  if (found.workspaceDisabledAt) return 'workspace_disabled'
  if (!found.role) return 'left_workspace'
  return 'role_changed'
}

/** Ends a key found no longer valid on use, unless something ended it meanwhile (that reason stays). */
async function endForGood(id: string, now: string, reason: SetupKeyEndReason) {
  await db
    .update(agent_setup_keys)
    .set({ revoked_at: now, ended_reason: reason })
    .where(and(eq(agent_setup_keys.id, id), isNull(agent_setup_keys.revoked_at)))
}

/** Whether the sign-in session that made the key still lives (its maker's, not expired). No session: never. */
async function makerSessionLives(row: { session_id: string | null; created_by: string }): Promise<boolean> {
  if (!row.session_id) return false
  const [found] = await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.id, row.session_id), eq(session.userId, row.created_by), gt(session.expiresAt, new Date())))
  return Boolean(found)
}

/** Notes when a key was last used (the setup page's "connected"), at most once a minute. */
function noteUse(row: { id: string; last_used_at: string | null }, now: string) {
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > LAST_USED_EVERY_MS)
    void db
      .update(agent_setup_keys)
      .set({ last_used_at: now })
      .where(eq(agent_setup_keys.id, row.id))
      .catch(e => console.error(`could not note the use of setup key ${row.id}: ${e instanceof Error ? e.message : e}`))
}

/** What an ended key's holder is told: replaced, ended by itself, or a plain `ended` for everything else. */
const shownEndReason = (reason: string | null): SetupKeyEndedReason =>
  reason === 'replaced' ? 'replaced' : reason === 'ended_by_agent' ? 'ended_by_agent' : 'ended'

/** Only a signed-in admin hands out a setup key: never a key, an agent or an admin signed in as someone else. */
function refuseNonPerson(actor: Actor) {
  // A session too: a link lives as long as the session that made it (agent_setup_keys.session_id).
  if (actor.apiKeyId || actor.setupKeyId || actor.callId || actor.role === 'agent' || !actor.sessionId)
    throw new Forbidden('Make a setup key in the app, signed in as an instance admin.')
  if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
}

/**
 * After the lock (security review #822 N1): the session that asks still lives, and for a workspace key the person still
 * has the role the request came with there, in a workspace that is not disabled (nor the account). A revoke that ran just before (a password change, a signed-out session, a
 * role change, a removal) is committed by now, so this sees it and nothing is made.
 */
async function stillMayMake(
  tx: Parameters<Handler>[0]['tx'],
  actor: Actor,
  workspaceId: string | null,
  partnerId: string | null = null,
) {
  const [live] = await tx
    .select({ id: session.id })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(
      and(
        eq(session.id, actor.sessionId!),
        eq(session.userId, actor.actorId),
        gt(session.expiresAt, new Date()),
        isNull(user.disabledAt),
      ),
    )
  if (!live) throw new Forbidden('Your session ended. Sign in again to create a setup link.')
  if (partnerId) return refuseUnlessPartnerOwner(tx, actor, partnerId)
  if (!workspaceId) return
  // The workspace too (#832 N5): a disable that committed while this request waited for the lock leaves no link that
  // would work again once the workspace is enabled.
  const [me] = await tx
    .select({ role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(eq(member.userId, actor.actorId), eq(member.organizationId, workspaceId), isNull(organization.disabledAt)),
    )
  if (!me || me.role !== actor.role) throw new Forbidden(ONLY_OWNER_OR_ADMIN)
}

/** The partner's owner, of a partner that is not suspended (locks nothing: the key's use checks it again). */
async function refuseUnlessPartnerOwner(tx: Parameters<Handler>[0]['tx'], actor: Actor, partnerId: string) {
  const [me] = await tx
    .select({ role: partner_members.role, status: partners.status })
    .from(partner_members)
    .innerJoin(partners, eq(partners.id, partner_members.partner_id))
    .where(and(eq(partner_members.user_id, actor.actorId), eq(partner_members.partner_id, partnerId)))
  if (!me || me.role !== 'owner' || me.status === 'suspended') throw new Forbidden(PARTNER_OWNER_ONLY)
}

/** agentSetup.createWorkspaceKey from someone who is not the workspace's owner or an admin there. */
export const ONLY_OWNER_OR_ADMIN = "Only the workspace's owner or an admin makes a setup link for it."

/**
 * Makes a setup key: an install key (workspaceId and partnerId null), a workspace key or a partner key. One key at a
 * time per person, whatever its kind: making a new one ends the old ones (a copied prompt from earlier stops working).
 */
async function insertKey(
  tx: Parameters<Handler>[0]['tx'],
  actor: Actor,
  now: string,
  workspaceId: string | null,
  partnerId: string | null = null,
): Promise<AgentSetupKeyCreated> {
  // One maker at a time (security review #822 F3): two mints at once would otherwise both see no newer key and both
  // stay working. Held until the transaction ends. Every revoke takes the same lock (passkey-enrolment.ts), so what
  // it changed before is read below, and what it changes after sees this key (review N1).
  await lockSetupKeysOf(tx, actor.actorId)
  await stillMayMake(tx, actor, workspaceId, partnerId)
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
      workspace_id: workspaceId,
      partner_id: partnerId,
      role: workspaceId ? (actor.role as WorkspaceKeyRole) : null,
      session_id: actor.sessionId!,
      expires_at: expiresAt,
      // Whether this session passed the passkey check: an install key made without it (the rule off) stops working
      // once the rule is on again (setupKeyAccess). A workspace key never carries it.
      passkey_confirmed_until: !workspaceId && !partnerId && actor.passkeyConfirmed ? expiresAt : null,
    })
    .returning()
  return { keyId: row!.id, key, url: `${setupMcpUrl()}/${key}`, prefix: row!.prefix, expiresAt }
}

const TOO_MANY_LINKS = 'Too many setup links. Try again in a few minutes.'

export const agentSetupHandlers: Record<string, Handler> = {
  'agentSetup.createKey': async ({ tx, actor, now }) => {
    refuseNonPerson(actor)
    // Checked before the handler too (run-action.ts): only a session that passed the passkey check makes a link.
    if (adminSecondFactorRequired() && !actor.passkeyConfirmed)
      throw new Forbidden('Confirm with your passkey to create a setup link.')
    return { rows: {}, data: await insertKey(tx, actor, now, null) }
  },

  // A workspace key for the session's workspace, made by its owner or an admin (settings:write, checked by
  // run-action.ts; disabled workspaces keep read permissions only). Only a person signed in as themselves: never a
  // key, an agent or impersonation.
  'agentSetup.createWorkspaceKey': async ({ tx, actor, now }) => {
    refuseNonPerson(actor)
    // The owner or an admin (settings:write, checked by run-action.ts); the key acts with that role, never more.
    if (!actor.workspaceId || !isWorkspaceKeyRole(actor.role)) throw new Forbidden(ONLY_OWNER_OR_ADMIN)
    // Also while the workspace waits for its trial (agent-first, 2026-11-18): the agent does the free steps only; the
    // number, a real call and going past `activate` stay refused for it as for everyone (self-serve.ts).
    if (!allowWorkspaceKeyMint(actor.actorId)) throw new Reject(TOO_MANY_LINKS)
    return { rows: {}, data: await insertKey(tx, actor, now, actor.workspaceId) }
  },

  // A partner key, made by the partner's owner signed in as themselves (the partner area's agent page). `partner`
  // (run-action.ts); the owner check is the handler's (stillMayMake, under the person's setup-link lock).
  'agentSetup.createPartnerKey': async ({ tx, actor, now }, input: { partnerId: string }) => {
    refuseNonPerson(actor)
    if (!allowWorkspaceKeyMint(actor.actorId)) throw new Reject(TOO_MANY_LINKS)
    return { rows: {}, data: await insertKey(tx, actor, now, null, input.partnerId) }
  },

  // End access on the partner's agent page: the caller's own keys for that partner.
  'agentSetup.revokePartner': async ({ tx, actor, now }, input: { partnerId: string }) => {
    refuseNonPerson(actor)
    await lockSetupKeysOf(tx, actor.actorId) // as agentSetup.revokeWorkspace (#832 N6)
    const ended = await tx
      .update(agent_setup_keys)
      .set({ revoked_at: now, ended_reason: 'ended_by_admin' })
      .where(
        and(
          eq(agent_setup_keys.created_by, actor.actorId),
          eq(agent_setup_keys.partner_id, input.partnerId),
          isNull(agent_setup_keys.revoked_at),
        ),
      )
      .returning({ id: agent_setup_keys.id })
    return { rows: {}, data: { ended: ended.length } }
  },

  // End access on the setup page: the caller's own keys for this workspace. Any session of theirs may.
  'agentSetup.revokeWorkspace': async ({ tx, actor, now }) => {
    refuseNonPerson(actor)
    if (!actor.workspaceId) throw new Reject('no workspace')
    // The person's setup-link lock, as every revoke (#832 N6): a link being made at this moment is committed first and
    // ended here, never left working after "End access".
    await lockSetupKeysOf(tx, actor.actorId)
    const ended = await tx
      .update(agent_setup_keys)
      .set({ revoked_at: now, ended_reason: 'ended_by_admin' })
      .where(
        and(
          eq(agent_setup_keys.created_by, actor.actorId),
          eq(agent_setup_keys.workspace_id, actor.workspaceId),
          isNull(agent_setup_keys.revoked_at),
        ),
      )
      .returning({ id: agent_setup_keys.id })
    return { rows: {}, data: { ended: ended.length } }
  },

  'agentSetup.revoke': async ({ tx, actor, now }) => {
    refuseNonPerson(actor)
    await lockSetupKeysOf(tx, actor.actorId) // as agentSetup.revokeWorkspace (#832 N6)
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

/** Keys of one kind: the install's (no workspace, no partner), one workspace's or one partner's. */
const ofScope = (workspaceId: string | null, partnerId: string | null = null) =>
  partnerId
    ? eq(agent_setup_keys.partner_id, partnerId)
    : workspaceId
      ? eq(agent_setup_keys.workspace_id, workspaceId)
      : and(isNull(agent_setup_keys.workspace_id), isNull(agent_setup_keys.partner_id))

/**
 * GET /v1/admin/agent-setup (`workspaceId` null: the admin's install key) and GET /v1/workspace/agent-setup (the
 * owner's key for that workspace): the working key (never the key itself) and where agents connect.
 */
export async function agentSetupState(
  userId: string,
  workspaceId: string | null = null,
  partnerId: string | null = null,
): Promise<Omit<AgentSetupState, 'progress'>> {
  const [row] = await db
    .select()
    .from(agent_setup_keys)
    .where(
      and(
        eq(agent_setup_keys.created_by, userId),
        ofScope(workspaceId, partnerId),
        isNull(agent_setup_keys.revoked_at),
        gt(agent_setup_keys.expires_at, new Date().toISOString()),
      ),
    )
    .orderBy(desc(agent_setup_keys.created_at))
    .limit(1)
  // A key made with the passkey rule off does not work while it is on (setupKeyAccess): the page offers a new one.
  // A workspace key never needs it.
  // A key whose session ended or whose maker lost the role there is shown as ended too, before its next use ends it
  // for good (#832 N10): the page offers a new link, never "Ready" for a dead one.
  const usable =
    row &&
    (workspaceId || partnerId || keyPasskeyConfirmed(row) || !adminSecondFactorRequired()) &&
    (await makerSessionLives(row)) &&
    (!row.workspace_id || (await workspaceSetupActor(row.created_by, row.id, row.workspace_id, row.role)) !== null) &&
    (!row.partner_id || (await partnerSetupActor(row.created_by, row.id, row.partner_id)) !== null)
  const working = usable ? row : undefined
  return {
    mcpUrl: setupMcpUrl(),
    reachableFromCloud: reachableFromCloud(webAddress()),
    endedByAgentAt: working ? null : await endedByAgentAt(userId, workspaceId, partnerId),
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
async function endedByAgentAt(
  userId: string,
  workspaceId: string | null,
  partnerId: string | null = null,
): Promise<string | null> {
  const [newest] = await db
    .select({ reason: agent_setup_keys.ended_reason, at: agent_setup_keys.revoked_at })
    .from(agent_setup_keys)
    .where(and(eq(agent_setup_keys.created_by, userId), ofScope(workspaceId, partnerId)))
    .orderBy(desc(agent_setup_keys.created_at))
    .limit(1)
  if (newest?.reason !== 'ended_by_agent' || !newest.at) return null
  const at = new Date(newest.at)
  return Date.now() - at.getTime() < SETUP_KEY_HOURS * 3_600_000 ? at.toISOString() : null
}
