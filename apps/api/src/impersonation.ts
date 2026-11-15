// An instance admin signs in as a user (docs/architecture.md §12). Both steps are registry
// actions (user.impersonate, impersonation.stop); since an action cannot set cookies, two thin
// routes (impersonation-routes.ts) run them and move Better Auth's session cookie. Sessions are Better Auth's own, created
// with its internal adapter; cookies are signed the way Better Auth signs them.
import { IMPERSONATION_MINUTES, type ImpersonationEmailsData, type UserImpersonateData } from '@linedesk/actions'
import { instance_settings, member, organization, session, user } from '@linedesk/db'
import { and, asc, eq } from 'drizzle-orm'
import { auth } from './auth.ts'
import { db } from './db.ts'
import { sendNotice } from './email.ts'
import { localeForUserId } from './email-locale.ts'
import { impersonationStartedEmail } from './emails/templates.ts'
import { EMAILS_SETTING, emailConnected, impersonationEmailsOn, impersonationNoticesGoOut } from './impersonation-emails.ts'
import { type Handler, Forbidden, Reject } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'

export const IMPERSONATION_SEC = IMPERSONATION_MINUTES * 60

/** The actions that only run through the routes in impersonation-routes.ts: they need cookies set. */
export const COOKIE_ACTIONS: readonly string[] = ['user.impersonate', 'impersonation.stop']

type ImpersonateInput = { userId: string; reason: string; workspaceId?: string }

export const impersonationHandlers: Record<string, Handler> = {
  'user.impersonate': async ({ tx, actor, now, onRollback, onCommit }, input: ImpersonateInput) => {
    if (actor.impersonation) throw new Reject('return to your own account first')
    if (input.userId === actor.actorId) throw new Reject('you cannot sign in as yourself')
    const [target] = await tx.select().from(user).where(eq(user.id, input.userId))
    if (!target) throw new Reject('user not found')
    if (target.disabledAt) throw new Reject('this user is disabled')
    if (isInstanceAdmin(target)) throw new Forbidden('you cannot sign in as another instance admin')
    // The workspace asked for (Server admin › Workspaces › Sign in as owner) only when the user is a member of it.
    const [first] = await tx
      .select({ workspaceId: member.organizationId, name: organization.name })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(
        input.workspaceId
          ? and(eq(member.userId, target.id), eq(member.organizationId, input.workspaceId))
          : eq(member.userId, target.id),
      )
      .orderBy(asc(member.createdAt))
      .limit(1)
    if (input.workspaceId && !first) throw new Reject('this user is not a member of that workspace')
    const expiresAt = new Date(Date.now() + IMPERSONATION_SEC * 1000)
    // Better Auth's own session on its own connection, committed now; removed again if the command does not commit.
    const { internalAdapter } = await auth.$context
    const created = await internalAdapter.createSession(
      target.id,
      true,
      { impersonatedBy: actor.actorId, expiresAt, activeOrganizationId: first?.workspaceId ?? null },
      true,
    )
    onRollback?.(async () => {
      await db.delete(session).where(eq(session.id, created.id))
      return 'the session was removed again'
    })
    // One email to the user at the start, when the install turned it on and email goes out over SMTP (the same check as
    // impersonationEmails.get); queued here, sent once the command has committed. `notified` means "notice queued".
    const notified = await impersonationNoticesGoOut(tx)
    if (notified) {
      const [admin] = await tx.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, actor.actorId))
      const locale = await localeForUserId(tx, target.id)
      const email = impersonationStartedEmail(
        { admin: { name: admin?.name ?? '', email: admin?.email ?? '' }, reason: input.reason, at: now, workspace: first?.name ?? null, minutes: IMPERSONATION_MINUTES },
        undefined,
        locale,
      )
      onCommit?.(async () => sendNotice({ to: target.email, ...email }, 'impersonation email'))
    }
    const data: UserImpersonateData = {
      sessionId: created.id,
      userId: target.id,
      workspaceId: first?.workspaceId ?? null,
      expiresAt: expiresAt.toISOString(),
      // Whom it was, in the audit log, filed under the workspace it opened in.
      subject: { email: target.email, workspaceId: first?.workspaceId ?? null },
      notified,
    }
    return { rows: {}, data }
  },

  'impersonationEmails.get': async ({ tx }) => ({
    rows: {},
    data: { on: await impersonationEmailsOn(tx), emailConnected: emailConnected() } satisfies ImpersonationEmailsData,
  }),

  'impersonationEmails.set': async ({ tx, actor, now }, input: { on: boolean }) => {
    const value = input.on ? 'on' : 'off'
    await tx
      .insert(instance_settings)
      .values({ key: EMAILS_SETTING, value, updated_at: now, updated_by: actor.actorId })
      .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actor.actorId } })
    return { rows: {}, data: { on: input.on, emailConnected: emailConnected() } satisfies ImpersonationEmailsData }
  },

  'impersonation.stop': async ({ tx, actor }) => {
    if (!actor.impersonation) throw new Reject('you are not signed in as another user')
    await tx.delete(session).where(eq(session.id, actor.impersonation.sessionId))
    return { rows: {}, data: { userId: actor.actorId, impersonatedBy: actor.impersonation.by } }
  },
}
