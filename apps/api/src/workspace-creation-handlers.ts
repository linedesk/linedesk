// workspace.create (packages/actions/src/workspace-creation.ts): a server admin makes a workspace for a business and
// gives it its one owner. Who may create workspaces at all: workspace-creation.ts.
import type { WorkspaceCreateData } from '@linedesk/actions'
import { assistants, organization, user, workspace_settings } from '@linedesk/db'
import { sql } from 'drizzle-orm'
import { adminHandlers } from './admin-handlers.ts'
import type { Handler } from './handler-context.ts'
import { Reject } from './handler-context.ts'
import { newAssistant, newWorkspaceSettings } from './onboarding.ts'

const slugOf = (name: string) =>
  `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 6)}`

export const workspaceCreationHandlers: Record<string, Handler> = {
  /**
   * The workspace, its assistant and settings, then its owner through Add user (user.invite with role owner): the
   * same rules for who joins at once and who is invited, the same emails, in the same transaction. Nothing is left
   * behind when the owner cannot be added (no email delivery, a disabled account). No `signup` milestone here: the
   * setup emails count from when the owner joins (memberships.ts, ownerJoined), not from when the admin typed the name.
   */
  'workspace.create': async (
    ctx,
    input: { name: string; timeZone?: string; owner: { email: string; name?: string } },
  ) => {
    const { tx, now } = ctx
    const email = input.owner.email.trim().toLowerCase()
    const [existing] = await tx.select({ name: user.name }).from(user).where(sql`lower(${user.email}) = ${email}`)
    const ownerName = input.owner.name ?? existing?.name
    if (!ownerName) throw new Reject(`${email} has no account yet: enter the owner's name`)
    const id = crypto.randomUUID().replaceAll('-', '')
    const [org] = await tx
      .insert(organization)
      .values({ id, name: input.name, slug: slugOf(input.name), createdAt: new Date(now) })
      .returning({ id: organization.id, name: organization.name })
    await tx.insert(assistants).values(newAssistant(org!.id, input.name))
    await tx.insert(workspace_settings).values(newWorkspaceSettings(org!.id, input.timeZone))
    const added = await adminHandlers['user.invite']!(ctx, {
      email,
      name: ownerName,
      workspaceId: org!.id,
      role: 'owner',
    })
    const invited = added.data as { userId: string; existing: boolean; workspace: { joined: 'added' | 'invited' } }
    const data: WorkspaceCreateData & { subject: { email: string; workspaceId: string } } = {
      workspace: { id: org!.id, name: org!.name },
      owner: { userId: invited.userId, email, existing: invited.existing, joined: invited.workspace.joined },
      // The audit log files the entry under the new workspace, with its owner.
      subject: { email, workspaceId: org!.id },
    }
    return { rows: {}, data }
  },
}
