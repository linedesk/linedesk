// The audit log for instance admins (docs/architecture.md §12, Audit log): who did what. Two sources:
// the command log (`commands`: admin actions, team and role changes, provider keys, impersonation),
// and `auth_events` for what happens in Better Auth's own endpoints (sign-ins with their method,
// sign-in methods added or removed, invitations accepted). Nothing here is ever deleted.
import { REDACTED } from '@linedesk/actions'
import { auth_events, type Db, type Tx, user } from '@linedesk/db'
import type { TransferContact } from '@linedesk/db/types'
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
  /** Another account the event is about (auth_events.subject_id): listed as the entry's subject. */
  subjectId?: string | null
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
    await insertAuthEvent(tx, e)
  } catch (err) {
    console.error(`audit: could not record ${e.event}`, err)
  }
}

/**
 * Writes one event and throws when it cannot: inside the transaction of the change it describes, so the two are saved
 * together or not at all (a join and its `invitation_accepted`).
 */
export async function insertAuthEvent(tx: Db | Tx, e: AuthEvent) {
  const [who] =
    e.email !== undefined
      ? [{ email: e.email }]
      : e.userId
        ? await tx.select({ email: user.email }).from(user).where(eq(user.id, e.userId))
        : []
  await tx.insert(auth_events).values({
    id: newId(),
    user_id: e.userId,
    email: who?.email ?? null,
    event: e.event,
    method: e.method ?? null,
    workspace_id: e.workspaceId ?? null,
    subject_id: e.subjectId ?? null,
    // Better Auth writes the unspecified address (::) when it has none.
    ip_address: e.ipAddress && !/^[0:.]+$/.test(e.ipAddress) ? e.ipAddress : null,
    user_agent: e.userAgent ?? null,
  })
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
  // Transfer contacts (assistant.update): their names and the numbers' last four digits only.
  if (Array.isArray(masked.transfers))
    masked.transfers = masked.transfers.map(c => {
      const contact = (c ?? {}) as Partial<TransferContact>
      return { id: contact.id, name: contact.name, number: maskedNumber(contact.number) }
    })
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
  // Install-wide switches a server admin sets for every workspace.
  'voiceCloning.set': 'admin',
  'voicePipelinePolicy.set': 'admin',
  // The wording of the assistant's system prompt for every workspace (LIN-346).
  'systemPrompt.setPart': 'admin',
  'systemPrompt.resetPart': 'admin',
  'afterCallTranscript.set': 'admin',
  'setupEmails.set': 'admin',
  // Billing through Stripe on or off for the whole install (docs/billing.md §7).
  'billingEnabled.set': 'admin',
  // A stored Stripe event processed again by an instance admin (docs/billing.md §5.1).
  'billing.reprocessEvent': 'admin',
  // Server admin › Billing (docs/billing.md §8, PR 13): every change to a bill, its money or the install's billing
  // rules, each with the admin's reason in its input; reads are not listed.
  'billing.credit': 'admin',
  'billing.refund': 'admin',
  'billing.adminSetStatus': 'admin',
  'billing.setCap': 'admin',
  'billing.setConcurrency': 'admin',
  'billing.moveWorkspace': 'admin',
  'billing.transferOwner': 'admin',
  'billing.reviewHold': 'admin',
  'billingRules.set': 'admin',
  'signup.setSelfServe': 'admin',
  'user.invite': 'admin',
  'user.disable': 'admin',
  'user.enable': 'admin',
  'workspace.disable': 'admin',
  'workspace.enable': 'admin',
  'workspace.delete': 'admin',
  'workspace.setSpendingCap': 'admin',
  // Where every workspace's transfers may call through the install's carrier account (before: `data.previous`).
  'outboundCountries.set': 'admin',
  'instanceAdmin.grant': 'admin',
  'instanceAdmin.revoke': 'admin',
  'user.resetPasskeys': 'admin',
  'user.issuePasskeyEnrolment': 'admin',
  'account.authenticatorStart': 'admin',
  'account.authenticatorConfirm': 'admin',
  'account.authenticatorCheck': 'admin',
  'account.authenticatorRemove': 'admin',
  // The install's name, logo and color, and whether "Powered by Linedesk" shows.
  'branding.set': 'admin',
  // Which calendar tools members may connect, and how.
  'calendarTools.set': 'admin',
  'user.impersonate': 'impersonation',
  'impersonation.stop': 'impersonation',
  // Whether users are emailed when an admin signs in as them (impersonation.ts).
  'impersonationEmails.set': 'impersonation',
  'team.invite': 'team',
  'team.resendInvite': 'team',
  'team.revokeInvite': 'team',
  'team.setRole': 'team',
  'team.transferOwnership': 'team',
  'team.removeMember': 'team',
  'team.leave': 'team',
  // An owner or admin changing a teammate's name, picture or notifications (team-member-edit.ts).
  'team.updateMemberProfile': 'team',
  'team.setMemberAvatar': 'team',
  'team.removeMemberAvatar': 'team',
  'team.updateMemberNotifications': 'team',
  'workspace.deleteOwn': 'team',
  // What the workspace pays: the owner allowing Premium voices and models (Linedesk Cloud), on or off.
  'workspace.setAllowPremium': 'team',
  'workspace.setAllowUltra': 'team',
  'invitation.accept': 'team',
  'invitation.decline': 'team',
  // An instance admin changing who is in which workspace, also their own membership.
  'membership.add': 'admin',
  // A server admin making a workspace for a business and giving it its owner.
  'workspace.create': 'admin',
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
  // Where bookings with callers' details go, and phone numbers (buying one spends money).
  'calendar.connectFinish': 'integrations',
  'calendar.disconnect': 'integrations',
  'phoneNumber.setup': 'integrations',
  'phoneNumber.release': 'integrations',
  // An AI agent acting as an instance admin: its setup link. confirmPasskey and withdrawPasskey (the Allow step, gone
  // since the one-level setup link) stay listed, so their past entries still show.
  'agentSetup.createKey': 'integrations',
  'agentSetup.confirmPasskey': 'integrations',
  'agentSetup.withdrawPasskey': 'integrations',
  'agentSetup.revoke': 'integrations',
  // The agent ending its own setup link at the end of the setup (marked with the key, viaSetupKey).
  'agentSetup.endOwnAccess': 'integrations',
  // A workspace owner's setup link for their one workspace, and ending it.
  'agentSetup.createWorkspaceKey': 'integrations',
  'agentSetup.revokeWorkspace': 'integrations',
}

