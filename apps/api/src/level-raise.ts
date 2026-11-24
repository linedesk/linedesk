// Who may change an assistant's call quality (replacing "only the person who pays"):
// - Raising it to Premium or Ultra where levels are billed: a workspace owner or admin, signed in to the app as
//   themselves (refuseBillingActor: never an API key, a personal key or a setup link). An instance admin's
//   impersonation of such an owner or admin raises only with edits on (LIN-708: it then works as the user). Who pays
//   is not asked; the bill of the workspace pays the level, as before.
// - Lowering it, or changing the models within it: anyone who edits the assistant.
// - In a white-label client (docs/white-label.md): the partner's team always (they are admins there); the client's own
//   owner and admins only while the partner lets them (`workspace_settings.client_call_quality`, partner.setClientCallQuality,
//   off by default); the client's members never. Whoever may not change it there does not see it either.
// Where levels are not billed, everyone who edits may raise outside a white-label client.
import { member, organization, type Tx, workspace_settings } from '@linedesk/db'
import { and, eq } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { Forbidden, LEVEL_CHANGE_REFUSED, LEVEL_RAISE_REFUSED, Reject } from './handler-context.ts'
import { usageLevelsBilled } from './usage-levels.ts'

/** What this caller may do with call quality here (voice.options `callQuality`). */
export type LevelRights = {
  /** May change the level or its models at all; false only in a white-label client the partner keeps it for. */
  mayChange: boolean
  /** May raise an assistant to Premium or Ultra. */
  mayRaise: boolean
}

const isAdmin = (actor: Actor) => actor.role === 'owner' || actor.role === 'admin'

/**
 * In a white-label client: whether the caller may change call quality there at all (the partner's team, or the
 * client's owner or admins while the partner lets them). Null outside a white-label client.
 */
async function partnerClientAllows(tx: Tx, actor: Actor): Promise<boolean | null> {
  const [org] = await tx
    .select({ partnerId: organization.partnerId, clientMay: workspace_settings.client_call_quality })
    .from(organization)
    .leftJoin(workspace_settings, eq(workspace_settings.workspace_id, organization.id))
    .where(eq(organization.id, actor.workspaceId!))
  if (!org?.partnerId) return null
  // On the partner's team: an admin membership marked with the client's partner (partners.ts keeps them in step).
  const [mine] = await tx
    .select({ partnerId: member.partnerId })
    .from(member)
    .where(and(eq(member.organizationId, actor.workspaceId!), eq(member.userId, actor.actorId)))
  if (mine?.partnerId && mine.partnerId === org.partnerId) return true
  return Boolean(org.clientMay) && isAdmin(actor)
}

/**
 * Whether the caller may raise where levels are billed: an owner or admin, signed in to the app (as
 * refuseBillingActor: never an API key, a personal key or a setup link). An instance admin's impersonation of them
 * only with edits on (LIN-708); read-only support access never raises.
 */
function raisesAsSelf(actor: Actor) {
  if (!isAdmin(actor)) return false
  if (actor.impersonation && !actor.impersonation.edits) return false
  return !(actor.apiKeyId || actor.personalKeyId || actor.setupKeyId)
}

/** What the assistant editor offers this caller (read without locks). */
export async function levelRights(tx: Tx, actor: Actor): Promise<LevelRights> {
  if (!actor.workspaceId || actor.workspaceDisabled) return { mayChange: false, mayRaise: false }
  const mayChange = (await partnerClientAllows(tx, actor)) ?? true
  if (!mayChange) return { mayChange, mayRaise: false }
  if (!(await usageLevelsBilled(tx))) return { mayChange, mayRaise: true }
  return { mayChange, mayRaise: raisesAsSelf(actor) }
}

/**
 * Before a save changes what decides an assistant's level (assistant.update, assistant.restoreVersion): refused where
 * the caller may not. `raises`: the level goes up; `changesQuality`: the level or a model pick changes (a white-label
 * client's people change neither while the partner keeps call quality). Every refusal here, a 403 or another (a
 * disabled workspace), is logged for the audit log: as a refused raise when the save raises the level, else as a
 * refused call quality change (a lowering or a model pick).
 */
export async function refuseLevelChange(tx: Tx, actor: Actor, change: { raises: boolean; changesQuality: boolean }) {
  try {
    if (actor.workspaceDisabled) throw Reject.t('server.api.workspaceDisabled')
    if (change.changesQuality && actor.workspaceId && (await partnerClientAllows(tx, actor)) === false)
      throw Forbidden.t('server.api.callQualityPartner')
    if (!change.raises || !(await usageLevelsBilled(tx))) return
    if (!raisesAsSelf(actor)) throw Forbidden.t('server.api.callQualityRaise')
  } catch (e) {
    if (e instanceof Reject) e.reason = change.raises ? LEVEL_RAISE_REFUSED : LEVEL_CHANGE_REFUSED
    throw e
  }
}

/** Before a save raises an assistant to Premium or Ultra: refuseLevelChange for a raise. */
export async function refuseLevelRaise(tx: Tx, actor: Actor) {
  await refuseLevelChange(tx, actor, { raises: true, changesQuality: true })
}

/**
 * Whether a new assistant may start on a paid level (assistant.create: the install's default, or a copy's level): as
 * refuseLevelRaise decides it; anyone else starts it on Standard.
 */
export async function mayStartOnPaidLevel(tx: Tx, actor: Actor): Promise<boolean> {
  if (actor.workspaceDisabled) return false
  try {
    await refuseLevelRaise(tx, actor)
    return true
  } catch (e) {
    if (e instanceof Forbidden) return false
    throw e
  }
}
