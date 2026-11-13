// Server handlers of the admin area actions (packages/actions/src/admin.ts).
import { type ProviderName, providerSpec, restartCategories } from '@linedesk/actions'
import { organization, passkey, session, spending_cap_alerts, type Tx, user } from '@linedesk/db'
import { emailDelivery } from './auth-methods.ts'
import { emailSender } from './email.ts'
import { emailSafeName, welcomeEmail } from './emails/templates.ts'
import { db } from './db.ts'
import { and, eq, or, sql } from 'drizzle-orm'
import { Forbidden, type Handler, Reject } from './handler-context.ts'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { mayReceiveEnrolmentCode } from './admin-step-up.ts'
import type { Actor } from './context.ts'
import { checkInstanceEnvSoon } from './instance-env.ts'
import { anotherAdminRemains, isEnvAdmin, isInstanceAdmin } from './instance-admin.ts'
import { issuePasskeyEnrolment, removeAllPasskeys } from './passkey-enrolment.ts'
import {
  clearProviderKeys,
  linkProviderKey,
  providerStatus,
  resolveProvider,
  setActiveProvider,
  setProviderKeys,
} from './provider-settings.ts'
import { noteProviderFailure, noteProviderOk } from './provider-failures.ts'
import { missingFields, testProvider } from './provider-test.ts'
import { recentTest, rememberTest } from './setup-checklist.ts'
import { dropUserPush } from './push.ts'
import { SecretsKeyError } from './secrets.ts'
import { monthOf, queueSpendingAlerts, spendingCap } from './spending-cap.ts'
import { brandName } from './branding.ts'
import { deleteWorkspace } from './workspace-delete.ts'

const hasPasskey = async (tx: Tx, userId: string) =>
  (await tx.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId)).limit(1)).length > 0

/** A missing or wrong SECRETS_KEY is the operator's to fix: show the reason instead of a server error. */
async function withSecretsKey<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    throw e instanceof SecretsKeyError ? new Reject(e.message) : e
  }
}

const statusOf = async (tx: Tx, provider: ProviderName) =>
  (await providerStatus(tx)).providers.find(p => p.provider === provider)!

async function loadUser(tx: Tx, userId: string) {
  const [account] = await tx.select().from(user).where(eq(user.id, userId))
  if (!account) throw new Reject('user not found')
  return account
}

async function setWorkspaceDisabled(tx: Tx, workspaceId: string, disabledAt: Date | null) {
  const [workspace] = await tx
    .update(organization)
    .set({ disabledAt })
    .where(eq(organization.id, workspaceId))
    .returning({ id: organization.id })
  if (!workspace) throw new Reject('workspace not found')
  return { rows: {}, data: { workspaceId, disabled_at: disabledAt?.toISOString() ?? null } }
}

/**
 * Sets or removes the workspace's monthly spending cap. This month's 80 % and 100 % emails start over for the new
 * cap, and go out at once when the spend is past them already.
 */
async function setSpendingCap(tx: Tx, workspaceId: string, capUsd: number | null, now: string) {
  const [workspace] = await tx
    .update(organization)
    .set({ spendingCapCents: capUsd === null ? null : Math.round(capUsd * 100) })
    .where(eq(organization.id, workspaceId))
    .returning({ id: organization.id })
  if (!workspace) throw new Reject('workspace not found')
  await tx
    .delete(spending_cap_alerts)
    .where(and(eq(spending_cap_alerts.workspace_id, workspaceId), eq(spending_cap_alerts.month, monthOf(now))))
  const cap = await spendingCap(tx, workspaceId, now)
  await queueSpendingAlerts(tx, workspaceId, now, cap)
  return {
    rows: {},
    data: {
      workspaceId,
      spending_cap_usd: cap?.capUsd ?? null,
      spent_usd: cap?.spentUsd ?? null,
      reached: cap?.reached ?? false,
    },
  }
}

/** Handlers that hand out an enrolment code refuse a session that is not passkey-confirmed (admin-step-up.ts). */
function refuseEnrolmentCode(actor: Actor) {
  if (!mayReceiveEnrolmentCode(actor)) throw new Forbidden('confirm with your passkey to do this')
}

/** Who did it, for the alert emails: their address, or the server operator. */
async function actorName(actor: Actor): Promise<string> {
  if (actor.actorId === 'cli') return 'The server operator (command line)'
  const [who] = await db.select({ email: user.email }).from(user).where(eq(user.id, actor.actorId))
  return who?.email ?? 'An instance admin'
}

async function alertAdminGranted(actor: Actor, email: string) {
  await alertInstanceAdmins(
    `New instance admin on ${brandName()}: ${email}`,
    `${await actorName(actor)} made ${email} an instance admin.\n\nIf you did not expect this, sign in with your passkey and check Admin, Users and Audit log.`,
  )
}

/**
 * Sign-in and email settings are read at start (instance-env.ts): a change restarts the API. Every
 * instance admin is told, like about other changes that could hand over accounts (admin-alerts.ts).
 */
