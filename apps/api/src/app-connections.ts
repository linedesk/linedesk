// Connected apps of a workspace (docs/crm-sync.md): connecting by OAuth (a state bound to the member and workspace,
// used once), tokens encrypted with SECRETS_KEY and refreshed when they run out (HubSpot's last 30 minutes, Jobber's
// 60 with a new refresh token on every refresh; Slack's bot token does not run out, and its incoming webhook URL is
// stored encrypted beside it), and
// disconnecting with revocation. Sending finished calls to them is app-pushes.ts. Each app's HTTP is in
// @linedesk/connectors; its OAuth app (client ID and secret) is the install's, under Server admin › Providers.
import { randomBytes } from 'node:crypto'
import {
  APP_SETTINGS,
  appSettingOn,
  SHOP_VERIFY_SETTINGS,
  type AppConnectError,
  type AppConnectStartData,
  type AppDisconnectData,
  type AppSettingId,
  type ConnectableApp,
} from '@linedesk/actions'
import {
  APP_IDS,
  APP_LABEL,
  type AppAccess,
  type AppConnector,
  AppError,
  type AppId,
  type AppOAuth,
  appConnector,
  appOAuth,
  GrantRevoked,
  type OAuthTokens,
  type ShopifyStore,
  shopDomain,
  type TokenSource,
} from '@linedesk/connectors'
import {
  type AppConnection,
  app_connections,
  app_credentials,
  app_oauth_states,
  crm_links,
  provider_settings,
  type Tx,
} from '@linedesk/db'
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { type Handler, type HandlerCtx, Forbidden, Reject } from './handler-context.ts'
import { noteProviderFailure, noteProviderOk } from './provider-failures.ts'
import { resolveProvider } from './provider-settings.ts'
import { decryptSecret, encryptSecret, hasSecretsKey, SecretsKeyError } from './secrets.ts'

// The action's list of apps and the connectors' are the same.
const sameApps: readonly ConnectableApp[] = APP_IDS satisfies readonly ConnectableApp[]
void sameApps

/** How the API reaches connected apps; tests pass fakes through the handler context. */
export type AppServices = {
  /** The app's OAuth with the install's client ID and secret; null when an instance admin has not set them. */
  oauth(tx: Tx, app: AppId): Promise<AppOAuth | null>
  connector(app: AppId): AppConnector
  /** Shopify's store reads and changes during calls (shopify-calls.ts); tests pass a fake. */
  shopify?(): ShopifyStore
}

export const defaultAppServices: AppServices = {
  async oauth(tx, app) {
    const config = await resolveProvider(tx, app)
    const clientId = config.client_id?.value
    const clientSecret = config.client_secret?.value
    return clientId && clientSecret ? appOAuth(app, { clientId, clientSecret }) : null
  },
  connector: app => appConnector(app),
}

export const appServicesOf = (ctx: Pick<HandlerCtx, 'apps'>) => ctx.apps ?? defaultAppServices

const NO_SECRETS_KEY =
  'SECRETS_KEY is not set, so app access cannot be stored. Generate one with `openssl rand -base64 32`, set it in the environment of the API and restart.'

/** A rejection the page words by its code (AppConnectError); the message is for the API and the command log. */
const rejectApp = (code: AppConnectError, message: string) => new Reject(message, code)
const IMPERSONATING = 'Not possible while signed in as another user.'

/**
 * Serialises everything that changes a connection's grant or uses it: a push's claim and bookkeeping, a token
 * refresh being saved, connecting again, disconnecting. Until the transaction ends.
 */
export const lockConnection = (tx: Tx, connectionId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app:${connectionId}`}))`)

/** Connect and disconnect of one account of an app, one at a time: the "shared" check below sees the other's row. */
const lockAccount = (tx: Tx, app: AppId, accountId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app-account:${app}:${accountId}`}))`)

