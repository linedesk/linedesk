// Server handlers of the admin area actions (packages/actions/src/admin.ts).
import type { ProviderName } from '@callfront/actions'
import { organization, session, type Tx, user } from '@callfront/db'
import { eq } from 'drizzle-orm'
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
