// Server handlers of the admin area actions (packages/actions/src/admin.ts).
import {
  type MembershipRole,
  type ProviderCategory,
  type ProviderName,
  providerSpec,
  signInCategories,
  type UserInviteData,
} from '@linedesk/actions'
import { agent_setup_keys, organization, session, spending_cap_alerts, type Tx, user } from '@linedesk/db'
import { emailDelivery } from './auth-methods.ts'
import { createEmailSender, type EmailSender, emailSender, emailSettingsOf, sendNotice } from './email.ts'
import { emailSafeName, passkeyEnrolmentIssuedEmail, welcomeEmail } from './emails/templates.ts'
import { db } from './db.ts'
import { and, eq, or, sql } from 'drizzle-orm'
import { Forbidden, type Handler, type HandlerCtx, Reject } from './handler-context.ts'
import { alertInstanceAdmins } from './admin-alerts.ts'
import { mayReceiveEnrolmentCode } from './admin-step-up.ts'
import type { Actor } from './context.ts'
import { checkInstanceEnvSoon, followEmailSettings } from './instance-env.ts'
import { forgetEmailCodes } from './install-setup.ts'
import { dropPendingEmailCodes } from './verifications.ts'
import { anotherAdminRemains, isEnvAdmin, isInstanceAdmin } from './instance-admin.ts'
import {
  issueFirstPasskeyEnrolment,
  issuePasskeyEnrolment,
  removeAllPasskeys,
  revokeSetupKeysOf,
} from './passkey-enrolment.ts'
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
import { endpointRuleFor, s3EndpointProblem } from './s3-endpoint.ts'
import { dropUserPush } from './push.ts'
import { SecretsKeyError } from './secrets.ts'
import { monthOf, queueSpendingAlerts, spendingCap } from './spending-cap.ts'
import { brandName } from './branding.ts'
import { deleteWorkspace } from './workspace-delete.ts'
import type { AuditSubject } from './audit.ts'
import { addToWorkspace, inviteToWorkspace, noticeAddedByAdmin, openWorkspace } from './memberships.ts'

/** A missing or wrong SECRETS_KEY is the operator's to fix: show the reason instead of a server error. */
/** OpenAI's language model and transcription can use the OpenAI key stored for the realtime model. */
const OPENAI_KEY_USERS: readonly ProviderName[] = ['openai', 'openai_stt']

/**
 * Picking OpenAI's language model or transcription without a key of its own: it uses the OpenAI key already stored
 * for the realtime model (a reference, as provider.connectOneKey links them), so the pick works at once.
 */
async function shareOpenAiKey(tx: Tx, provider: ProviderName, actorId: string, now: string) {
  if (!OPENAI_KEY_USERS.includes(provider)) return
  if ((await withSecretsKey(() => resolveProvider(tx, provider))).api_key) return
  if ((await withSecretsKey(() => resolveProvider(tx, 'openai_realtime'))).api_key?.source !== 'app') return
  await linkProviderKey(tx, provider, 'openai_realtime', actorId, now)
}

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

/** How emails go out; refused when they cannot, since the person could never get a sign-in code. */
function deliveryOrRefuse(): 'smtp' | 'log' {
  const delivery = emailDelivery(process.env)
  if (delivery === 'none')
    throw new Reject(
      'Email is not set up, so the new user cannot get sign-in codes: connect it under Providers, Email (or EMAIL_TO_LOG=true in development).',
    )
  return delivery
}

/** user.invite's result; `subject` files the entry under the workspace in the audit log. */
function joined(
  userId: string,
  email: string,
  existing: boolean,
  workspace: { id: string; name: string } | null,
  role: MembershipRole,
  how: 'added' | 'invited',
  delivery?: 'smtp' | 'log',
): { rows: Record<string, never>; data: UserInviteData & { subject: AuditSubject } } {
  return {
    rows: {},
    data: {
      userId,
      email,
      existing,
      ...(delivery ? { delivery } : {}),
      workspace: workspace ? { id: workspace.id, name: workspace.name, role, joined: how } : null,
      // Without a workspace the entry belongs to none, not to the admin's own (audit.ts).
      subject: { email, workspaceId: workspace?.id ?? null },
    },
  }
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
  // Only a person signed in as themselves (or the CLI): never an AI agent's setup key, an API key or an impersonation.
  if (actor.setupKeyId || actor.apiKeyId || actor.impersonation)
    throw new Forbidden('only an instance admin signed in as themselves, or the server operator, can do this')
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
 * The senders an alert about an email change goes through: the one in effect before it, so a mail server of an
 * attacker's own cannot swallow the alert about itself; the new one too when it differs (the first setup has no
 * previous one).
 */