/**
 * Actions that are audited only when they changed the assistant's transfer contacts, the numbers calls are put
 * through to: their handlers put `data.transferChanges` in the result then (kind `integrations`). Refused ones are
 * listed when their input had `transfers`. Like every command, the input is cut down to ids after 90 days; the
 * 90-day prune keeps `data.transferChanges` (ids, names, last four digits), deleting the workspace does not
 * (command-log.ts).
 */
export const TRANSFER_CHANGE_ACTIONS = ['assistant.update', 'assistant.restoreVersion'] as const
export const TRANSFER_CHANGE_KIND: AuditKind = 'integrations'

/**
 * The same actions are audited when they changed what decides the assistant's usage level on Linedesk Cloud (the voice
 * model, the language model, the pipeline: what its calls cost): their handlers put `data.usageLevelChange` (before and
 * after, model ids only) in the result then. Kind `team`, like Allow Premium.
 */
export const USAGE_LEVEL_CHANGE_KIND: AuditKind = 'team'
type AuditedLevelFields = {
  voice_model: string | null
  llm_model: string | null
  voice_pipeline: string | null
  /** Missing in entries from before Ultra. */
  realtime_model?: string | null
}
/** What decides the level, before and after a change (handlers.ts, UsageLevelChange). */
export type AuditedLevelChange = {
  before: AuditedLevelFields
  after: AuditedLevelFields
}

/** A number as the audit log keeps it: its last four digits ("…0199"); null: none. */
export const maskedNumber = (number: string | null | undefined) =>
  number ? `…${number.replace(/\D/g, '').slice(-4)}` : null

/** A transfer contact as the audit log keeps it: never its whole number. */
export type AuditedContact = { id: string; name: string; number: string | null }

/**
 * Which transfer contacts a change added, changed (with the fields that changed, and the number before when it was
 * one of them) and removed, and whether the order changed. Only the contacts that changed, never the whole list.
 */
export type TransferChanges = {
  added: AuditedContact[]
  changed: (AuditedContact & { fields: string[]; numberBefore?: string | null })[]
  removed: AuditedContact[]
  reordered: boolean
}

const audited = (c: TransferContact): AuditedContact => ({ id: c.id, name: c.name, number: maskedNumber(c.number) })

/** The fields of a contact that differ between two versions of it (jsonb keeps keys in its own order). */
function changedFields(was: TransferContact, now: TransferContact): string[] {
  const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()
  const get = (c: TransferContact, k: string) => JSON.stringify((c as Record<string, unknown>)[k] ?? null)
  return keys.filter(k => get(was, k) !== get(now, k))
}

/** What changed between two lists of transfer contacts (matched by id; a new order alone is a change too), or null. */
export function transferChanges(before: TransferContact[], after: TransferContact[]): TransferChanges | null {
  const was = new Map(before.map(c => [c.id, c]))
  const now = new Set(after.map(c => c.id))
  const added = after.filter(c => !was.has(c.id)).map(audited)
  const changed = after.flatMap(c => {
    const old = was.get(c.id)
    const fields = old ? changedFields(old, c) : []
    if (!fields.length) return []
    return [
      { ...audited(c), fields, ...(fields.includes('number') ? { numberBefore: maskedNumber(old!.number) } : {}) },
    ]
  })
  const removed = before.filter(c => !now.has(c.id)).map(audited)
  const order = (list: TransferContact[], keep: (id: string) => boolean) =>
    list
      .filter(c => keep(c.id))
      .map(c => c.id)
      .join()
  const reordered = order(before, id => now.has(id)) !== order(after, id => was.has(id))
  if (!added.length && !changed.length && !removed.length && !reordered) return null
  return { added, changed, removed, reordered }
}

