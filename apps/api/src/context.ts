// Who is calling: a signed-in member (session cookie) or the voice agent (bearer token).
import { timingSafeEqual } from 'node:crypto'
import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER, rolePermissions, type Permission, type Role } from '@linedesk/actions'
import { member, organization, user } from '@linedesk/db'
import { and, asc, eq } from 'drizzle-orm'
import { isCallToken, verifyCallToken } from './agent-token.ts'
import { actorForApiKey, isApiKey } from './api-keys.ts'
import { auth } from './auth.ts'
import { addressBucket } from './client-ip.ts'
import { createFailureLimiter } from './rate-limit.ts'
import { mustConfirmEmail } from './auth-methods.ts'
import { db } from './db.ts'
import { impersonationEndsAt } from './impersonation-guard.ts'
import { type AdminSecondFactor, adminSecondFactorGap, passkeyConfirmed } from './admin-second-factor.ts'
import { isInstanceAdmin } from './instance-admin.ts'

export interface Actor {
  actorId: string
  role: Role
  /** null for the agent before it knows which workspace a call belongs to, and for an instance admin without a workspace. */
  workspaceId: string | null
  permissions: readonly Permission[]
  /** The workspace is disabled by an instance admin: members keep their read permissions only. */
  workspaceDisabled?: true
  /** An instance admin (`by`) signed in as this user (docs/architecture.md §12). */
  impersonation?: Impersonation
  /** An instance admin whose session lacks the second factor: no instance:admin until it is done. */
  adminSecondFactor?: AdminSecondFactor
  /** The request came with this workspace API key (api-keys.ts), not a session. */
  apiKeyId?: string
  /** The session of a signed-in member (not an API key or the agent). */
  sessionId?: string
  /** The voice agent with a call token (agent-token.ts): only this call, in `workspaceId`. */
  callId?: string
  /**
   * The session was started by a passkey sign-in in the last 12 hours (never while impersonating),
   * or the caller is the server operator (CLI): what admin-step-up.ts asks for.
   */
  passkeyConfirmed?: true
  /** The member's address (or an API key's creator's) is not confirmed yet: no sensitive actions (run-action.ts). */
  emailUnverified?: true
}

export type Impersonation = { by: string; sessionId: string; expiresAt: Date }

/**
 * The impersonation a session stands for, or null when it must not be used any more: past its
 * hour, or the admin who started it is gone, disabled or no longer an instance admin.
 */
async function checkImpersonation(s: { id: string; createdAt: Date; expiresAt: Date; impersonatedBy: string }): Promise<Impersonation | null> {
  const endsAt = impersonationEndsAt(s.createdAt)
  if (endsAt.getTime() <= Date.now()) return null
  const [admin] = await db.select().from(user).where(eq(user.id, s.impersonatedBy))
  if (!admin || admin.disabledAt || !isInstanceAdmin(admin)) return null
  return { by: admin.id, sessionId: s.id, expiresAt: new Date(Math.min(s.expiresAt.getTime(), endsAt.getTime())) }
}

/** A disabled workspace's members keep reading, and can still answer invitations to other workspaces. */
const readOnly = (permissions: readonly Permission[]) => permissions.filter(p => p.endsWith(':read') || p === 'invitation:respond')