async function applyAfterCommit(provider: ProviderName, actor: Actor, cleared = false) {
  const { category, label } = providerSpec(provider)
  if (!restartCategories.includes(category)) return
  checkInstanceEnvSoon(db)
  await alertInstanceAdmins(
    `${label} settings ${cleared ? 'removed' : 'changed'}`,
    `${await actorName(actor)} ${cleared ? 'removed' : 'changed'} the ${label} settings (Admin, Providers). They decide how people sign in or get sign-in codes.\n\nIf you did not expect this, sign in with your passkey and check Admin, Providers and Audit log.`,
  )
}

export const adminHandlers: Record<string, Handler> = {
  'provider.setKeys': async ({ tx, actor, now }, input) => {
    await withSecretsKey(() => setProviderKeys(tx, input.provider, input.values, actor.actorId, now))
    await applyAfterCommit(input.provider, actor)
    return { rows: {}, data: { provider: await statusOf(tx, input.provider) } }
  },

  'provider.clearKeys': async ({ tx, actor }, input) => {
    await clearProviderKeys(tx, input.provider)
    await applyAfterCommit(input.provider, actor, true)
    return { rows: {}, data: { provider: await statusOf(tx, input.provider) } }
  },

  'provider.setActive': async ({ tx, actor, now }, input) => {
    await setActiveProvider(tx, input.category, input.provider, actor.actorId, now)
    // Which mail service sends is read at start, like its keys (instance-env.ts).
    if (restartCategories.includes(input.category)) checkInstanceEnvSoon(db)
    return { rows: {}, data: { active: (await providerStatus(tx)).active } }
  },

  'provider.test': async ({ tx }, input) => {
    const config = await withSecretsKey(() => resolveProvider(tx, input.provider))
    // The same keys tested a moment ago (the overview tests on open, a double click): the last result, no request.
    const recent = recentTest(input.provider, config)
    if (recent) return { rows: {}, data: recent }
    const result = await testProvider(input.provider, config)
    rememberTest(input.provider, config, result)
    // A provider that is set up: its test counts like a call (a pass clears its failure, an error records one,
    // without the email: the admin sees it). One that is not set up is not failing, only missing.
    if (!missingFields(input.provider, config).length) {
      if (result.ok) await noteProviderOk(input.provider)
      else await noteProviderFailure(input.provider, { reason: result.reason ?? 'unknown', message: result.message }, 'test')
    }
    return { rows: {}, data: result }
  },

  'provider.connectOneKey': async ({ tx, actor, now }, input) => {
    const realtime = 'openai_realtime' as const
    // Tested before anything is written: a key that fails changes nothing, and a key stored before stays.
    const current = await withSecretsKey(() => resolveProvider(tx, realtime))
    const candidate = { ...current, api_key: { value: input.apiKey, source: 'app' as const } }
    const result = await testProvider(realtime, candidate)
    if (!result.ok) throw new Reject(`${result.message}. Nothing was changed; check the key and try again`)
    // Speech and model use the realtime key only where their category has no provider yet.
    const { active } = await providerStatus(tx)
    const linked = (
      [
        ['stt', 'openai_stt'],
        ['llm', 'openai'],
      ] as const
    ).flatMap(([category, provider]) => (active[category].provider ? [] : [provider]))
    await withSecretsKey(() => setProviderKeys(tx, realtime, { api_key: input.apiKey }, actor.actorId, now))
    await setActiveProvider(tx, 'realtime', realtime, actor.actorId, now)
    for (const provider of linked) await linkProviderKey(tx, provider, realtime, actor.actorId, now)
    rememberTest(realtime, await resolveProvider(tx, realtime), result)
    return { rows: {}, data: { ok: true, message: result.message, linked } }
  },

  'user.invite': async ({ actor, onRollback }, input) => {
    if (input.admin) refuseEnrolmentCode(actor)
    const delivery = emailDelivery(process.env)
    if (delivery === 'none') {
      throw new Reject(
        'Email is not set up, so the new user cannot get sign-in codes: connect it under Providers, Email (or EMAIL_TO_LOG=true in development).',
      )
    }
    const email = input.email.trim().toLowerCase()
    const [taken] = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${email}`)
    if (taken) throw new Reject(`${email} already has an account`)
    // Committed at once, outside the command's transaction, so the welcome email only goes to an
    // account that exists. If the command does not commit, the account is removed again.
    const account = {
      id: crypto.randomUUID().replaceAll('-', ''),
      name: input.name,
      email,
      emailVerified: false,
      instanceAdmin: input.admin ?? false,
    }
    // A sign-up for the same address can land between the check and the insert.
    const [created] = await db
      .insert(user)
      .values(account)
      .returning({ id: user.id })
      .catch(e => {
        throw (e as { code?: string; cause?: { code?: string } }).code === '23505' ||
          (e as { cause?: { code?: string } }).cause?.code === '23505'
          ? new Reject(`${email} already has an account`)
          : e
      })
    onRollback?.(async () => {
      await db.delete(user).where(eq(user.id, created!.id))
      return `the account for ${email} was removed again`
    })
    try {
      await emailSender.send({ to: email, ...welcomeEmail({ name: emailSafeName(input.name, 'there'), email }) })
    } catch (e) {
      throw new Reject(
        `the account was not created: the welcome email could not be sent (${e instanceof Error ? e.message : e})`,
      )
    }
    // A new instance admin adds their first passkey with a one-time code, given to the admin who invited them
    // (only to a passkey-confirmed session: also checked before the account is made, so no email goes out).
    if (input.admin) refuseEnrolmentCode(actor)
    const enrolment = input.admin ? await issuePasskeyEnrolment(db, created!.id) : {}
    if (input.admin) await alertAdminGranted(actor, email)
    return { rows: {}, data: { userId: created!.id, email, delivery, ...enrolment } }
  },

  'user.disable': async ({ tx, actor, now }, input) => {
    if (input.userId === actor.actorId) throw new Reject('you cannot disable your own account')
    const account = await loadUser(tx, input.userId)
    if (isInstanceAdmin(account) && !(await anotherAdminRemains(tx, account.id)))
      throw new Reject('the last instance admin cannot be disabled')
    await tx
      .update(user)
      .set({ disabledAt: new Date(now) })
      .where(eq(user.id, account.id))
    // Their sessions end, and so do the impersonations they started (Better Auth's own endpoints do not check those).
    await tx.delete(session).where(or(eq(session.userId, account.id), eq(session.impersonatedBy, account.id)))
    await dropUserPush(tx, account.id)
    return { rows: {}, data: { userId: account.id, disabled_at: now } }
  },

  'user.enable': async ({ tx }, input) => {
    const account = await loadUser(tx, input.userId)
    await tx.update(user).set({ disabledAt: null }).where(eq(user.id, account.id))
    return { rows: {}, data: { userId: account.id, disabled_at: null } }
  },

  'workspace.disable': ({ tx, now }, input) => setWorkspaceDisabled(tx, input.workspaceId, new Date(now)),
  'workspace.enable': ({ tx }, input) => setWorkspaceDisabled(tx, input.workspaceId, null),
  'workspace.delete': async ({ tx, now, actor, telephony }, input) => ({
    rows: {},
    data: await deleteWorkspace(tx, input, now, actor.actorId, telephony),
  }),
  'workspace.setSpendingCap': ({ tx, now }, input) => setSpendingCap(tx, input.workspaceId, input.capUsd, now),

  'instanceAdmin.grant': async ({ tx, actor }, input) => {
    refuseEnrolmentCode(actor)
    const account = await loadUser(tx, input.userId)
    await tx.update(user).set({ instanceAdmin: true }).where(eq(user.id, account.id))
    // Their first passkey needs this one-time code, shown once to the granting admin (passkey-enrolment.ts).
    const enrolment = (await hasPasskey(tx, account.id)) ? {} : await issuePasskeyEnrolment(tx, account.id)
    await alertAdminGranted(actor, account.email)
    return { rows: {}, data: { userId: account.id, instance_admin: true, ...enrolment } }
  },

  // The recovery path that needs none of the user's passkeys (passkeys.ts). Runs only with the
  // admin's own passkey sign-in (admin-step-up.ts) or from the CLI, never while impersonating, and
  // never on the admin's own account: that would turn a stolen first factor into a passkey.
  'user.resetPasskeys': async ({ tx, actor }, input) => {
    if (input.userId === actor.actorId)
      throw new Forbidden(
        'you cannot reset your own passkeys; ask another instance admin, or run user:passkeys --remove on the server',
      )
    refuseEnrolmentCode(actor)
    const account = await loadUser(tx, input.userId)
    const isAdmin = isInstanceAdmin(account)
    // Their sessions end too.
    const removed = await removeAllPasskeys(tx, { id: account.id, email: account.email, isAdmin })
    const enrolment = isAdmin ? await issuePasskeyEnrolment(tx, account.id) : {}
    await alertInstanceAdmins(
      `Passkeys reset on ${brandName()}: ${account.email}`,
      `${await actorName(actor)} removed every passkey of ${account.email} (${removed} removed) and ended their sessions.${isAdmin ? ' They are an instance admin and got a new enrolment code for their first passkey.' : ''}\n\nIf you did not expect this, sign in with your passkey and check Admin, Audit log.`,
    )
    return { rows: {}, data: { userId: account.id, removed, ...enrolment } }
  },

  'instanceAdmin.revoke': async ({ tx }, input) => {
    const account = await loadUser(tx, input.userId)
    if (isEnvAdmin(account))
      throw new Reject(`${account.email} is an instance admin through INSTANCE_ADMIN_EMAILS; remove the address there`)
    if (!(await anotherAdminRemains(tx, account.id))) throw new Reject('the last instance admin cannot be revoked')
    await tx.update(user).set({ instanceAdmin: false }).where(eq(user.id, account.id))
    // The impersonations they started end now, not when their hour is up.
    await tx.delete(session).where(eq(session.impersonatedBy, account.id))
    return { rows: {}, data: { userId: account.id, instance_admin: false } }
  },
}