function alertSenders(before: EmailSender, beforeSettings: string): EmailSender[] {
  const after = createEmailSender({ ...process.env })
  if (before.kind === 'none') return [after]
  if (emailSettingsOf(process.env) === beforeSettings || after.kind === 'none') return [before]
  return [before, after]
}

/** What changed, for the alert: its subject ("Resend settings changed") and what the actor did ("changed the …"). */
type Change = { subject: string; did: string; actor: Actor }
const keysChange = (provider: ProviderName, what: 'changed' | 'removed', actor: Actor): Change => {
  const { label } = providerSpec(provider)
  return { subject: `${label} settings ${what}`, did: `${what} the ${label} settings`, actor }
}

/** Every instance admin hears about a change of email or sign-in (admin-alerts.ts), through `senders`. */
async function alertChange({ subject, did, actor }: Change, senders: EmailSender[] = [emailSender]) {
  const how = await viaWhat(actor)
  const text = `${await actorName(actor)} ${did} ${how.body}. They decide how people sign in or get sign-in codes.\n\nIf you did not expect this, sign in with your passkey and check Admin, Providers and Audit log.${how.after}`
  for (const sender of senders) await alertInstanceAdmins(`${subject}${how.subject}`, text, sender)
}

/**
 * After a change of email or sign-in, once it committed. Sign-in settings are read at start (instance-env.ts): the
 * API restarts. Email applies at once: the stored settings go into this process before the answer, so the next email
 * (a test, a sign-in code) uses them; codes sent through the previous settings stop working; the alert goes through
 * the previous sender (alertSenders). Other processes follow within 15 s.
 */
function afterSignInChange(onCommit: HandlerCtx['onCommit'], category: ProviderCategory, change: Change) {
  if (!signInCategories.includes(category)) return
  const apply = async () => {
    if (category !== 'email') {
      checkInstanceEnvSoon(db)
      return alertChange(change)
    }
    const beforeSettings = emailSettingsOf(process.env)
    const before = createEmailSender({ ...process.env })
    if (await followEmailSettings(db)) {
      await dropPendingEmailCodes(db)
      forgetEmailCodes()
    }
    await alertChange(change, alertSenders(before, beforeSettings))
  }
  // Without the action runner (handler tests): at once.
  if (onCommit) onCommit(apply)
  else void apply().catch(e => console.error('email or sign-in change:', e))
}

