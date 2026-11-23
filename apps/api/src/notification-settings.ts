// notifications.* handlers: a member reads and changes only their own row in their workspace;
// owners and admins set the workspace defaults (settings:write, checked by the registry). Owners and admins
// change a teammate's row through team.updateMemberNotifications (team-member-edit.ts), with the same helpers.
// callEmails.get: Who hears about calls (Assistant settings, LIN-768), each member's "Email for every call" for everyone.
import {
  type CallEmailsData,
  type ChangedBy,
  DEFAULT_NOTIFICATIONS,
  type NotificationSettingsData,
} from '@linedesk/actions'
import { member, member_notification_settings, type Tx, user, workspace_settings } from '@linedesk/db'
import { and, eq, isNull, or } from 'drizzle-orm'
import { emailDelivery } from './auth-methods.ts'
import { previewDeps } from './email-routing.ts'
import type { Actor } from './context.ts'
import { type Handler, Reject } from './handler-context.ts'
import { pushSettings } from './push.ts'
import { setupEmailsOn } from './setup-emails.ts'

/** Used until a workspace has stored its own time zone (same default as onboarding). */
const DEFAULT_TIME_ZONE = 'America/New_York'

type Channels = { email?: boolean | null; browser?: boolean | null }
export type OwnInput = Channels & { pushSummary?: boolean; assignedEmail?: boolean; setupEmails?: boolean }

/** A member of a workspace, not the voice agent: only people have notification settings. */
function memberOf(actor: Actor): { workspaceId: string; userId: string } {
  if (!actor.workspaceId || actor.role === 'agent') throw new Reject('no workspace')
  return { workspaceId: actor.workspaceId, userId: actor.actorId }
}

/** Whose settings are read: a member of a workspace, with their role there (setup emails are for owners only). */
export type NotificationsOf = { workspaceId: string; userId: string; role: string }

/** The member's name for "Last changed by …"; someone who has left reads "A teammate". */
async function changedBy(tx: Tx, by: string | null, userId: string, at: Date | string): Promise<ChangedBy | null> {
  if (!by || by === userId) return null
  const [who] = await tx.select({ name: user.name }).from(user).where(eq(user.id, by))
  return { name: who?.name.trim() || 'A teammate', at: new Date(at).toISOString() }
}

/** `canEditDefaults`: whether whoever reads may change the workspace defaults. */
export async function loadSettingsOf(
  tx: Tx,
  of: NotificationsOf,
  canEditDefaults: boolean,
): Promise<NotificationSettingsData> {
  const { workspaceId, userId } = of
  const [ws] = await tx.select().from(workspace_settings).where(eq(workspace_settings.workspace_id, workspaceId))
  const [own] = await tx
    .select()
    .from(member_notification_settings)
    .where(
      and(eq(member_notification_settings.workspace_id, workspaceId), eq(member_notification_settings.user_id, userId)),
    )
  const defaults = {
    email: ws?.notify_email_default ?? DEFAULT_NOTIFICATIONS.email,
    browser: ws?.notify_browser_default ?? DEFAULT_NOTIFICATIONS.browser,
  }
  const mine = { email: own?.email ?? null, browser: own?.browser ?? null }
  return {
    effective: { email: mine.email ?? defaults.email, browser: mine.browser ?? defaults.browser },
    own: mine,
    defaults,
    canEditDefaults,
    push: await pushSettings(tx, workspaceId, userId, own?.push_summary ?? null),
    assignedEmail: own?.assigned_email ?? true,
    // Only owners get setup emails (setup-emails.ts).
    setupEmails: of.role === 'owner' && (await setupEmailsOn(tx)) ? (own?.setup_emails ?? true) : null,
    emailReady: emailDelivery(process.env) === 'smtp',
    changedBy: own ? await changedBy(tx, own.updated_by, userId, own.updated_at) : null,
  }
}

const loadSettings = (tx: Tx, actor: Actor) =>
  loadSettingsOf(tx, { ...memberOf(actor), role: actor.role }, actor.permissions.includes('settings:write'))

/** The columns of the settings a change names; the others keep their values. */
export function settingsChanges({ pushSummary, assignedEmail, setupEmails, ...channels }: OwnInput) {
  return {
    ...named(channels),
    ...(pushSummary === undefined ? {} : { push_summary: pushSummary }),
    ...(assignedEmail === undefined ? {} : { assigned_email: assignedEmail }),
    ...(setupEmails === undefined ? {} : { setup_emails: setupEmails }),
  }
}

