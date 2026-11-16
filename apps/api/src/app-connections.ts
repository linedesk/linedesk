// Connected apps of a workspace (docs/crm-sync.md): connecting by OAuth (a state bound to the member and workspace,
// used once), tokens encrypted with SECRETS_KEY and refreshed when they run out (HubSpot's last 30 minutes), and
// disconnecting with revocation. Sending finished calls to them is app-pushes.ts. Each app's HTTP is in
// @linedesk/connectors; its OAuth app (client ID and secret) is the install's, under Server admin › Providers.
import { randomBytes } from 'node:crypto'
import type { AppConnectError, AppConnectStartData, AppDisconnectData, ConnectableApp } from '@linedesk/actions'
import {
  APP_IDS,
  APP_LABEL,
  type AppConnector,
  AppError,
  type AppId,
  type AppOAuth,
  appConnector,
  appOAuth,
  type OAuthTokens,
  type TokenSource,
} from '@linedesk/connectors'
import {
  type AppConnection,
  app_connections,
  app_credentials,
  app_oauth_states,
  crm_links,
  type Tx,
} from '@linedesk/db'
import { and, eq, lt, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { type Handler, type HandlerCtx, Forbidden, Reject } from './handler-context.ts'
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

/**
 * Serialises everything that changes a connection's grant or uses it: a push's claim and bookkeeping, a token
 * refresh being saved, connecting again, disconnecting. Until the transaction ends.
 */
export const lockConnection = (tx: Tx, connectionId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`app:${connectionId}`}))`)

/** A started connect is good for this long: enough to sign in and consent. */
const STATE_TTL_MS = 10 * 60_000
/** An access token is refreshed when it has less than this left, so no request starts with a dying one. */
const REFRESH_MARGIN_MS = 60_000
/** Scopes every app must have granted (HUBSPOT_SCOPES without `oauth`, which HubSpot does not always report). */
const REQUIRED_SCOPES: Record<AppId, readonly string[]> = {
  hubspot: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
}

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
export const appSlot = (connection: Pick<AppConnection, 'id' | 'provider'>, kind: 'access' | 'refresh') =>
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
    throw rejectApp('failed', e.message)
  }
  throw e
}

function tokenValues(connection: Pick<AppConnection, 'id' | 'provider'>, tokens: OAuthTokens, refreshToken: string) {
  return {
    access_token_encrypted: encryptSecret(tokens.accessToken, appSlot(connection, 'access')),
    refresh_token_encrypted: encryptSecret(refreshToken, appSlot(connection, 'refresh')),
    // An app that names no expiry: refreshed after HubSpot's 30 minutes anyway.
    expires_at: tokens.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
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
  const values = tokenValues(connection, tokens, refreshToken)
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
    const tokens = await oauth.refresh(refreshToken)
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

export const appConnectionHandlers: Record<string, Handler> = {
  'app.connectStart': async ({ tx, actor, now, ...ctx }, input: { app: AppId }) => {
    const workspace_id = workspaceOf(actor)
    // An app connected while signed in as someone else would put the admin's account into the user's workspace.
    if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
    const oauth = await oauthOrReject(tx, ctx, input.app)
    if (!hasSecretsKey()) throw rejectApp('no_secrets_key', NO_SECRETS_KEY)
    const state = randomBytes(32).toString('base64url')
    await tx.delete(app_oauth_states).where(lt(app_oauth_states.expires_at, now))
    await tx.insert(app_oauth_states).values({
      id: state,
      workspace_id,
      user_id: actor.actorId,
      provider: input.app,
      expires_at: new Date(Date.parse(now) + STATE_TTL_MS).toISOString(),
    })
    const data: AppConnectStartData = { url: oauth.authorizeUrl({ redirectUri: appRedirectUri(input.app), state }) }
    return { rows: {}, data }
  },

  'app.connectFinish': async (
    { tx, actor, now, onRollback, onCommit, ...ctx },
    input: { app: AppId; state: string; code: string },
  ) => {
    const workspace_id = workspaceOf(actor)
    if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
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
      .exchangeCode({ code: input.code, redirectUri: appRedirectUri(input.app) })
      .catch(rejectAppError)
    const grant = tokens.refreshToken
    // Whatever goes wrong from here, the grant just made is withdrawn again.
    if (grant)
      onRollback?.(async () =>
        (await oauth.revoke(grant).catch(() => false))
          ? 'the new access was revoked'
          : 'the new access could not be revoked',
      )
    if (!grant) throw rejectApp('no_grant', `${label} did not grant lasting access. Start again and allow access.`)
    if (missingScope(input.app, tokens.scope))
      throw rejectApp('scope', `${label} did not grant access to contacts. Start again and allow every permission.`)
    const account = await oauth.account(tokens.accessToken).catch(rejectAppError)

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
        if (oldGrant) onCommit?.(async () => void (await oauth.revoke(oldGrant).catch(() => false)))
      }
      ;[connection] = (await tx
        .update(app_connections)
        .set({
          account_id: account.id,
          account_name: account.name,
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
          connected_by: actor.actorId,
        })
        .returning()) as [AppConnection]
    }
    await saveTokens(tx, connection, tokens, grant)
    return { rows: { app_connections: [connection] }, data: { connectionId: connection.id } }
  },

  // Deleted here first; the app is asked once that has committed. An app that cannot be reached does not keep the
  // connection: the tokens are gone either way, and the result says whether the grant was withdrawn.
  'app.disconnect': async ({ tx, actor, onCommit, ...ctx }, input: { app: AppId }) => {
    const workspace_id = workspaceOf(actor)
    const existing = await connectionOf(tx, workspace_id, input.app)
    if (!existing) throw rejectApp('not_connected', `${APP_LABEL[input.app]} is not connected`)
    // Not while a push is being bookkept or a refreshed token saved: those would then find nothing, as they should.
    await lockConnection(tx, existing.id)
    // Read before the delete: the tokens, links and pushes go with the connection (foreign key cascade).
    const [credentials] = await tx
      .select({ refresh: app_credentials.refresh_token_encrypted })
      .from(app_credentials)
      .where(eq(app_credentials.connection_id, existing.id))
    await tx.delete(app_connections).where(eq(app_connections.id, existing.id))
    const oauth = credentials ? await appServicesOf(ctx).oauth(tx, input.app) : null
    // A grant that no longer decrypts (SECRETS_KEY changed) cannot be withdrawn; the connection still goes.
    const grant = credentials && oauth ? tryDecrypt(credentials.refresh, appSlot(existing, 'refresh')) : null
    // Filled in after the commit, before the answer goes out (run-action.ts); the command log keeps `revoked: false`.
    const data: AppDisconnectData = { revoked: false }
    if (oauth && grant) {
      onCommit?.(async () => {
        data.revoked = await oauth.revoke(grant).catch(() => false)
      })
    }
    return { rows: {}, deleted: { app_connections: [existing.id] }, data }
  },
}
