// The audit log for instance admins (docs/architecture.md §12, Audit log): who did what. Two sources:
// the command log (`commands`: admin actions, team and role changes, provider keys, impersonation),
// and `auth_events` for what happens in Better Auth's own endpoints (sign-ins with their method,
// sign-in methods added or removed, invitations accepted). Nothing here is ever deleted.
import { REDACTED } from '@linedesk/actions'
import { auth_events, type Db, type Tx, user } from '@linedesk/db'
import { type createAuthMiddleware, isAPIError } from 'better-auth/api'
import { eq, sql } from 'drizzle-orm'
import { db } from './db.ts'

export type AuthEventName = (typeof auth_events.$inferInsert)['event']
type AuthEvent = {
  event: AuthEventName
  userId: string | null
  /** The address to keep with the event; by default the account's current one (email_changed keeps the old one). */
  email?: string | null
  method?: string | null
  workspaceId?: string | null
  ipAddress?: string | null
  userAgent?: string | null
}

const newId = () => `ae_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/**
 * Writes one event. A failed write is logged and never stops the sign-in it describes: the person
 * would otherwise be locked out by a broken log.
 */
export async function recordAuthEvent(e: AuthEvent, tx: Db = db) {
  try {
    const [who] = e.email !== undefined ? [{ email: e.email }] : e.userId ? await tx.select({ email: user.email }).from(user).where(eq(user.id, e.userId)) : []
    await tx.insert(auth_events).values({
      id: newId(),
      user_id: e.userId,
      email: who?.email ?? null,
      event: e.event,
      method: e.method ?? null,
      workspace_id: e.workspaceId ?? null,
      // Better Auth writes the unspecified address (::) when it has none.
      ip_address: e.ipAddress && !/^[0:.]+$/.test(e.ipAddress) ? e.ipAddress : null,
      user_agent: e.userAgent ?? null,
    })
  } catch (err) {
    console.error(`audit: could not record ${e.event}`, err)
  }
}

type HookCtx = { path?: string; params?: Record<string, string | undefined> } | null | undefined

/** How a session was started, from the Better Auth endpoint that made it; null when not a sign-in (impersonation). */
export function signInMethod(ctx: HookCtx): string | null {
  const path = ctx?.path
  if (!path) return null
  if (path === '/sign-in/email' || path === '/sign-up/email') return 'password'
  if (path === '/sign-in/email-otp') return 'email_code'
  if (path === '/passkey/verify-authentication') return 'passkey'
  if (path.startsWith('/callback/') || path.startsWith('/oauth2/callback/'))
    return ctx?.params?.id ?? ctx?.params?.providerId ?? 'provider'
  if (path === '/verify-email') return 'email_link'
  return null
}

/** Better Auth `session.create.after`: a sign-in (or the sign-in that ends a sign-up). Impersonation is in the command log. */
export async function recordSignIn(
  created: { userId: string; impersonatedBy?: string | null; ipAddress?: string | null; userAgent?: string | null },
  ctx: unknown,
) {
  if (created.impersonatedBy) return
  const hook = ctx as HookCtx
  const method = signInMethod(hook)
  if (!method) return
  await recordAuthEvent({
    event: hook?.path === '/sign-up/email' ? 'sign_up' : 'sign_in',
    userId: created.userId,
    method,
    ipAddress: created.ipAddress,
    userAgent: created.userAgent,
  })
}

/** Better Auth database hooks of the audit log (merged with the others in auth.ts). */
export const auditHooks = {
  session: { create: { after: recordSignIn } },
  account: { create: { after: recordLinkedAccount } },
}

/** Better Auth `account.create.after`: a sign-in method joined the account (a provider, or a password). */
export async function recordLinkedAccount(created: { userId: string; providerId: string }) {
  await recordAuthEvent({
    event: 'provider_linked',
    userId: created.userId,
    method: created.providerId === 'credential' ? 'password' : created.providerId,
  })
}

/** Endpoints whose success is an audit event; the user is the session's. */
const afterEvents: Record<string, AuthEventName> = {
  '/passkey/verify-registration': 'passkey_added',
  '/passkey/delete-passkey': 'passkey_removed',
  '/change-password': 'password_changed',
  '/organization/accept-invitation': 'invitation_accepted',
}

type AfterCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

/** Runs after Better Auth's endpoints (auth.ts): records the ones in `afterEvents` that succeeded. */
export async function recordAuthEndpoint(ctx: AfterCtx) {
  const event = afterEvents[ctx.path]
  if (!event || isAPIError(ctx.context.returned)) return
  const session = (ctx.context.session ?? ctx.context.newSession) as {
    user?: { id: string }
    session?: { impersonatedBy?: string | null; ipAddress?: string | null; userAgent?: string | null }
  } | null
  if (!session?.user) return
  const returned = ctx.context.returned as { member?: { organizationId?: string } } | undefined
  await recordAuthEvent({
    event,
    userId: session.user.id,
    workspaceId: returned?.member?.organizationId ?? null,
    ipAddress: session.session?.ipAddress,
    userAgent: session.session?.userAgent,
  })
}

/** A webhook URL's host only: its path or query can carry the receiver's bearer token. */
export function urlHost(url: unknown): string {
  try {
    return new URL(String(url)).host || 'a URL'
  } catch {
    return 'a URL'
  }
}

/**
 * What the audit log shows of an action's input. The command log keeps it as sent (secrets already
 * redacted); here a webhook URL becomes its host and an invitation id, which opens the invitation's
 * page, keeps only its first characters.
 */
export function maskAuditInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const masked: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  if (typeof masked.url === 'string') masked.url = urlHost(masked.url)
  // Stored redacted since 2026-11-11 (the action lists it as sensitive); older entries hold it in clear.
  if (typeof masked.invitationId === 'string' && masked.invitationId !== REDACTED) masked.invitationId = `${masked.invitationId.slice(0, 6)}…`
  return masked
}

/** Which part of the log a row belongs to, for the filter. */
export const AUDIT_KINDS = ['sign_in', 'account', 'admin', 'team', 'impersonation', 'keys', 'integrations'] as const
export type AuditKind = (typeof AUDIT_KINDS)[number]

/** Command-log actions that belong in the audit log, by kind. Everyday actions (calls, contacts) do not. */
export const AUDITED_ACTIONS: Record<string, AuditKind> = {
  'provider.setKeys': 'keys',
  'provider.clearKeys': 'keys',
  'provider.setActive': 'keys',
  'provider.connectOneKey': 'keys',
  'carrier.set': 'keys',
  'carrier.provisionTransferTrunk': 'keys',
  'user.invite': 'admin',
  'user.disable': 'admin',
  'user.enable': 'admin',
  'workspace.disable': 'admin',
  'workspace.enable': 'admin',
  'workspace.delete': 'admin',
  'workspace.setSpendingCap': 'admin',
  'instanceAdmin.grant': 'admin',
  'instanceAdmin.revoke': 'admin',
  'user.resetPasskeys': 'admin',
  'user.issuePasskeyEnrolment': 'admin',
  // The install's name, logo and color, and whether "Powered by Linedesk" shows.
  'branding.set': 'admin',
  'user.impersonate': 'impersonation',
  'impersonation.stop': 'impersonation',
  'team.invite': 'team',
  'team.resendInvite': 'team',
  'team.revokeInvite': 'team',
  'team.setRole': 'team',
  'team.removeMember': 'team',
  'team.leave': 'team',
  // An owner or admin changing a teammate's name, picture or notifications (team-member-edit.ts).
  'team.updateMemberProfile': 'team',
  'team.setMemberAvatar': 'team',
  'team.removeMemberAvatar': 'team',
  'team.updateMemberNotifications': 'team',
  'workspace.deleteOwn': 'team',
  'invitation.accept': 'team',
  'invitation.decline': 'team',
  // An instance admin changing who is in which workspace, also their own membership.
  'membership.add': 'admin',
  'membership.setRole': 'admin',
  'membership.remove': 'admin',
  'invitation.revoke': 'admin',
  'invitation.resend': 'admin',
  // Ways in from outside that outlast a session: API keys and where call data is sent.
  'apiKey.create': 'integrations',
  'apiKey.revoke': 'integrations',
  'webhook.create': 'integrations',
  'webhook.update': 'integrations',
  'webhook.delete': 'integrations',
  'webhook.test': 'integrations',
  // An AI agent acting as an instance admin: its setup link, and letting it change email and sign-in.
  'agentSetup.createKey': 'integrations',
  'agentSetup.confirmPasskey': 'integrations',
  'agentSetup.withdrawPasskey': 'integrations',
  'agentSetup.revoke': 'integrations',
  // The agent ending its own setup link at the end of the setup (marked with the key, viaSetupKey).
  'agentSetup.endOwnAccess': 'integrations',
}

/**
 * Whom a team or membership change was about, put in the action's result (`data.subject`) by its
 * handler, since a removed member's row is gone afterwards. The audit log shows the address and
 * lists the entry under the workspace changed, which for an instance admin is not their own;
 * `workspaceId: null` lists it under none (a new instance admin without a workspace).
 */
export type AuditSubject = { email: string | null; workspaceId: string | null }

/** The subject of a change to `userId`'s membership of `workspaceId`. */
export async function memberSubject(tx: Tx, userId: string, workspaceId: string): Promise<AuditSubject> {
  const [who] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId))
  return { email: who?.email ?? null, workspaceId }
}

/** The subject of a change to an invitation: the invited address. */
export const invitationSubject = (invite: { email: string; organizationId: string }): AuditSubject => ({
  email: invite.email,
  workspaceId: invite.organizationId,
})

const AUTH_EVENT_KIND: Record<AuthEventName, AuditKind> = {
  sign_in: 'sign_in',
  sign_up: 'sign_in',
  provider_linked: 'account',
  passkey_added: 'account',
  passkey_removed: 'account',
  password_changed: 'account',
  email_changed: 'account',
  invitation_accepted: 'team',
  call_routing_reset: 'integrations',
}

export type AuditEntry = {
  id: string
  at: string
  kind: AuditKind
  /** An action name (`team.setRole`) or an auth event (`sign_in`). */
  what: string
  /** sign-in method or provider, for auth events. */
  method: string | null
  actor: { id: string | null; email: string | null; name: string | null }
  /** The instance admin acting as `actor` (impersonation). */
  impersonatedBy: { id: string; email: string | null } | null
  /** Done by an AI agent with the actor's setup key (agent_setup_keys.id): "via agent setup link". */
  viaSetupKey: string | null
  workspace: { id: string; name: string | null } | null
  /** Whom a team or membership change was about (`AuditSubject`). */
  subject: { email: string | null } | null
  /** The action's input as the command log keeps it (secrets already redacted). */
  input: unknown
  refused: boolean
  ipAddress: string | null
}

export type AuditFilter = {
  kind?: AuditKind
  /** Part of the actor's email or name. */
  who?: string
  workspaceId?: string
  from?: string
  to?: string
  /** Paging: the `next` cursor of the previous page (`<at>|<id>` of its last entry). */
  before?: string
  limit?: number
}

/** A real calendar day, YYYY-MM-DD: 2026-02-30 and 2026-13-01 are not. */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const at = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value
}

/** A paging cursor as `listAudit` hands it out: `<ISO time>|<entry id>`, with a real time. */
export function isAuditCursor(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([\w-]{1,64})$/.exec(value)
  if (!match) return false
  const at = Date.parse(match[1]!)
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === match[1]!.slice(0, 10)
}

// biome-ignore lint/suspicious/noExplicitAny: rows of a hand-written union query
type Row = Record<string, any>

/** Newest first, both sources merged. */
export async function listAudit(tx: Db, f: AuditFilter): Promise<{ entries: AuditEntry[]; next: string | null }> {
  const limit = Math.min(200, Math.max(1, f.limit ?? 50))
  const actions = Object.keys(AUDITED_ACTIONS)
  const kindActions = f.kind ? actions.filter(a => AUDITED_ACTIONS[a] === f.kind) : actions
  const kindEvents = (Object.keys(AUTH_EVENT_KIND) as AuthEventName[]).filter(
    e => !f.kind || AUTH_EVENT_KIND[e] === f.kind,
  )
  // Everything done while an admin was signed in as someone else counts as impersonation, whatever the action.
  const withImpersonated = !f.kind || f.kind === 'impersonation'
  const listed = kindActions.length
    ? sql`c.action in (${sql.join(
        kindActions.map(a => sql`${a}`),
        sql`, `,
      )})`
    : sql`false`
  const commandRows =
    kindActions.length || withImpersonated
      ? sql`select c.id, c.created_at as at, c.action as what, null::text as method, c.actor_id, null::text as email_then,
        c.impersonated_by, c.setup_key_id,
        case when c.result->'data'->'subject' ? 'workspaceId' then c.result->'data'->'subject'->>'workspaceId'
          else coalesce(c.input->>'workspaceId', c.workspace_id) end as workspace_id,
        c.input, c.result->'data'->'subject'->>'email' as subject_email, c.rejected as refused, null::text as ip_address, 'command' as source
        from commands c where ${listed}${withImpersonated ? sql` or c.impersonated_by is not null` : sql``}`
      : null
  const eventRows = kindEvents.length
    ? sql`select e.id, e.created_at as at, e.event as what, e.method, e.user_id as actor_id, e.email as email_then,
        null::text as impersonated_by, null::text as setup_key_id, e.workspace_id, null::jsonb as input, null::text as subject_email, false as refused, e.ip_address, 'auth' as source
        from auth_events e where e.event in (${sql.join(
          kindEvents.map(e => sql`${e}`),
          sql`, `,
        )})`
    : null
  const parts = [commandRows, eventRows].filter(Boolean) as ReturnType<typeof sql>[]
  if (!parts.length) return { entries: [], next: null }
  const union = sql.join(parts, sql` union all `)
  const conditions = [sql`true`]
  if (f.workspaceId) conditions.push(sql`a.workspace_id = ${f.workspaceId}`)
  if (f.from) conditions.push(sql`a.at >= ${f.from}::timestamptz`)
  if (f.to) conditions.push(sql`a.at < ${f.to}::timestamptz`)
  const [beforeAt, beforeId] = f.before?.split('|') ?? []
  if (beforeAt && beforeId) conditions.push(sql`(a.at, a.id) < (${beforeAt}::timestamptz, ${beforeId})`)
  if (f.who?.trim()) {
    const like = `%${f.who
      .trim()
      .toLowerCase()
      .replace(/[%_\\]/g, m => `\\${m}`)}%`
    conditions.push(
      sql`(lower(coalesce(u.email, a.email_then, '')) like ${like} or lower(coalesce(u.name, '')) like ${like})`,
    )
  }
  const rows = (
    await tx.execute(sql`
      select a.*, to_char(a.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_iso,
        u.email as actor_email, u.name as actor_name, ib.email as impersonator_email, o.name as workspace_name
      from (${union}) a
      left join "user" u on u.id = a.actor_id
      left join "user" ib on ib.id = a.impersonated_by
      left join organization o on o.id = a.workspace_id
      where ${sql.join(conditions, sql` and `)}
      order by a.at desc, a.id desc
      limit ${limit + 1}`)
  ).rows as Row[]
  const page = rows.slice(0, limit)
  const entries = page.map(
    (r): AuditEntry => ({
      id: r.id,
      at: r.at_iso,
      kind:
        r.source === 'command'
          ? (AUDITED_ACTIONS[r.what] ?? 'impersonation')
          : AUTH_EVENT_KIND[r.what as AuthEventName],
      what: r.what,
      method: r.method,
      actor: {
        id: r.actor_id === 'cli' ? null : r.actor_id,
        email: r.actor_email ?? r.email_then ?? null,
        name: r.actor_name ?? null,
      },
      impersonatedBy: r.impersonated_by ? { id: r.impersonated_by, email: r.impersonator_email ?? null } : null,
      viaSetupKey: r.setup_key_id ?? null,
      workspace: r.workspace_id ? { id: r.workspace_id, name: r.workspace_name ?? null } : null,
      subject: r.subject_email ? { email: r.subject_email } : null,
      input: maskAuditInput(r.input),
      refused: Boolean(r.refused),
      ipAddress: r.ip_address,
    }),
  )
  const last = page.at(-1)
  return { entries, next: rows.length > limit && last ? `${last.at_iso}|${last.id}` : null }
}
