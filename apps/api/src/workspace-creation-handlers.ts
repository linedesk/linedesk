// workspace.create (packages/actions/src/workspace-creation.ts): the one path for every new workspace. A server admin
// makes a workspace for a business and gives it its one owner, or makes one of their own (the app's New workspace,
// POST /v1/workspaces in app.ts, and the setup MCP's workspace_create). Who may create workspaces at all:
// workspace-creation.ts.
import { type CountryHint, countryHintOf, type WorkspaceCreateData, workspaceTimeZoneFor } from '@linedesk/actions'
import { agent_setup_keys, assistants, organization, session, user, workspace_settings } from '@linedesk/db'
import { eq, sql } from 'drizzle-orm'
import { adminHandlers } from './admin-handlers.ts'
import type { Handler, HandlerCtx } from './handler-context.ts'
import { Forbidden, Reject } from './handler-context.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { newAssistantTransfers } from './default-transfers.ts'
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

type CreateInput = {
  name: string
  timeZone?: string
  country?: string
  countryHint?: CountryHint
  owner?: { email: string; name?: string }
}

/**
 * The country hint a new workspace keeps: what the app prefilled its country with, else the country of the time zone
 * the caller sent (never the stored fallback, US Eastern, which nobody said). For another owner, never the admin's
 * own sign-up location: the hint is about where the business is, and that is not where the admin sits.
 */
export function creationHint(input: Pick<CreateInput, 'timeZone' | 'countryHint'>, forOther: boolean) {
  const given = input.countryHint
  if (given && !(forOther && given.source === 'sign_up_location')) return given
  return countryHintOf({ timeZone: input.timeZone })
}

/**
 * The workspace with its assistant and settings. The country only as picked (left as prefilled it stays Automatic,
 * so a number connected later still decides it), and the country hint (creationHint): only a code and its source.
 * The time zone follows the country.
 */
export async function insertWorkspace({ tx, now, actor }: HandlerCtx, input: CreateInput, forOther = false) {
  const { name } = input
  const id = crypto.randomUUID().replaceAll('-', '')
  const [org] = await tx
    .insert(organization)
    .values({ id, name, slug: slugOf(name), createdAt: new Date(now) })
    .returning({ id: organization.id, name: organization.name })
  const hint = creationHint(input, forOther)
  // The time zone sent (the browser's) when it is in the country (as picked, else as hinted), else that country's main
  // zone (decisions.md 2026-11-17, LIN-433: a US business set up from a browser in Berlin gets US Eastern).
  const timeZone = workspaceTimeZoneFor(input.country ?? hint?.country, input.timeZone) ?? undefined
  const settings = newWorkspaceSettings(org!.id, timeZone)
  await tx.insert(workspace_settings).values({
    ...settings,
    country: input.country ?? null,
    country_hint: hint?.country ?? null,
    country_hint_source: hint?.source ?? null,
  })
  // After the settings: the assistant's first contact is named in the workspace's language, which they decide. For
  // another owner, never the admin's own language.
  const transfers = await newAssistantTransfers(tx, org!.id, forOther ? null : actor.locale)
  await tx.insert(assistants).values(newAssistant(org!.id, name, transfers))
  return org!
}

/**
 * The caller's account row, locked for this transaction and checked again under the lock: not disabled, still a server
 * admin (either can change after the caller was resolved). Every creation goes through it, with an owner or without.
 */
async function lockedAdmin({ tx, actor }: HandlerCtx) {
  const [me] = await tx.select().from(user).where(eq(user.id, actor.actorId)).for('update')
  if (!me) throw new Reject('user not found')
  if (me.disabledAt || !isInstanceAdmin(me)) throw new Forbidden(WORKSPACE_CREATION_CLOSED)
  return me
}

/** A setup link makes only the admin's own workspaces: its cap is counted there (createOwn). */
export const SETUP_LINK_NO_OWNER = "A setup link creates only the admin's own workspaces."

/**
 * A workspace of the admin's own: they are its owner at once, through a member row (no invitation), and it becomes
 * the active workspace of the session that made it. Their account row is locked first and checked again under the
 * lock (not disabled, still a server admin: either can change after the caller was resolved). There is no limit on
 * how many (WORKSPACE_LIMIT is retired, workspace-creation.ts). Made with a setup link: its row is locked and its cap
 * counted in this transaction, so API processes running side by side cannot pass it (setup-mcp.ts keeps its own quick
 * check in front). The `signup` milestone is recorded here, once, by addToWorkspace (memberships.ts, ownerJoined):
 * the owner is in the workspace from its first moment.
 */
async function createOwn(ctx: HandlerCtx, input: CreateInput): Promise<Created> {
  const { tx, actor, now } = ctx
  const me = await lockedAdmin(ctx)
  if (actor.setupKeyId) {
    const [key] = await tx
      .select({ id: agent_setup_keys.id })
      .from(agent_setup_keys)
      .where(eq(agent_setup_keys.id, actor.setupKeyId))
      .for('update')
    if (!key) throw new Forbidden(WORKSPACE_CREATION_CLOSED)
    if ((await workspacesMadeBy(tx, key.id)) >= SETUP_LINK_WORKSPACE_CAP) throw new Reject(SETUP_LINK_CAP_TEXT)
  }
  const org = await insertWorkspace(ctx, input)
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
  'workspace.create': async (ctx, input: CreateInput) => {
    if (!input.owner) return { rows: {}, data: await createOwn(ctx, input) }
    const { tx } = ctx
    // No setup tool passes an owner today; one that did would get past the link's cap (security review of #761, F3).
    if (ctx.actor.setupKeyId) throw new Forbidden(SETUP_LINK_NO_OWNER)
    const self = await lockedAdmin(ctx)
    const email = input.owner.email.trim().toLowerCase()
    // Their own address as the owner is their own workspace: the same path and checks as without one.
    if (self.email.toLowerCase() === email) return { rows: {}, data: await createOwn(ctx, input) }
    const [existing] = await tx.select({ name: user.name }).from(user).where(sql`lower(${user.email}) = ${email}`)
    const ownerName = input.owner.name ?? existing?.name
    if (!ownerName) throw new Reject(`${email} has no account yet: enter the owner's name`)
    const org = await insertWorkspace(ctx, input, true)
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