/** What the admin page gets of a change: the names it shows. */
export type TransferChangeNames = { added: string[]; changed: string[]; removed: string[] }
const namesOf = (changes: TransferChanges): TransferChangeNames => ({
  added: changes.added.map(c => c.name),
  changed: changes.changed.map(c => c.name),
  removed: changes.removed.map(c => c.name),
})

const transferChangeActions = sql.join(
  TRANSFER_CHANGE_ACTIONS.map(a => sql`${a}`),
  sql`, `,
)
/**
 * SQL: a command of `c` that changed transfer contacts (`data.transferChanges` an object: a workspace's deletion cuts
 * it down to "[omitted]"), or one refused whose input had transfers.
 */
const transferChangeSql = sql`(c.action in (${transferChangeActions}) and (jsonb_typeof(c.result->'data'->'transferChanges') = 'object' or (c.rejected and c.input ? 'transfers')))`
/** SQL: a command of `c` that changed what decides the assistant's usage level (`data.usageLevelChange` an object). */
const usageLevelChangeSql = sql`(c.action in (${transferChangeActions}) and jsonb_typeof(c.result->'data'->'usageLevelChange') = 'object')`

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
  sign_up_undone: 'sign_in',
  call_routing_reset: 'integrations',
  invitation_reassigned: 'team',
  invitation_withdrawn: 'team',
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
  /** The transfer contacts a change added, changed and removed, by name (TRANSFER_CHANGE_ACTIONS only). */
  transferChanges?: TransferChangeNames
  /** The voice model, language model or pipeline a change set, before and after (assistant.update, restoreVersion). */
  usageLevelChange?: AuditedLevelChange
  /** apiKey.revoke: the revoked key's name (its input has only the id). */
  apiKeyName?: string
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
  // Everything an AI agent did with a setup link counts as an integration, whatever the action (docs/api.md, Setup MCP).
  const withSetupKey = !f.kind || f.kind === 'integrations'
  const withTransferChanges = !f.kind || f.kind === TRANSFER_CHANGE_KIND
  const withLevelChanges = !f.kind || f.kind === USAGE_LEVEL_CHANGE_KIND
  const listed = kindActions.length
    ? sql`c.action in (${sql.join(
        kindActions.map(a => sql`${a}`),
        sql`, `,
      )})`
    : sql`false`
  const commandRows =
    kindActions.length || withImpersonated || withSetupKey || withTransferChanges || withLevelChanges
      ? sql`select c.id, c.created_at as at, c.action as what, null::text as method, c.actor_id, null::text as email_then,
        c.impersonated_by, c.setup_key_id,
        case when c.result->'data'->'subject' ? 'workspaceId' then c.result->'data'->'subject'->>'workspaceId'
          else coalesce(c.input->>'workspaceId', c.workspace_id) end as workspace_id,
        c.input, c.result->'data'->'subject'->>'email' as subject_email, c.result->'data'->'transferChanges' as transfer_changes, ${transferChangeSql} as transfer_change,
        c.result->'data'->'usageLevelChange' as usage_level_change, ${usageLevelChangeSql} as level_change,
        case when c.action = 'apiKey.revoke' then (select k.name from api_keys k
          where k.id = c.input->>'apiKeyId' and k.workspace_id = c.workspace_id) end as api_key_name,
        c.rejected as refused, null::text as ip_address, 'command' as source
        from commands c where ${listed}${withImpersonated ? sql` or c.impersonated_by is not null` : sql``}${
          withSetupKey ? sql` or c.setup_key_id is not null` : sql``
        }${withTransferChanges ? sql` or ${transferChangeSql}` : sql``}${withLevelChanges ? sql` or ${usageLevelChangeSql}` : sql``}`
      : null
  const eventRows = kindEvents.length
    ? sql`select e.id, e.created_at as at, e.event as what, e.method, e.user_id as actor_id, e.email as email_then,
        null::text as impersonated_by, null::text as setup_key_id, e.workspace_id, null::jsonb as input,
        (select s.email from "user" s where s.id = e.subject_id) as subject_email, null::jsonb as transfer_changes, false as transfer_change,
        null::jsonb as usage_level_change, false as level_change,
        null::text as api_key_name, false as refused, e.ip_address, 'auth' as source
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
          ? (AUDITED_ACTIONS[r.what] ??
            (r.transfer_change
              ? TRANSFER_CHANGE_KIND
              : r.level_change
                ? USAGE_LEVEL_CHANGE_KIND
                : r.setup_key_id
                  ? 'integrations'
                  : 'impersonation'))
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
      ...(r.transfer_changes && typeof r.transfer_changes === 'object'
        ? { transferChanges: namesOf(r.transfer_changes as TransferChanges) }
        : {}),
      ...(r.usage_level_change && typeof r.usage_level_change === 'object'
        ? { usageLevelChange: r.usage_level_change as AuditedLevelChange }
        : {}),
      ...(r.api_key_name ? { apiKeyName: String(r.api_key_name) } : {}),
      refused: Boolean(r.refused),
      ipAddress: r.ip_address,
    }),
  )
  const last = page.at(-1)
  return { entries, next: rows.length > limit && last ? `${last.at_iso}|${last.id}` : null }
}