/** Constant-time: the agent token also reads the provider keys. */
function sameToken(given: string, expected: string) {
  const [a, b] = [Buffer.from(given), Buffer.from(expected)]
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Set by Caddy on every request through the public site (docker/Caddyfile), replacing whatever the
 * client sent; the internal listener the agent uses sets `internal`.
 */
export const ENTRY_HEADER = 'x-linedesk-entry'

/**
 * Whether the agent token may be used on a request with this entry header: only through the internal
 * listener. A request without the header (straight to the API, as `pnpm dev` runs it) counts only
 * outside production; in production it reached the API around the proxy.
 */
export function agentEntryAllowed(entry: string | null, production = process.env.NODE_ENV === 'production') {
  return entry === 'internal' || (entry === null && !production)
}

/** Refused agent tokens per client address in a window; then the address is refused at once until they age out. */
export const INVALID_AGENT_TOKENS_PER_IP = 10
const invalidAgentTokens = createFailureLimiter({ max: INVALID_AGENT_TOKENS_PER_IP, windowMs: 10 * 60_000 })
export const tooManyInvalidAgentTokens = (ip: string | null) => invalidAgentTokens.blocked(addressBucket(ip))

/**
 * The voice agent: with the install-wide token in the workspace it names (x-workspace-id; none
 * before `call.start`), with a call token in that call's workspace. Nothing in a disabled workspace.
 */
async function agentActor(workspaceId: string | null, callId?: string): Promise<Actor> {
  const actor: Actor = { actorId: 'agent', role: 'agent', workspaceId, permissions: rolePermissions.agent, ...(callId ? { callId } : {}) }
  if (!workspaceId) return actor
  const [workspace] = await db.select({ disabledAt: organization.disabledAt }).from(organization).where(eq(organization.id, workspaceId))
  return workspace?.disabledAt ? { ...actor, permissions: [], workspaceDisabled: true } : actor
}

/** `clientIp` is where the request comes from (client-ip.ts); refused API keys are counted per address. */
export async function resolveActor(headers: Headers, clientIp: string | null = null): Promise<Actor | null> {
  const resolved = await resolveCaller(headers, clientIp)
  return 'actor' in resolved ? resolved.actor : null
}

/**
 * Who is calling, or why nobody usable is: `no_workspace` is a valid session of someone who belongs
 * to no workspace (removed from their last one, or never joined one) and is not an instance admin.
 */
export async function resolveCaller(
  headers: Headers,
  clientIp: string | null = null,
): Promise<{ actor: Actor } | { missing: 'signed_out' | 'no_workspace' }> {
  const signedOut = { missing: 'signed_out' } as const
  // Only the Bearer scheme is ours. Another one (Basic from a password gate in front of the app, such as
  // scripts/local-public.sh) leaves the session cookie in charge.
  const authorization = headers.get('authorization')
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
  if (bearer) {
    if (isApiKey(bearer)) {
      const actor = await actorForApiKey(bearer, clientIp)
      return actor ? { actor } : signedOut
    }
    // The agent reaches the API through the internal listener only; anywhere else its tokens (install-wide
    // and per call) count for nothing. Checked before either token, so a call token never works through the public site.
    if (!agentEntryAllowed(headers.get(ENTRY_HEADER)) || tooManyInvalidAgentTokens(clientIp)) return signedOut
    if (isCallToken(bearer)) {
      const claims = verifyCallToken(bearer)
      if (!claims) invalidAgentTokens.fail(addressBucket(clientIp))
      return claims ? { actor: await agentActor(claims.workspaceId, claims.callId) } : signedOut
    }
    if (!process.env.AGENT_API_TOKEN || !sameToken(bearer, process.env.AGENT_API_TOKEN)) {
      invalidAgentTokens.fail(addressBucket(clientIp))
      return signedOut
    }
    return { actor: await agentActor(headers.get(WORKSPACE_HEADER)) }
  }
  const session = await auth.api.getSession({ headers })
  if (!session) return signedOut
  const [account] = await db.select().from(user).where(eq(user.id, session.user.id))
  if (!account || account.disabledAt) return signedOut
  const { impersonatedBy } = session.session
  const impersonation = impersonatedBy ? await checkImpersonation({ ...session.session, impersonatedBy }) : undefined
  if (impersonation === null) return signedOut
  // While impersonating: the user's own permissions, never instance:admin, plus ending the impersonation.
  // An instance admin gets instance:admin only in a session with the second factor (admin-second-factor.ts).
  const secondFactorGap = !impersonation && isInstanceAdmin(account) ? adminSecondFactorGap(account, session.session) : null
  const extraPermissions: Permission[] = impersonation
    ? ['impersonation:stop']
    : isInstanceAdmin(account) && !secondFactorGap
      ? ['instance:admin']
      : []
  const extra = {
    sessionId: session.session.id,
    ...(!impersonation && passkeyConfirmed(session.session.passkeyVerifiedAt) ? { passkeyConfirmed: true as const } : {}),
    ...(mustConfirmEmail(account.emailVerified) ? { emailUnverified: true as const } : {}),
    ...(impersonation ? { impersonation } : {}),
    ...(secondFactorGap ? { adminSecondFactor: secondFactorGap } : {}),
  }
  // The active workspace, or the member's first one right after sign-in.
  const active = session.session.activeOrganizationId
  const memberships = await db.select().from(member).where(eq(member.userId, session.user.id)).orderBy(asc(member.createdAt))
  const m = memberships.find(x => x.organizationId === active) ?? memberships[0]
  // An instance admin can use the admin area before they belong to a workspace, and an impersonation can be ended; everyone else needs one.
  if (!m)
    return extraPermissions.length || secondFactorGap
      ? { actor: { actorId: account.id, role: 'member', workspaceId: null, permissions: extraPermissions, ...extra } }
      : { missing: 'no_workspace' }
  const workspaceId = m.organizationId
  const role = (m.role in rolePermissions ? m.role : 'member') as Role
  const [workspace] = await db.select({ disabledAt: organization.disabledAt }).from(organization).where(eq(organization.id, workspaceId))
  if (workspace?.disabledAt) {
    const permissions = [...readOnly(rolePermissions[role]), ...extraPermissions]
    return { actor: { actorId: account.id, role, workspaceId, permissions, workspaceDisabled: true, ...extra } }
  }
  return { actor: { actorId: account.id, role, workspaceId, permissions: [...rolePermissions[role], ...extraPermissions], ...extra } }
}

/**
 * The workspace a request is for. The agent names a call's workspace with it; a browser tab sends
 * the workspace it was opened on, so a switch in another tab (the session's active workspace is one
 * per cookie) never makes this tab read or write another workspace.
 */
export const WORKSPACE_HEADER = 'x-workspace-id'

/** On every answer for a workspace: `disabled` (an instance admin disabled it, members only read) or `active`. */
export const WORKSPACE_STATE_HEADER = 'x-workspace-state'

export type WorkspaceRefusal = {
  ok: false
  error: string
  code: 'workspace_switched' | 'workspace_access_lost' | 'client_outdated' | 'account_switched'
  /** With `workspace_switched`: the workspace the session is on now. */
  activeWorkspaceId?: string
}

/** The account a page was opened for (`me.actorId`), sent with its workspace requests. */
export const ACCOUNT_HEADER = 'x-linedesk-account'

/**
 * Someone else signed in in another tab: the cookie is theirs now. A page opened for another account
 * must not read their data or send its own queued changes as them, even in a workspace both belong to.
 */
export function accountRefusal(actor: Actor, pageAccount: string | null): WorkspaceRefusal | null {
  if (!pageAccount || actor.apiKeyId || actor.role === 'agent' || pageAccount === actor.actorId) return null
  return { ok: false, error: 'Someone else signed in on this browser. Reload to continue as them.', code: 'account_switched' }
}

type BrowserRequest ={ method: string; path: string; header: (name: string) => string | undefined }

/**
 * A page loaded before a deploy that changed what workspace requests carry (CLIENT_PROTOCOL): its
 * reads and writes are refused until it reloads, so it can never act the old way (an old page sends
 * no workspace and would follow a switch made in another tab). Only browser pages are asked: they
 * send Sec-Fetch-Site, which API clients, the agent and tests do not. Only requests that read or
 * write a workspace's data (actions, shapes) of a session that has a workspace.
 */
export function clientOutdated(actor: Actor, req: BrowserRequest): WorkspaceRefusal | null {
  if (!req.header('sec-fetch-site') || actor.apiKeyId || actor.role === 'agent' || !actor.workspaceId) return null
  const workspaceData = (req.method === 'POST' && req.path.startsWith('/v1/actions/')) || (req.method === 'GET' && req.path.startsWith('/v1/shape/'))
  if (!workspaceData) return null
  const protocol = Number(req.header(CLIENT_PROTOCOL_HEADER) ?? 0)
  if (protocol >= CLIENT_PROTOCOL && req.header(WORKSPACE_HEADER)) return null
  return { ok: false, error: 'Linedesk was updated. Reload the page to continue.', code: 'client_outdated' }
}

/** Signed in, but not (or no longer) a member of the workspace the request names. */
export const accessLost = (error = 'You no longer have access to this workspace.'): WorkspaceRefusal => ({
  ok: false,
  error,
  code: 'workspace_access_lost',
})

/**
 * Why a request that names its workspace must not run, or null when it may. The session moved to
 * another workspace (a switch in another tab): `workspace_switched`, the tab can switch back. Not a
 * member of it: `workspace_access_lost`. An API key works only in the workspace of its row. Both are
 * answered with 403, never 409: Electric's client takes a 409 on a shape request for an expired shape.
 */
export async function workspaceRefusal(actor: Actor, requested: string | null): Promise<WorkspaceRefusal | null> {
  if (!requested || requested === actor.workspaceId) return null
  // The install-wide agent token names its workspace with the header; a call token has its own.
  if (actor.role === 'agent') return actor.callId ? accessLost('This call token belongs to another workspace.') : null
  if (actor.apiKeyId) return accessLost('This API key belongs to another workspace.')
  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, actor.actorId), eq(member.organizationId, requested)))
  if (!membership || !actor.workspaceId) return accessLost()
  return {
    ok: false,
    error: 'This tab is on another workspace than your account now. Switch back or reload.',
    code: 'workspace_switched',
    activeWorkspaceId: actor.workspaceId,
  }
}
