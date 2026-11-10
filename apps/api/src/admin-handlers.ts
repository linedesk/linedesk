// Server handlers of the admin area actions (packages/actions/src/admin.ts).
import type { ProviderName } from '@callfront/actions'
import { organization, session, type Tx, user } from '@callfront/db'
import { emailDelivery } from './auth-methods.ts'
import { WEB_ORIGIN } from './auth.ts'
import { emailSender } from './email.ts'
import { db } from './db.ts'
import { eq, sql } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'
import { anotherAdminRemains, isEnvAdmin, isInstanceAdmin } from './instance-admin.ts'
import {
  clearProviderKeys,
  providerStatus,
  resolveProvider,
  setActiveProvider,
  setProviderKeys,
} from './provider-settings.ts'
import { testProvider } from './provider-test.ts'
import { SecretsKeyError } from './secrets.ts'

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

/** No code in it: codes expire in 10 minutes, an invite may be read later. The sign-in page sends one. */
export const welcomeEmail = (name: string) => ({
  subject: 'Your Linedesk account',
  text: `Hello ${name},\n\nan account on Linedesk was created for you. To sign in, open ${WEB_ORIGIN} and enter this email address: you get a sign-in code by email.`,
})

export const adminHandlers: Record<string, Handler> = {
  'provider.setKeys': async ({ tx, actor, now }, input) => {
    await withSecretsKey(() => setProviderKeys(tx, input.provider, input.values, actor.actorId, now))
    return { rows: {}, data: { provider: await statusOf(tx, input.provider) } }
  },

  'provider.clearKeys': async ({ tx }, input) => {
    await clearProviderKeys(tx, input.provider)
    return { rows: {}, data: { provider: await statusOf(tx, input.provider) } }
  },

  'provider.setActive': async ({ tx, actor, now }, input) => {
    await setActiveProvider(tx, input.category, input.provider, actor.actorId, now)
    return { rows: {}, data: { active: (await providerStatus(tx)).active } }
  },

  'provider.test': async ({ tx }, input) => {
    const config = await withSecretsKey(() => resolveProvider(tx, input.provider))
    return { rows: {}, data: await testProvider(input.provider, config) }
  },

  'user.invite': async ({ onRollback }, input) => {
    const delivery = emailDelivery(process.env)
    if (delivery === 'none') {
      throw new Reject(
        'Email is not set up, so the new user cannot get sign-in codes: set SMTP_URL (or EMAIL_TO_LOG=true in development).',
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
      await emailSender.send({ to: email, ...welcomeEmail(input.name) })
    } catch (e) {
      throw new Reject(
        `the account was not created: the welcome email could not be sent (${e instanceof Error ? e.message : e})`,
      )
    }
    return { rows: {}, data: { userId: created!.id, email, delivery } }
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
    await tx.delete(session).where(eq(session.userId, account.id))
    return { rows: {}, data: { userId: account.id, disabled_at: now } }
  },

  'user.enable': async ({ tx }, input) => {
    const account = await loadUser(tx, input.userId)
    await tx.update(user).set({ disabledAt: null }).where(eq(user.id, account.id))
    return { rows: {}, data: { userId: account.id, disabled_at: null } }
  },

  'workspace.disable': ({ tx, now }, input) => setWorkspaceDisabled(tx, input.workspaceId, new Date(now)),
  'workspace.enable': ({ tx }, input) => setWorkspaceDisabled(tx, input.workspaceId, null),

  'instanceAdmin.grant': async ({ tx }, input) => {
    const account = await loadUser(tx, input.userId)
    await tx.update(user).set({ instanceAdmin: true }).where(eq(user.id, account.id))
    return { rows: {}, data: { userId: account.id, instance_admin: true } }
  },

  'instanceAdmin.revoke': async ({ tx }, input) => {
    const account = await loadUser(tx, input.userId)
    if (isEnvAdmin(account))
      throw new Reject(`${account.email} is an instance admin through INSTANCE_ADMIN_EMAILS; remove the address there`)
    if (!(await anotherAdminRemains(tx, account.id))) throw new Reject('the last instance admin cannot be revoked')
    await tx.update(user).set({ instanceAdmin: false }).where(eq(user.id, account.id))
    return { rows: {}, data: { userId: account.id, instance_admin: false } }
  },
}