/** Writes a member's settings in a workspace; `by`: who changed them (the member, or an owner or admin). */
export async function writeSettings(
  tx: Tx,
  of: { workspaceId: string; userId: string },
  changes: ReturnType<typeof settingsChanges>,
  by: string,
  now: string,
) {
  const set = { ...changes, updated_at: now, updated_by: by }
  await tx
    .insert(member_notification_settings)
    .values({ workspace_id: of.workspaceId, user_id: of.userId, ...set })
    .onConflictDoUpdate({
      target: [member_notification_settings.workspace_id, member_notification_settings.user_id],
      set,
    })
}

/** The email default a workspace has now (the team default new teammates start with). */
async function emailDefault(tx: Tx, workspaceId: string): Promise<boolean> {
  const [ws] = await tx
    .select({ email: workspace_settings.notify_email_default })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  return ws?.email ?? DEFAULT_NOTIFICATIONS.email
}

/**
 * Before the email default changes: every member who still follows it (no row, or no own email setting) keeps what
 * they get now, as their own setting. So the default is only what a new teammate starts with ("New teammates"), and
 * a member's row in Who hears about calls never flips by itself. Not a change by someone else (`updated_by` stays):
 * the member's own page says nothing about it.
 */
async function pinEmailFollowers(tx: Tx, workspaceId: string, current: boolean, now: string) {
  const followers = await tx
    .select({ userId: member.userId })
    .from(member)
    .leftJoin(
      member_notification_settings,
      and(
        eq(member_notification_settings.workspace_id, member.organizationId),
        eq(member_notification_settings.user_id, member.userId),
      ),
    )
    .where(
      and(
        eq(member.organizationId, workspaceId),
        or(isNull(member_notification_settings.user_id), isNull(member_notification_settings.email)),
      ),
    )
  if (!followers.length) return
  await tx
    .insert(member_notification_settings)
    .values(followers.map(f => ({ workspace_id: workspaceId, user_id: f.userId, email: current, updated_at: now })))
    .onConflictDoUpdate({
      target: [member_notification_settings.workspace_id, member_notification_settings.user_id],
      set: { email: current },
    })
}

/** Who hears about calls: every member who is not disabled, with their "Email for every call", and the default. */
async function loadCallEmails(
  tx: Tx,
  { workspaceId, userId }: { workspaceId: string; userId: string },
): Promise<CallEmailsData> {
  const [fallback, rows, model] = await Promise.all([
    emailDefault(tx, workspaceId),
    tx
      .select({ userId: member.userId, own: member_notification_settings.email })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .leftJoin(
        member_notification_settings,
        and(
          eq(member_notification_settings.workspace_id, member.organizationId),
          eq(member_notification_settings.user_id, member.userId),
        ),
      )
      .where(and(eq(member.organizationId, workspaceId), isNull(user.disabledAt))),
    previewDeps.model(tx).catch(() => null),
  ])
  return {
    you: userId,
    members: rows.map(r => ({ userId: r.userId, everyCall: r.own ?? fallback })),
    newTeammates: fallback,
    llm: !!model,
  }
}

/** Only the fields the input names: an omitted channel keeps its value, null goes back to the default. */
const named = (input: Channels) =>
  Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Channels

export const notificationHandlers: Record<string, Handler> = {
  'notifications.get': async ({ tx, actor }) => ({ rows: {}, data: await loadSettings(tx, actor) }),

  'notifications.update': async ({ tx, actor, now }, input: OwnInput) => {
    const { workspaceId, userId } = memberOf(actor)
    await writeSettings(tx, { workspaceId, userId }, settingsChanges(input), userId, now)
    return { rows: {}, data: await loadSettings(tx, actor) }
  },

  'callEmails.get': async ({ tx, actor }) => ({ rows: {}, data: await loadCallEmails(tx, memberOf(actor)) }),

  'notifications.setDefaults': async ({ tx, actor, now }, input: { email?: boolean; browser?: boolean }) => {
    const { workspaceId } = memberOf(actor)
    if (input.email !== undefined) {
      const current = await emailDefault(tx, workspaceId)
      if (current !== input.email) await pinEmailFollowers(tx, workspaceId, current, now)
    }
    const set = {
      ...(input.email === undefined ? {} : { notify_email_default: input.email }),
      ...(input.browser === undefined ? {} : { notify_browser_default: input.browser }),
    }
    if (Object.keys(set).length) {
      await tx
        .insert(workspace_settings)
        .values({ workspace_id: workspaceId, timezone: DEFAULT_TIME_ZONE, ...set })
        .onConflictDoUpdate({ target: workspace_settings.workspace_id, set })
    }
    return { rows: {}, data: await loadSettings(tx, actor) }
  },
}