/** Where a change came from, for the alert: the app, or an AI agent with a setup link (named by its prefix and time). */
async function viaWhat(actor: Actor): Promise<{ subject: string; body: string; after: string }> {
  if (!actor.setupKeyId) return { subject: '', body: '(Admin, Providers)', after: '' }
  const [key] = await db
    .select({ prefix: agent_setup_keys.prefix, createdAt: agent_setup_keys.created_at })
    .from(agent_setup_keys)
    .where(eq(agent_setup_keys.id, actor.setupKeyId))
  const made = key ? `, made ${new Date(key.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''
  return {
    subject: ' by an AI agent',
    body: `through the AI agent setup link ${key?.prefix ?? actor.setupKeyId}…${made}`,
    after: ` That admin ends the link with End access on the setup page; disabling the admin ends it too.`,
  }
}

export const adminHandlers: Record<string, Handler> = {
  'provider.setKeys': async ({ tx, actor, now, onCommit }, input) => {
    // Recording storage is never on a link-local or metadata address (s3-endpoint.ts); a setup key without the
    // admin's Allow got the step-up for a private one already (admin-step-up.ts).
    if (input.provider === 's3' && input.values.endpoint) {
      const refused = await s3EndpointProblem(input.values.endpoint, endpointRuleFor(actor))
      if (refused) throw new Reject(refused.message)
    }
    await withSecretsKey(() => setProviderKeys(tx, input.provider, input.values, actor.actorId, now))
    afterSignInChange(onCommit, providerSpec(input.provider).category, keysChange(input.provider, 'changed', actor))
    return { rows: {}, data: { provider: await statusOf(tx, input.provider) } }
  },

  'provider.clearKeys': async ({ tx, actor, onCommit }, input) => {
    await clearProviderKeys(tx, input.provider)
    afterSignInChange(onCommit, providerSpec(input.provider).category, keysChange(input.provider, 'removed', actor))
    return { rows: {}, data: { provider: await statusOf(tx, input.provider) } }
  },

  'provider.setActive': async ({ tx, actor, now, onCommit }, input) => {
    if (input.provider) await shareOpenAiKey(tx, input.provider, actor.actorId, now)
    await setActiveProvider(tx, input.category, input.provider, actor.actorId, now)
    // Which mail service sends applies at once, like its keys, and the admins are told (afterSignInChange).
    if (input.category === 'email') {
      const label = input.provider ? providerSpec(input.provider).label : null
      afterSignInChange(onCommit, 'email', {
        subject: label ? `Email now sent with ${label}` : 'Email provider pick cleared',
        did: label ? `switched email to ${label}` : 'cleared which email provider sends',
        actor,
      })
    }
    return { rows: {}, data: { active: (await providerStatus(tx)).active } }
  },

  'provider.test': async ({ tx, actor }, input) => {
    const config = await withSecretsKey(() => resolveProvider(tx, input.provider))
    const endpointRule = endpointRuleFor(actor)
    // A setup key without the admin's Allow never reaches storage on this server or its network, also when the admin
    // set it up there: refused before any request, and not counted as the provider failing.
    if (input.provider === 's3' && endpointRule === 'public' && config.endpoint?.value) {
      const refused = await s3EndpointProblem(config.endpoint.value, endpointRule)
      if (refused && refused.kind !== 'link_local') throw new Reject(refused.message)
    }
    // The same keys tested a moment ago (the overview tests on open, a double click): the last result, no request.
    const recent = await recentTest(tx, input.provider, config)
    if (recent) return { rows: {}, data: recent }
    const result = await testProvider(input.provider, config, fetch, process.env, {
      free: input.free ?? false,
      endpointRule,
    })
    await rememberTest(tx, input.provider, config, result)
    // A provider that is set up: its test counts like a call (a pass clears its failure, an error records one,
    // without the email: the admin sees it). One that is not set up is not failing, only missing.
    if (!missingFields(input.provider, config).length) {
      if (result.ok) await noteProviderOk(input.provider)
      else
        await noteProviderFailure(
          input.provider,
          { reason: result.reason ?? 'unknown', message: result.message },
          'test',
        )
    }
    return { rows: {}, data: result }
  },

  'provider.connectOneKey': async ({ tx, actor, now }, input) => {
    const realtime = 'openai_realtime' as const
    // Tested before anything is written: a key that fails changes nothing, and a key stored before stays.
    const current = await withSecretsKey(() => resolveProvider(tx, realtime))
    const candidate = { ...current, api_key: { value: input.apiKey, source: 'app' as const } }
    const result = await testProvider(realtime, candidate)
    if (!result.ok)
      throw new Reject(`${result.message.replace(/\.$/, '')}. Nothing was changed; check the key and try again`)
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
    await rememberTest(tx, realtime, await resolveProvider(tx, realtime), result)
    return { rows: {}, data: { ok: true, message: result.message, linked } }
  },

  // Server admin › Users › Add user (docs/architecture.md, "Closed sign-up"). Everything in the command's transaction: an
  // email that cannot be sent leaves nothing behind.
  'user.invite': async ({ tx, actor, now }, input) => {
    if (input.admin) refuseEnrolmentCode(actor)
    const email = input.email.trim().toLowerCase()
    const workspace = input.workspaceId ? await openWorkspace(tx, input.workspaceId) : null
    // Only a server admin may be without a workspace. The server operator's user:create makes a bare account for
    // workspace-create.ts --owner, as before.
    if (!workspace && !input.admin && actor.actorId !== 'cli')
      throw new Reject('choose a workspace: only an instance admin can be added without one')
    if (!workspace && input.role) throw new Reject('a role needs a workspace')
    const role: MembershipRole = input.role ?? 'member'
    // An invitation names the person who sent it; the command line is nobody (also checked in inviteToWorkspace).
    if (workspace && actor.actorId === 'cli')
      throw new Reject('the command line cannot add to a workspace: use Server admin › Users › Add user')

    const [existing] = await tx.select().from(user).where(sql`lower(${user.email}) = ${email}`).for('update')
    if (existing) {
      if (input.admin) throw new Reject(`${email} already has an account: make them an instance admin on their page`)
      if (!workspace) throw new Reject(`${email} already has an account`)
      if (existing.disabledAt) throw new Reject(`${email} is disabled: enable the account first`)
      // A confirmed address joins at once, like Add to workspace. An unconfirmed one gets the invitation, so the
      // workspace opens only once the address is proven (as for every invitation).
      if (existing.emailVerified) {
        await addToWorkspace(tx, existing, workspace, role, now)
        await noticeAddedByAdmin(tx, actor, existing, workspace, role, 'added')
        return joined(existing.id, email, true, workspace, role, 'added')
      }
      const delivery = deliveryOrRefuse()
      await inviteToWorkspace(tx, actor, email, workspace, role, now)
      await noticeAddedByAdmin(tx, actor, existing, workspace, role, 'invited')
      return joined(existing.id, email, true, workspace, role, 'invited', delivery)
    }

    const delivery = deliveryOrRefuse()
    const id = crypto.randomUUID().replaceAll('-', '')
    // A sign-up for the same address can land between the check and the insert.
    await tx
      .insert(user)
      .values({ id, name: input.name, email, emailVerified: false, instanceAdmin: input.admin ?? false })
      .catch(e => {
        throw (e as { code?: string; cause?: { code?: string } }).code === '23505' ||
          (e as { cause?: { code?: string } }).cause?.code === '23505'
          ? new Reject(`${email} already has an account`)
          : e
      })
    // One email: the invitation into the workspace, or without one how to sign in.
    if (workspace) {
      await inviteToWorkspace(tx, actor, email, workspace, role, now)
      await noticeAddedByAdmin(tx, actor, { email, name: input.name }, workspace, role, 'invited')
    } else {
      try {
        await emailSender.send({ to: email, ...welcomeEmail({ name: emailSafeName(input.name, 'there'), email }) })
      } catch (e) {
        throw new Reject(
          `the account was not created: the welcome email could not be sent (${e instanceof Error ? e.message : e})`,
        )
      }
    }
    // A new instance admin adds their first passkey with a one-time code, given to the admin who invited them
    // (only to a passkey-confirmed session: also checked before the account is made, so no email goes out).
    if (input.admin) refuseEnrolmentCode(actor)
    const enrolment = input.admin ? await issuePasskeyEnrolment(tx, id) : {}
    if (input.admin) await alertAdminGranted(actor, email)
    const result = joined(id, email, false, workspace, role, 'invited', delivery)
    return { ...result, data: { ...result.data, ...enrolment } }
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
    await revokeSetupKeysOf(tx, account.id, 'account_disabled')
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
    // Only while they have no passkey, in one conditional write (passkey-enrolment.ts issueFirstPasskeyEnrolment).
    const enrolment = (await issueFirstPasskeyEnrolment(tx, account.id)) ?? {}
    await alertAdminGranted(actor, account.email)
    return { rows: {}, data: { userId: account.id, instance_admin: true, ...enrolment } }
  },

  // The recovery path that needs none of the user's passkeys (passkeys.ts). Runs only with the
  // admin's own passkey sign-in (admin-step-up.ts) or from the CLI, never while impersonating, and
  // never on the admin's own account: that would turn a stolen first factor into a passkey.
  // Ends all their sessions and AI agent setup links, also when there was no passkey to remove; an instance admin who
  // only needs a code for their first passkey gets it from user.issuePasskeyEnrolment, which ends nothing.
  'user.resetPasskeys': async ({ tx, actor }, input) => {
    if (input.userId === actor.actorId)
      throw new Forbidden(
        'you cannot reset your own passkeys; ask another instance admin, or run user:passkeys --remove on the server',
      )
    refuseEnrolmentCode(actor)
    const account = await loadUser(tx, input.userId)
    const isAdmin = isInstanceAdmin(account)
    const ended = await removeAllPasskeys(tx, { id: account.id, email: account.email, isAdmin })
    const enrolment = isAdmin ? await issuePasskeyEnrolment(tx, account.id) : {}
    await alertInstanceAdmins(
      `Passkeys reset on ${brandName()}: ${account.email}`,
      `${await actorName(actor)} removed every passkey of ${account.email} (${ended.removed} removed) and ended their sessions and AI agent setup links.${isAdmin ? ' They are an instance admin and got a new enrolment code for their first passkey.' : ''}\n\nIf you did not expect this, sign in with your passkey and check Admin, Audit log.`,
    )
    return { rows: {}, data: { userId: account.id, ...ended, ...enrolment } }
  },

  // Only the code for an instance admin's first passkey (passkey-enrolment.ts), for one who has none: nothing to
  // recover, so nothing ends (their sessions and AI agent setup links keep working). The same guards as the reset,
  // which hands out the same code: passkey step-up (admin-step-up.ts) or the CLI, never the caller's own account.
  'user.issuePasskeyEnrolment': async ({ tx, actor }, input) => {
    if (input.userId === actor.actorId)
      throw new Forbidden(
        'you cannot give yourself an enrolment code; ask another instance admin, or run user:passkeys --enrol on the server',
      )
    refuseEnrolmentCode(actor)
    const account = await loadUser(tx, input.userId)
    if (!isInstanceAdmin(account))
      throw new Reject(`${account.email} is not an instance admin: they add a passkey without a code`)
    if (account.disabledAt) throw new Reject(`${account.email} is disabled: enable the account first`)
    // Conditional on having no passkey in the same write, so a passkey added meanwhile refuses it too.
    const enrolment = await issueFirstPasskeyEnrolment(tx, account.id)
    if (!enrolment)
      throw new Reject(
        `${account.email} has a passkey already. To start over, reset their passkeys: that also signs them out everywhere and ends their AI agent setup links`,
      )
    sendNotice({ to: account.email, ...passkeyEnrolmentIssuedEmail(await actorName(actor)) }, 'passkey enrolment email')
    await alertInstanceAdmins(
      `Passkey enrolment code issued on ${brandName()}: ${account.email}`,
      `${await actorName(actor)} issued a one-time code for the first passkey of ${account.email}, an instance admin without a passkey. Nothing was removed and their sessions and AI agent setup links keep working.\n\nIf you did not expect this, sign in with your passkey and check Admin, Audit log.`,
    )
    return { rows: {}, data: { userId: account.id, ...enrolment } }
  },

  'instanceAdmin.revoke': async ({ tx }, input) => {
    const account = await loadUser(tx, input.userId)
    if (isEnvAdmin(account))
      throw new Reject(`${account.email} is an instance admin through INSTANCE_ADMIN_EMAILS; remove the address there`)
    if (!(await anotherAdminRemains(tx, account.id))) throw new Reject('the last instance admin cannot be revoked')
    await tx.update(user).set({ instanceAdmin: false }).where(eq(user.id, account.id))
    // The impersonations they started end now, not when their hour is up.
    await tx.delete(session).where(eq(session.impersonatedBy, account.id))
    // So do their AI agent setup links: they stop working now, and must not come back with a later grant.
    await revokeSetupKeysOf(tx, account.id, 'admin_role_removed')
    return { rows: {}, data: { userId: account.id, instance_admin: false } }
  },
}