/** A started connect is good for this long: enough to sign in and consent. */
const STATE_TTL_MS = 10 * 60_000
/** An access token is refreshed when it has less than this left, so no request starts with a dying one. */
const REFRESH_MARGIN_MS = 60_000
/** Scopes every app must have granted (HUBSPOT_SCOPES without `oauth`, which HubSpot does not always report). */
const REQUIRED_SCOPES: Record<AppId, readonly string[]> = {
  hubspot: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
  slack: ['incoming-webhook'],
  // Jobber sets scopes on the app (Developer Center); checked only when its token answer names them.
  jobber: ['read_clients', 'write_clients'],
  // Shopify names only the write scope when both were granted (write includes read).
  shopify: ['write_customers', 'write_orders', 'read_products'],
}
/** An access token that does not run out (Slack without token rotation) is stored with this expiry. */
const NEVER = '9999-12-31T00:00:00.000Z'

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Where the app sends the browser back: the public address of this install, which serves /v1 too. */
export function appRedirectUri(
  app: AppId,
  base = process.env.BETTER_AUTH_URL ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173',
) {
  return new URL(`/v1/apps/callback/${app}`, base).toString()
}

/** The slot (secrets.ts) of a connection's token: the ciphertext is bound to its connection, app and kind. */
export const appSlot = (connection: Pick<AppConnection, 'id' | 'provider'>, kind: 'access' | 'refresh' | 'webhook') =>
  `app.${connection.id}.${connection.provider}.${kind}`

function workspaceOf(actor: Actor) {
  if (!actor.workspaceId) throw new Reject('no workspace')
  return actor.workspaceId
}

async function oauthOrReject(tx: Tx, ctx: Pick<HandlerCtx, 'apps'>, app: AppId) {
  const oauth = await appServicesOf(ctx).oauth(tx, app)
  if (!oauth)
    throw rejectApp(
      'not_set_up',
      `${APP_LABEL[app]} is not available on this server: an instance admin sets up its app under Server admin › Providers.`,
    )
  return oauth
}

function rejectAppError(e: unknown): never {
  if (e instanceof AppError || e instanceof SecretsKeyError) {
    console.warn(`app connect: ${e.message}`)
    // The install's own app was refused (a wrong client secret, which Slack checks only here): Server admin's to fix,
    // so it shows there as this provider failing; the member reads that the app is not set up.
    if (e instanceof AppError && e.kind === 'client') {
      void noteProviderFailure(
        e.app,
        {
          reason: 'auth',
          message: `${APP_LABEL[e.app]} refused the client ID or secret when a business connected. Enter them again under Server admin › Providers › ${APP_LABEL[e.app]}.`,
        },
        'app',
      )
      throw rejectApp('not_set_up', e.message)
    }
    throw rejectApp('failed', e.message)
  }
  throw e
}

function tokenValues(connection: Pick<AppConnection, 'id' | 'provider'>, tokens: OAuthTokens, refreshToken: string) {
  return {
    access_token_encrypted: encryptSecret(tokens.accessToken, appSlot(connection, 'access')),
    refresh_token_encrypted: encryptSecret(refreshToken, appSlot(connection, 'refresh')),
    // An app that names no expiry: refreshed after HubSpot's 30 minutes anyway; one that gives no refresh token
    // (Slack) has a token that does not run out.
    expires_at: tokens.expiresAt ?? (tokens.refreshToken ? new Date(Date.now() + 30 * 60_000).toISOString() : NEVER),
    scope: tokens.scope,
    updated_at: new Date().toISOString(),
  }
}

async function saveTokens(
  tx: Tx,
  connection: Pick<AppConnection, 'id' | 'workspace_id' | 'provider'>,
  tokens: OAuthTokens,
  refreshToken: string,
) {
  const values = {
    ...tokenValues(connection, tokens, refreshToken),
    webhook_url_encrypted: tokens.webhook ? encryptSecret(tokens.webhook.url, appSlot(connection, 'webhook')) : null,
  }
  await tx
    .insert(app_credentials)
    .values({ connection_id: connection.id, workspace_id: connection.workspace_id, ...values })
    .onConflictDoUpdate({ target: app_credentials.connection_id, set: values })
}

/**
 * The token source for a connection: the stored access token while it is good, else a refreshed one, stored again
 * (the newest refresh token is kept). Runs outside any long transaction: the refresh asks the app first, then saves
 * in a short one under the connection's lock, and only if the stored grant is still the one it refreshed (a connect
 * again or a disconnect in between wins; the token then comes from what is stored now). A refused refresh throws
 * AppError `auth`: the caller marks the connection.
 */
