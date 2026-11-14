// A passkey on top of the admin area (docs/architecture.md §12). Any recent sign-in opens Admin, so
// someone with only an admin's mailbox, password or provider account gets that far. What would let
// them keep the role or take over passkeys needs a passkey sign-in in the last 12 hours: granting
// admin, resetting passkeys, inviting an admin (these hand out enrolment codes), signing in as a
// user, deleting a workspace, adding anyone to a workspace or making them owner or admin there, any action on an instance admin (by user or by workspace membership), the caller
// included, and changing email or sign-in settings (an SMTP server or sign-in provider of an
// attacker's own would hand them sign-in codes or any account). Admins without a passkey add their first with the enrolment code (passkey-enrolment.ts).
// The server operator (CLI) needs none.
import { type ActionDef, providerNames, providerSpec, restartCategories } from '@linedesk/actions'
import { member, passkey, user } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { adminSecondFactorRequired } from './admin-second-factor.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { s3EndpointProblem } from './s3-endpoint.ts'

export const PASSKEY_STEP_UP_REQUIRED = 'PASSKEY_STEP_UP_REQUIRED'

/**
 * Actions that always need the passkey: they hand out admin rights, enrolment codes or someone else's account,
 * destroy a whole workspace's data for good, or hand the email and sign-in step-up to an AI agent's setup key.
 */
const ALWAYS = new Set([
  'instanceAdmin.grant',
  'user.resetPasskeys',
  'user.impersonate',
  'workspace.delete',
  // Adds someone to any workspace (or invites them): access to a business's calls.
  'membership.add',
  // Lets an AI agent's setup key change email and sign-in (agent-setup.ts): the same rule as doing it yourself.
  'agentSetup.confirmPasskey',
])

/** The user an admin action is about: its `userId`, or the user of its `memberId` (membership.setRole, .remove). */
async function targetUserId(fields: { userId?: unknown; memberId?: unknown }): Promise<string | null> {
  if (typeof fields.userId === 'string') return fields.userId
  if (typeof fields.memberId !== 'string') return null
  const [row] = await db.select({ userId: member.userId }).from(member).where(eq(member.id, fields.memberId))
  return row?.userId ?? null
}

/**
 * provider.setKeys / clearKeys of email or sign-in, or which email provider sends (setActive): whoever controls these
 * can sign in as anyone.
 */
export function changesSignInOrEmail(name: string, input: unknown): boolean {
  if (name === 'provider.setActive') {
    const category = (input as { category?: unknown } | null)?.category
    return typeof category === 'string' && (restartCategories as readonly string[]).includes(category)
  }
  if (name !== 'provider.setKeys' && name !== 'provider.clearKeys') return false
  const provider = (input as { provider?: unknown } | null)?.provider
  if (typeof provider !== 'string' || !(providerNames as string[]).includes(provider)) return false
  return restartCategories.includes(providerSpec(provider as (typeof providerNames)[number]).category)
}

/** Whether this admin action needs a passkey sign-in: see the file comment. */
export async function needsPasskeyStepUp(name: string, input: unknown): Promise<boolean> {
  if (ALWAYS.has(name) || changesSignInOrEmail(name, input)) return true
  const fields = (input ?? {}) as {
    admin?: unknown
    userId?: unknown
    memberId?: unknown
    role?: unknown
    workspaceId?: unknown
  }
  // Who is in a workspace, and as owner or admin: an admin's stolen first factor must not hand out access to a
  // business's calls (security review of #671).
  if (name === 'user.invite') return fields.admin === true || Boolean(fields.workspaceId)
  if (name === 'membership.setRole' && (fields.role === 'owner' || fields.role === 'admin')) return true
  const userId = await targetUserId(fields)
  if (!userId) return false
  const [target] = await db.select().from(user).where(eq(user.id, userId))
  return Boolean(target && isInstanceAdmin(target))
}

/**
 * An AI agent's setup key storing a recording storage endpoint on this server or a private network (or one that does
 * not resolve): like email, only with the admin's passkey Allow (s3-endpoint.ts). A leaked setup link must not probe
 * or write to internal services. Link-local endpoints are refused for everyone by the handler instead.
 */
export async function setsPrivateS3Endpoint(name: string, input: unknown, actor: Actor): Promise<boolean> {
  if (!actor.setupKeyId || name !== 'provider.setKeys') return false
  const { provider, values } = (input ?? {}) as { provider?: unknown; values?: { endpoint?: unknown } }
  if (provider !== 's3' || typeof values?.endpoint !== 'string') return false
  const problem = await s3EndpointProblem(values.endpoint, 'public')
  return Boolean(problem && problem.kind !== 'link_local')
}

/** `confirm`: sign in with your passkey; `enrol`: add your first passkey (with an enrolment code). */
export type StepUp = 'confirm' | 'enrol'

/** The 403 body when this admin action needs a passkey sign-in the caller's session lacks, else null. */
export async function passkeyStepUpRefusal(def: Pick<ActionDef, 'name' | 'permission'>, input: unknown, actor: Actor) {
  if (def.permission !== 'instance:admin' || actor.passkeyConfirmed || !adminSecondFactorRequired()) return null
  const privateEndpoint = await setsPrivateS3Endpoint(def.name, input, actor)
  if (!privateEndpoint && !(await needsPasskeyStepUp(def.name, input))) return null
  const [own] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, actor.actorId)).limit(1)
  const stepUp: StepUp = own ? 'confirm' : 'enrol'
  const error =
    stepUp === 'confirm'
      ? 'Confirm with your passkey to do this.'
      : 'This needs a passkey. Add your first under Account, Sign-in & security with the enrolment code another admin or the server gives you.'
  return {
    ok: false as const,
    error,
    code: PASSKEY_STEP_UP_REQUIRED,
    stepUp,
    // What the passkey is for, when it is not email or sign-in (setup-mcp.ts says it to the agent).
    ...(privateEndpoint ? { reason: 'private_endpoint' as const } : {}),
  }
}

/**
 * An instance admin who has no passkey on an install that asks for one: email and sign-in settings wait for it, so the
 * first-run setup asks for the passkey first (install-setup.ts, setup-mcp.ts).
 */
export async function passkeyStillNeeded(userId: string): Promise<boolean> {
  if (!adminSecondFactorRequired()) return false
  const [own] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId)).limit(1)
  return !own
}

/** For handlers that hand out an enrolment code: never to a session that is not passkey-confirmed. */
export function mayReceiveEnrolmentCode(actor: Actor): boolean {
  return Boolean(actor.passkeyConfirmed) || !adminSecondFactorRequired()
}
