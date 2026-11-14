// notifications.* handlers: a member reads and changes only their own row in their workspace;
// owners and admins set the workspace defaults (settings:write, checked by the registry). Owners and admins
// change a teammate's row through team.updateMemberNotifications (team-member-edit.ts), with the same helpers.
import { type ChangedBy, DEFAULT_NOTIFICATIONS, type NotificationSettingsData } from '@linedesk/actions'
import { member_notification_settings, type Tx, user, workspace_settings } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import { emailDelivery } from './auth-methods.ts'
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
export async function loadSettingsOf(tx: Tx, of: NotificationsOf, canEditDefaults: boolean): Promise<NotificationSettingsData> {
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

  'notifications.setDefaults': async ({ tx, actor }, input: { email?: boolean; browser?: boolean }) => {
    const { workspaceId } = memberOf(actor)
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