export function appTokenSource(database: Tx, services: AppServices, connection: AppConnection): TokenSource {
  const stored = async () =>
    (await database.select().from(app_credentials).where(eq(app_credentials.connection_id, connection.id)))[0]
  const good = (expiresAt: string) => Date.parse(expiresAt) - Date.now() > REFRESH_MARGIN_MS
  return async (forceRefresh = false) => {
    const credentials = await stored()
    if (!credentials) throw new AppError(connection.provider, 'auth', 'no stored access: connect it again')
    if (!forceRefresh && good(credentials.expires_at))
      return decryptSecret(credentials.access_token_encrypted, appSlot(connection, 'access'))
    const oauth = await appServicesOf({ apps: services }).oauth(database, connection.provider)
    if (!oauth) throw new AppError(connection.provider, 'unavailable', 'the app is no longer set up on this server')
    const refreshToken = decryptSecret(credentials.refresh_token_encrypted, appSlot(connection, 'refresh'))
    let tokens: OAuthTokens
    try {
      tokens = await oauth.refresh(refreshToken)
    } catch (e) {
      if (e instanceof GrantRevoked)
        await dropRevokedConnection(database, connection, credentials.refresh_token_encrypted)
      throw e
    }
    const saved = await database.transaction(async tx => {
      await lockConnection(tx, connection.id)
      return tx
        .update(app_credentials)
        .set(tokenValues(connection, tokens, tokens.refreshToken ?? refreshToken))
        .where(
          and(
            eq(app_credentials.connection_id, connection.id),
            eq(app_credentials.refresh_token_encrypted, credentials.refresh_token_encrypted),
          ),
        )
        .returning({ id: app_credentials.connection_id })
    })
    if (saved.length) return tokens.accessToken
    // The grant changed while refreshing: use what is stored now, if it is good.
    const now = await stored()
    if (now && good(now.expires_at)) return decryptSecret(now.access_token_encrypted, appSlot(connection, 'access'))
    throw new AppError(connection.provider, 'auth', 'the access changed while it was refreshed: connect it again')
  }
}

/** How long after a change of an app's client ID or secret a refused grant is not taken as an uninstall. */
export const KEYS_SETTLE_MS = 24 * 60 * 60_000

/** Whether the install's keys of an app (Server admin › Providers) were changed after `since`. */
async function appKeysChangedSince(database: Tx, app: AppId, since: number) {
  const [changed] = await database
    .select({ field: provider_settings.field })
    .from(provider_settings)
    .where(
      and(
        isNull(provider_settings.workspace_id),
        eq(provider_settings.provider, app),
        gt(provider_settings.updated_at, new Date(since).toISOString()),
      ),
    )
    .limit(1)
  return Boolean(changed)
}

/**
 * Whether another connection of the app holds this very grant. An app may hand the same refresh token to the same
 * person connecting the same account again from another workspace (HubSpot ties it to user, portal and app);
 * revoking it would cut that connection too. `accountId` narrows the search when it is known.
 */
async function grantHeldElsewhere(
  tx: Tx,
  app: AppId,
  grant: string,
  exceptId: string | null,
  accountId: string | null = null,
) {
  const rows = await tx
    .select({
      id: app_connections.id,
      provider: app_connections.provider,
      refresh: app_credentials.refresh_token_encrypted,
    })
    .from(app_connections)
    .innerJoin(app_credentials, eq(app_credentials.connection_id, app_connections.id))
    .where(
      and(
        eq(app_connections.provider, app),
        accountId === null ? undefined : eq(app_connections.account_id, accountId),
      ),
    )
  return rows.some(row => row.id !== exceptId && tryDecrypt(row.refresh, appSlot(row, 'refresh')) === grant)
}

/**
 * The app no longer knows the connection's grant (HubSpot: the app was uninstalled in the portal; GrantRevoked): the
 * connection goes, with its tokens, links and pushes (foreign key cascade), as when the business disconnects. Nothing
 * is withdrawn at the app: the grant is gone there already. Only this connection, and only while its stored grant is
 * still the one that was refused: a connect again meanwhile wins. Same locks and order as app.disconnect.
 */
