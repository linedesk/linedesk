// workspace.create (packages/actions/src/workspace-creation.ts): the one path for every new workspace. A server admin
// makes a workspace for a business and gives it its one owner, or makes one of their own (the app's New workspace,
// POST /v1/workspaces in app.ts, and the setup MCP's workspace_create). Who may create workspaces at all:
// workspace-creation.ts.
import type { WorkspaceCreateData } from '@linedesk/actions'
import { agent_setup_keys, assistants, member, organization, session, user, workspace_settings } from '@linedesk/db'
import { count, eq, sql } from 'drizzle-orm'
import { adminHandlers } from './admin-handlers.ts'
import { WORKSPACE_LIMIT, workspaceLimitText } from './auth.ts'
import type { Handler, HandlerCtx } from './handler-context.ts'
import { Forbidden, Reject } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { addToWorkspace } from './memberships.ts'
import { newAssistant, newWorkspaceSettings } from './onboarding.ts'
import {
  SETUP_LINK_CAP_TEXT,
  SETUP_LINK_WORKSPACE_CAP,
  WORKSPACE_CREATION_CLOSED,
  workspacesMadeBy,
} from './workspace-creation.ts'

const slugOf = (name: string) =>
  `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 6)}`

type Created = WorkspaceCreateData & { subject: { email: string; workspaceId: string } }

/** The workspace with its assistant and settings. */
async function insertWorkspace({ tx, now }: HandlerCtx, name: string, timeZone: string | undefined) {
  const id = crypto.randomUUID().replaceAll('-', '')
  const [org] = await tx
    .insert(organization)
    .values({ id, name, slug: slugOf(name), createdAt: new Date(now) })
    .returning({ id: organization.id, name: organization.name })
  await tx.insert(assistants).values(newAssistant(org!.id, name))
  await tx.insert(workspace_settings).values(newWorkspaceSettings(org!.id, timeZone))
  return org!
}

/**
 * A workspace of the admin's own: they are its owner at once, through a member row (no invitation), and it becomes
 * the active workspace of the session that made it. Their account row is locked first and checked again under the
 * lock (not disabled, still a server admin: either can change after the caller was resolved), so two creations at
 * once cannot both pass the workspace limit (WORKSPACE_LIMIT, auth.ts), which counts the admin's memberships as Better
 * Auth's organizationLimit did. Made with a setup link: its row is locked too and its cap counted in this transaction,
 * so API processes running side by side cannot pass it either (setup-mcp.ts keeps its own quick check in front). The
 * `signup` milestone is recorded here, once, by addToWorkspace (memberships.ts, ownerJoined): the owner is in the
 * workspace from its first moment.
 */
async function createOwn(ctx: HandlerCtx, input: { name: string; timeZone?: string }): Promise<Created> {
  const { tx, actor, now } = ctx
  const [me] = await tx.select().from(user).where(eq(user.id, actor.actorId)).for('update')
  if (!me) throw new Reject('user not found')
  if (me.disabledAt || !isInstanceAdmin(me)) throw new Forbidden(WORKSPACE_CREATION_CLOSED)
  if (actor.setupKeyId) {
    const [key] = await tx
      .select({ id: agent_setup_keys.id })
      .from(agent_setup_keys)
      .where(eq(agent_setup_keys.id, actor.setupKeyId))
      .for('update')
    if (!key) throw new Forbidden(WORKSPACE_CREATION_CLOSED)
    if ((await workspacesMadeBy(tx, key.id)) >= SETUP_LINK_WORKSPACE_CAP) throw new Reject(SETUP_LINK_CAP_TEXT)
  }
  if (WORKSPACE_LIMIT !== null) {
    const [mine] = await tx.select({ n: count() }).from(member).where(eq(member.userId, me.id))
    if ((mine?.n ?? 0) >= WORKSPACE_LIMIT) throw new Reject(workspaceLimitText(WORKSPACE_LIMIT))
  }
  const org = await insertWorkspace(ctx, input.name, input.timeZone)
  await addToWorkspace(tx, me, org, 'owner', now)
  if (actor.sessionId)
    await tx.update(session).set({ activeOrganizationId: org.id }).where(eq(session.id, actor.sessionId))
  return {
    workspace: { id: org.id, name: org.name },
    owner: { userId: me.id, email: me.email, existing: true, joined: 'added' },
    // The audit log files the entry under the new workspace, with its owner (the admin).
    subject: { email: me.email, workspaceId: org.id },
  }
}

export const workspaceCreationHandlers: Record<string, Handler> = {
  /**
   * With an owner: the workspace, its assistant and settings, then its owner through Add user (user.invite with role
   * owner): the same rules for who joins at once and who is invited, the same emails, in the same transaction. Nothing
   * is left behind when the owner cannot be added (no email delivery, a disabled account). No `signup` milestone here:
   * the setup emails count from when the owner joins (memberships.ts, ownerJoined), not from when the admin typed the
   * name. Without an owner, or with the admin's own address as the owner: the admin's own workspace (createOwn).
   */
  'workspace.create': async (
    ctx,
    input: { name: string; timeZone?: string; owner?: { email: string; name?: string } },
  ) => {
    if (!input.owner) return { rows: {}, data: await createOwn(ctx, input) }
    const { tx } = ctx
    const email = input.owner.email.trim().toLowerCase()
    // Their own address as the owner is their own workspace: the same path, lock and workspace limit as without one.
    const [self] = await tx.select({ email: user.email }).from(user).where(eq(user.id, ctx.actor.actorId))
    if (self && self.email.toLowerCase() === email) return { rows: {}, data: await createOwn(ctx, input) }
    const [existing] = await tx.select({ name: user.name }).from(user).where(sql`lower(${user.email}) = ${email}`)
    const ownerName = input.owner.name ?? existing?.name
    if (!ownerName) throw new Reject(`${email} has no account yet: enter the owner's name`)
    const org = await insertWorkspace(ctx, input.name, input.timeZone)
    const added = await adminHandlers['user.invite']!(ctx, {
      email,
      name: ownerName,
      workspaceId: org.id,
      role: 'owner',
    })
    const invited = added.data as { userId: string; existing: boolean; workspace: { joined: 'added' | 'invited' } }
    const data: Created = {
      workspace: { id: org.id, name: org.name },
      owner: { userId: invited.userId, email, existing: invited.existing, joined: invited.workspace.joined },
      // The audit log files the entry under the new workspace, with its owner.
      subject: { email, workspaceId: org.id },
    }
    return { rows: {}, data }
  },
}