export async function dropRevokedConnection(database: Tx, connection: AppConnection, refusedRefresh: string) {
  // Another app's valid keys entered under Server admin › Providers would have every grant refused like this: right
  // after a key change nothing is removed; the refusal marks the connection as any refused grant does.
  if (await appKeysChangedSince(database, connection.provider, Date.now() - KEYS_SETTLE_MS)) return false
  const deleted = await database.transaction(async tx => {
    await lockAccount(tx, connection.provider, connection.account_id)
    await lockConnection(tx, connection.id)
    return tx
      .delete(app_connections)
      .where(
        and(
          eq(app_connections.id, connection.id),
          sql`exists (select 1 from ${app_credentials} where ${app_credentials.connection_id} = ${app_connections.id} and ${app_credentials.refresh_token_encrypted} = ${refusedRefresh})`,
        ),
      )
      .returning({ id: app_connections.id })
  })
  if (deleted.length)
    console.log(
      `app connections: ${APP_LABEL[connection.provider]} no longer knows a grant, its connection was removed`,
    )
  return deleted.length > 0
}

/**
 * What a connector gets for a connection: its token source and, for Slack, the stored incoming webhook URL (read
 * when the post is made, so a connect again in between is used).
 */
export function appAccess(database: Tx, services: AppServices, connection: AppConnection): AppAccess {
  return Object.assign(appTokenSource(database, services, connection), {
    async webhookUrl() {
      const [stored] = await database
        .select({ webhook: app_credentials.webhook_url_encrypted })
        .from(app_credentials)
        .where(eq(app_credentials.connection_id, connection.id))
      if (!stored?.webhook) throw new AppError(connection.provider, 'auth', 'no stored webhook: connect it again')
      return decryptSecret(stored.webhook, appSlot(connection, 'webhook'))
    },
  })
}

/**
 * Whether another connection (any workspace) uses this account of the app. An app whose grant is one per account
 * (grantPerAccount: Slack) must then not withdraw it: that would cut the other connection too.
 */
async function accountShared(tx: Tx, app: AppId, accountId: string, exceptId: string | null) {
  const rows = await tx
    .select({ id: app_connections.id })
    .from(app_connections)
    .where(and(eq(app_connections.provider, app), eq(app_connections.account_id, accountId)))
  return rows.some(r => r.id !== exceptId)
}

function tryDecrypt(ciphertext: string, slot: string) {
  try {
    return decryptSecret(ciphertext, slot)
  } catch {
    return null
  }
}

function missingScope(app: AppId, scope: string | null) {
  // An app that does not report the scopes is trusted; the first push would fail anyway.
  if (scope === null) return false
  const granted = scope.split(/[\s,]+/)
  return REQUIRED_SCOPES[app].some(required => !granted.includes(required))
}

async function connectionOf(tx: Tx, workspaceId: string, app: AppId) {
  const [connection] = await tx
    .select()
    .from(app_connections)
    .where(and(eq(app_connections.workspace_id, workspaceId), eq(app_connections.provider, app)))
  return connection
}

/**
 * The app removed Linedesk from an account itself (Jobber's APP_DISCONNECT webhook): every connection of any
 * workspace to that account goes, with its tokens, links and pushes (foreign key cascade). Nothing is withdrawn at the
 * app: the grant is gone there already. The same locks as app.disconnect, in the same order (each account, then each
 * connection). `accountIds` are the forms the app may name one account by; none matching is no change (a repeated
 * delivery). With `grantedBefore`, a connection whose grant was stored at or after it stays: it was granted after the
 * event (connected again after a disconnect, or a late or replayed delivery). Returns the ids of the deleted
 * connections.
 */
export async function dropAppAccount(
  tx: Tx,
  app: AppId,
  accountIds: readonly string[],
  grantedBefore: string | null = null,
): Promise<string[]> {
  if (!accountIds.length) return []
  const matching = () =>
    tx
      .select({ id: app_connections.id, account_id: app_connections.account_id })
      .from(app_connections)
      .where(and(eq(app_connections.provider, app), inArray(app_connections.account_id, [...accountIds])))
  const found = await matching()
  if (!found.length) return []
  // Sorted, so two deliveries naming the same account take the locks in the same order.
  for (const account of [...new Set(found.map(row => row.account_id))].sort()) await lockAccount(tx, app, account)
  // Read again under the account locks: a connect or disconnect that held them may have changed the rows.
  const locked = (await matching()).map(row => row.id).sort()
  for (const id of locked) await lockConnection(tx, id)
  if (!locked.length) return []
  // Under the connection locks the rows are read once more by the delete itself: a connection that moved to another
  // account while this waited (a connect again holds only the new account's lock), or got a newer grant, stays.
  const newerGrant = grantedBefore
    ? sql`exists (select 1 from ${app_credentials} where ${app_credentials.connection_id} = ${app_connections.id} and ${app_credentials.updated_at} >= ${grantedBefore})`
    : undefined
  const deleted = await tx
    .delete(app_connections)
    .where(
      and(
        eq(app_connections.provider, app),
        inArray(app_connections.id, locked),
        inArray(app_connections.account_id, [...accountIds]),
        newerGrant ? sql`not ${newerGrant}` : undefined,
      ),
    )
    .returning({ id: app_connections.id })
  return deleted.map(row => row.id)
}

export const appConnectionHandlers: Record<string, Handler> = {
  'app.connectStart': async ({ tx, actor, now, ...ctx }, input: { app: AppId; shop?: string }) => {
    const workspace_id = workspaceOf(actor)
    // An app connected while signed in as someone else would put the admin's account into the user's workspace.
    if (actor.impersonation) throw new Forbidden(IMPERSONATING)
    const oauth = await oauthOrReject(tx, ctx, input.app)
    if (!hasSecretsKey()) throw rejectApp('no_secrets_key', NO_SECRETS_KEY)
    // Shopify's consent page is on the store's own domain: the member names the store, or (none named) Shopify's store
    // picker asks for it. Either way the store connected is the one Shopify's signed callback names.
    const shop = input.app === 'shopify' && input.shop?.trim() ? shopDomain(input.shop) : undefined
    if (shop === null)
      // i18n-ignore: the API error body for logs and API clients; the web app shows the key of the code
      throw rejectApp('shop', 'Enter the store as its myshopify.com address, like brightwater.myshopify.com.')
    const state = randomBytes(32).toString('base64url')
    await tx.delete(app_oauth_states).where(lt(app_oauth_states.expires_at, now))
    await tx.insert(app_oauth_states).values({
      id: state,
      workspace_id,
      user_id: actor.actorId,
      provider: input.app,
      expires_at: new Date(Date.parse(now) + STATE_TTL_MS).toISOString(),
    })
    const data: AppConnectStartData = {
      url: oauth.authorizeUrl({ redirectUri: appRedirectUri(input.app), state, ...(shop ? { shop } : {}) }),
    }
    return { rows: {}, data }
  },

  'app.connectFinish': async (
    { tx, actor, now, onRollback, onCommit, ...ctx },
    input: { app: AppId; state: string; code: string; params?: Record<string, string> },
  ) => {
    const workspace_id = workspaceOf(actor)
    if (actor.impersonation) throw new Forbidden(IMPERSONATING)
    // The state is single use and only good for the member who started the connect, in that workspace.
    const [started] = await tx.delete(app_oauth_states).where(eq(app_oauth_states.id, input.state)).returning()
    if (
      !started ||
      started.user_id !== actor.actorId ||
      started.provider !== input.app ||
      Date.parse(started.expires_at) < Date.parse(now)
    ) {
      const expired = started && started.user_id === actor.actorId && Date.parse(started.expires_at) < Date.parse(now)
      throw rejectApp(
        expired ? 'expired' : 'not_yours',
        'This connect link has expired or is not yours. Start again from Integrations.',
      )
    }
    if (started.workspace_id !== workspace_id)
      throw rejectApp('not_yours', 'You switched workspace while connecting. Start again from Integrations.')
    if (!hasSecretsKey()) throw rejectApp('no_secrets_key', NO_SECRETS_KEY)
    const oauth = await oauthOrReject(tx, ctx, input.app)
    const label = APP_LABEL[input.app]
    const tokens = await oauth
      .exchangeCode({ code: input.code, redirectUri: appRedirectUri(input.app), params: input.params })
      .catch(rejectAppError)
    onCommit?.(async () => void (await noteProviderOk(input.app)))
    // The lasting grant: the refresh token; an app without one (Slack) has an access token that does not run out.
    const grant = tokens.refreshToken ?? (oauth.grantPerAccount ? tokens.accessToken : null)
    // A grant one per account that another connection already uses is that connection's too: never withdrawn here.
    if (oauth.grantPerAccount && tokens.account) await lockAccount(tx, input.app, tokens.account.id)
    const shared =
      oauth.grantPerAccount && tokens.account ? await accountShared(tx, input.app, tokens.account.id, null) : false
    // Whatever goes wrong from here, the grant just made is withdrawn again. A grant one per account whose account
    // is not known yet (the account read failed) stays: withdrawing it could cut another workspace on that account.
    // A grant the same person already gave another workspace (the app handed out the same refresh token) stays too.
    const heldElsewhere = grant && !oauth.grantPerAccount ? await grantHeldElsewhere(tx, input.app, grant, null) : false
    if (grant && !shared && !heldElsewhere && (tokens.account || !oauth.grantPerAccount))
      onRollback?.(async () =>
        (await oauth.revoke(grant).catch(() => false))
          ? 'the new access was revoked'
          : 'the new access could not be revoked',
      )
    if (!grant) throw rejectApp('no_grant', `${label} did not grant lasting access. Start again and allow access.`)
    if (missingScope(input.app, tokens.scope))
      throw rejectApp('scope', `${label} did not grant access to contacts. Start again and allow every permission.`)
    if (REQUIRED_SCOPES[input.app].includes('incoming-webhook') && !tokens.webhook)
      throw rejectApp('scope', `${label} did not give a channel to post to. Start again and pick a channel.`)
    const account = tokens.account ?? (await oauth.account(tokens.accessToken).catch(rejectAppError))
    // An app a disconnect uninstalls from the whole account (HubSpot): not while a disconnect of another workspace
    // decides whether the account is still used. The account first, then the connection, as everywhere.
    if (oauth.uninstall && !oauth.grantPerAccount) await lockAccount(tx, input.app, account.id)

    const existing = await connectionOf(tx, workspace_id, input.app)
    let connection: AppConnection
    if (existing) {
      // Not while a push of the old grant is being bookkept or a refreshed token saved (app-pushes.ts).
      await lockConnection(tx, existing.id)
      const otherAccount = existing.account_id !== account.id
      if (otherAccount) {
        // Another portal: the links point at records there. The old grant is withdrawn once this one is stored.
        await tx.delete(crm_links).where(eq(crm_links.connection_id, existing.id))
        const [old] = await tx
          .select({ refresh: app_credentials.refresh_token_encrypted })
          .from(app_credentials)
          .where(eq(app_credentials.connection_id, existing.id))
        const oldGrant = old ? decryptSecret(old.refresh, appSlot(existing, 'refresh')) : null
        const oldShared = oldGrant
          ? oauth.grantPerAccount
            ? await accountShared(tx, input.app, existing.account_id, existing.id)
            : await grantHeldElsewhere(tx, input.app, oldGrant, existing.id, existing.account_id)
          : false
        if (oldGrant && !oldShared) onCommit?.(async () => void (await oauth.revoke(oldGrant).catch(() => false)))
      }
      ;[connection] = (await tx
        .update(app_connections)
        .set({
          account_id: account.id,
          account_name: account.name,
          channel: tokens.webhook?.channel || null,
          status: 'connected',
          error_code: null,
          failures: 0,
          connected_by: actor.actorId,
        })
        .where(eq(app_connections.id, existing.id))
        .returning()) as [AppConnection]
    } else {
      ;[connection] = (await tx
        .insert(app_connections)
        .values({
          id: newId('appc'),
          workspace_id,
          provider: input.app,
          account_id: account.id,
          account_name: account.name,
          channel: tokens.webhook?.channel || null,
          connected_by: actor.actorId,
        })
        .returning()) as [AppConnection]
    }
    await saveTokens(tx, connection, tokens, grant)
    return { rows: { app_connections: [connection] }, data: { connectionId: connection.id } }
  },

  // The switches of what Linedesk does in the app (APP_SETTINGS). Merged into what is stored, so two members changing
  // different switches at once both keep theirs. Read by the push job at send time (app-pushes.ts).
  'app.updateSettings': async (
    { tx, actor },
    input: { id: string; settings: Partial<Record<AppSettingId, boolean>> },
  ) => {
    const workspace_id = workspaceOf(actor)
    if (actor.impersonation) throw new Forbidden(IMPERSONATING)
    const [existing] = await tx
      .select({ provider: app_connections.provider, settings: app_connections.settings })
      .from(app_connections)
      .where(and(eq(app_connections.id, input.id), eq(app_connections.workspace_id, workspace_id)))
    if (!existing) throw rejectApp('not_connected', 'the app is not connected')
    const allowed: readonly string[] = APP_SETTINGS[existing.provider]
    const unknown = Object.keys(input.settings).filter(id => !allowed.includes(id))
    if (unknown.length) throw new Reject(`${APP_LABEL[existing.provider]} has no setting ${unknown.join(', ')}`)
    // A change to an order always needs at least one check of the caller besides the order number, which only names the
    // order (Integrations › Shopify).
    if (existing.provider === 'shopify') {
      const merged = { ...existing.settings, ...input.settings }
      if (!SHOP_VERIFY_SETTINGS.some(id => id !== 'verify_order_number' && appSettingOn(merged, id, 'shopify')))
        // i18n-ignore: the API error body for logs and API clients; the web app shows the key of the code
        throw rejectApp('verify', 'Keep at least one check the caller must pass before an order is changed.')
    }
    const [connection] = await tx
      .update(app_connections)
      .set({ settings: sql`${app_connections.settings} || ${JSON.stringify(input.settings)}::jsonb` })
      .where(and(eq(app_connections.id, input.id), eq(app_connections.workspace_id, workspace_id)))
      .returning()
    if (!connection) throw rejectApp('not_connected', 'the app is not connected')
    return { rows: { app_connections: [connection] } }
  },

  // Deleted here first; the app is asked once that has committed. An app that cannot be reached does not keep the
  // connection: the tokens are gone either way, and the result says whether the grant was withdrawn.
  'app.disconnect': async ({ tx, actor, onCommit, ...ctx }, input: { app: AppId }) => {
    // It changes the account at the app too (Jobber, Slack: the app is removed there).
    if (actor.impersonation) throw new Forbidden(IMPERSONATING)
    const workspace_id = workspaceOf(actor)
    const existing = await connectionOf(tx, workspace_id, input.app)
    if (!existing) throw rejectApp('not_connected', `${APP_LABEL[input.app]} is not connected`)
    // The account first, then the connection: the order connect takes them in.
    await lockAccount(tx, input.app, existing.account_id)
    // Not while a push is being bookkept or a refreshed token saved: those would then find nothing, as they should.
    await lockConnection(tx, existing.id)
    // Read before the delete: the tokens, links and pushes go with the connection (foreign key cascade).
    const [credentials] = await tx
      .select({ refresh: app_credentials.refresh_token_encrypted })
      .from(app_credentials)
      .where(eq(app_credentials.connection_id, existing.id))
    await tx.delete(app_connections).where(eq(app_connections.id, existing.id))
    const oauth = credentials ? await appServicesOf(ctx).oauth(tx, input.app) : null
    // An account another workspace's connection still uses keeps the app: a grant one per account stays (Slack:
    // uninstalling the app would stop that workspace's posts too), and an app that can be uninstalled from the whole
    // account (HubSpot) only has this connection's own grant revoked.
    const shared =
      oauth?.grantPerAccount || oauth?.uninstall
        ? await accountShared(tx, input.app, existing.account_id, existing.id)
        : false
    // A grant that no longer decrypts (SECRETS_KEY changed) cannot be withdrawn; the connection still goes.
    const decrypted =
      credentials && oauth && !(shared && oauth.grantPerAccount)
        ? tryDecrypt(credentials.refresh, appSlot(existing, 'refresh'))
        : null
    // The very grant another connection on the account holds (the same person connected it from two workspaces):
    // withdrawing it would cut that connection too, so it stays.
    const grant =
      decrypted && shared && !oauth?.grantPerAccount
        ? (await grantHeldElsewhere(tx, input.app, decrypted, existing.id, existing.account_id))
          ? null
          : decrypted
        : decrypted
    // Filled in after the commit, before the answer goes out (run-action.ts); the command log keeps `revoked: false`.
    const data: AppDisconnectData = { revoked: false }
    if (oauth && grant) {
      onCommit?.(async () => {
        const withdraw = oauth.uninstall && !shared ? oauth.uninstall(grant) : oauth.revoke(grant)
        data.revoked = await withdraw.catch(() => false)
      })
    }
    return { rows: {}, deleted: { app_connections: [existing.id] }, data }
  },
}
