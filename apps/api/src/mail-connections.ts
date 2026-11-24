// Support mailboxes of a workspace (LIN-615): connecting Gmail or Microsoft 365 by OAuth with read-only scopes (PKCE
// and a state bound to the member and workspace, used once), tokens encrypted with SECRETS_KEY and refreshed when they
// run out, disconnecting with revocation, and the adapter for a connected mailbox (mailboxFor), which the analysis of
// the business's support mail reads through. Connecting stores no mail.
// Gmail's OAuth app is its own (Server admin › Providers › Gmail mailboxes, provider `google_mail`): gmail.readonly is a
// restricted scope, so it is kept off the sign-in and calendar app. Microsoft uses the sign-in app (Mail.Read).
import { randomBytes } from 'node:crypto'
import type {
  MailConnectError,
  MailConnectFinishData,
  MailConnectStartData,
  MailDisconnectData,
  MailProviderId,
} from '@linedesk/actions'
import { type MailConnection, mail_connections, mail_credentials, mail_oauth_states, type Tx } from '@linedesk/db'
import {
  type AccessTokenSource,
  createGmailOAuth,
  createMailProvider,
  createMicrosoftMailOAuth,
  MAIL_PROVIDER_LABEL,
  MailError,
  type MailOAuth,
  type MailProvider,
  type OAuthTokens,
  pkcePair,
} from '@linedesk/mail'
import { and, eq, lt } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { Forbidden, type Handler, type HandlerCtx, Reject } from './handler-context.ts'
import { noteProviderFailure, noteProviderOk } from './provider-failures.ts'
import { resolveProvider } from './provider-settings.ts'
import { decryptSecret, encryptSecret, hasSecretsKey, SecretsKeyError } from './secrets.ts'

/** How the API reaches mail providers; tests pass fakes through the handler context. */
export type MailServices = {
  /** The provider's OAuth with the install's app; null when it is not set up. */
  oauth(tx: Tx, name: MailProviderId): Promise<MailOAuth | null>
  provider(name: MailProviderId, options: { accessToken: AccessTokenSource; accountEmail: string }): MailProvider
}

export const defaultMailServices: MailServices = {
  async oauth(tx, name) {
    if (name === 'google') {
      const config = await resolveProvider(tx, 'google_mail')
      const clientId = config.client_id?.value
      const clientSecret = config.client_secret?.value
      return clientId && clientSecret ? createGmailOAuth({ clientId, clientSecret }) : null
    }
    // The sign-in app: its keys are in the environment (instance-env.ts loads the stored ones at start).
    const env = process.env
    if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) return null
    return createMicrosoftMailOAuth({
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      tenantId: env.MICROSOFT_TENANT_ID || 'common',
    })
  },
  provider: (name, options) => createMailProvider(name, options),
}

const servicesOf = (ctx: Pick<HandlerCtx, 'mail'>) => ctx.mail ?? defaultMailServices

/** The install's app a provider's failures are recorded on (Server admin › Providers). */
const APP_PROVIDER = { google: 'google_mail', microsoft: 'microsoft' } as const

/** A started connect is good for this long: enough to pick an account and consent. */
const STATE_TTL_MS = 10 * 60_000
/** An access token is refreshed when it has less than this left, so no request starts with a dying one. */
const REFRESH_MARGIN_MS = 60_000

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Where the provider sends the browser back: the public address of this install, which serves /v1 too. */
export function mailRedirectUri(
  provider: MailProviderId,
  base = process.env.BETTER_AUTH_URL ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173',
) {
  return new URL(`/v1/mail/callback/${provider}`, base).toString()
}

/** The slot (secrets.ts) of a mailbox's token: bound to its connection and kind, so a value moved to another row does not decrypt. */
export const mailSlot = (connectionId: string, kind: 'access' | 'refresh') => `mail.${connectionId}.${kind}`

function workspaceOf(actor: Actor) {
  if (!actor.workspaceId) throw Reject.t('server.api.noWorkspace')
  return actor.workspaceId
}

async function oauthOrReject(tx: Tx, ctx: Pick<HandlerCtx, 'mail'>, provider: MailProviderId) {
  const oauth = await servicesOf(ctx).oauth(tx, provider)
  if (!oauth) throw Reject.t('server.api.mail.notSetUp', { provider: MAIL_PROVIDER_LABEL[provider] }, 'not_set_up')
  return oauth
}

/** Codes that mean the install's app is refused (its client secret, the Gmail API off), not one account. */
const APP_FAILURES = new Set(['invalid_client', 'unauthorized_client', 'api_disabled'])
const isAppFailure = (e: MailError) => Boolean(e.code && APP_FAILURES.has(e.code))

/** A failure that is the install's to fix is recorded on its app (Server admin › Providers); one account's is not. */
function noteMailAppFailure(e: unknown) {
  if (!(e instanceof MailError) || !isAppFailure(e)) return
  // The adapter's message names the step and the provider's reason (the Gmail API off, the client refused).
  void noteProviderFailure(
    APP_PROVIDER[e.provider],
    { reason: e.code === 'api_disabled' ? 'config' : 'auth', message: e.message },
    'app',
  )
}

/** What the member reads when a provider fails: the app's problem, the account's, or the provider being down. */
function rejectMailError(e: unknown, provider: MailProviderId): never {
  noteMailAppFailure(e)
  const label = MAIL_PROVIDER_LABEL[provider]
  if (e instanceof MailError) {
    if (e.code === 'api_disabled') throw Reject.t('server.api.mail.apiDisabled', undefined, 'api_disabled')
    if (isAppFailure(e)) throw Reject.t('server.api.mail.appRefused', { provider: label }, 'app_refused')
    if (e.kind === 'auth') throw Reject.t('server.api.mail.accessRefused', { provider: label }, 'account_refused')
    if (e.kind === 'rate_limited' || e.kind === 'unavailable')
      throw Reject.t('server.api.mail.unavailable', { provider: label }, 'unavailable')
    throw Reject.t('server.api.mail.refused', { provider: label }, 'failed')
  }
  if (e instanceof SecretsKeyError) throw Reject.t('server.api.mail.noSecretsKey', undefined, 'no_secrets_key')
  throw e
}

/** Whether a committed connection (any workspace) holds this account: then its grant must not be revoked. */
async function heldByAnother(provider: MailProviderId, accountEmail: string) {
  const [row] = await db
    .select({ id: mail_connections.id })
    .from(mail_connections)
    .where(and(eq(mail_connections.provider, provider), eq(mail_connections.account_email, accountEmail)))
    .limit(1)
  return Boolean(row)
}

/** Marks a mailbox whose grant the provider refused; outside the action's transaction, so it sticks when the action is rejected. */
async function markNeedsReconnect(connectionId: string, reason: string) {
  await db
    .update(mail_connections)
    .set({ status: 'needs_reconnect', last_error: reason })
    .where(eq(mail_connections.id, connectionId))
    .catch(e => console.error(`could not mark mail connection ${connectionId}: ${errorMessage(e)}`))
}

async function saveTokens(
  tx: Tx,
  connection: Pick<MailConnection, 'id' | 'workspace_id'>,
  tokens: OAuthTokens,
  refreshToken: string,
) {
  const values = {
    access_token_encrypted: encryptSecret(tokens.accessToken, mailSlot(connection.id, 'access')),
    refresh_token_encrypted: encryptSecret(refreshToken, mailSlot(connection.id, 'refresh')),
    expires_at: tokens.expiresAt,
    scope: tokens.scope,
    updated_at: new Date().toISOString(),
  }
  await tx
    .insert(mail_credentials)
    .values({ connection_id: connection.id, workspace_id: connection.workspace_id, ...values })
    .onConflictDoUpdate({ target: mail_credentials.connection_id, set: values })
}

/**
 * The token source of a mailbox: the stored access token while it is good, else a refreshed one, stored again (Microsoft
 * may hand out a new refresh token each time; the newest is kept). A refused refresh marks the mailbox `needs_reconnect`.
 */
function tokenSource(tx: Tx, ctx: Pick<HandlerCtx, 'mail'>, connection: MailConnection): AccessTokenSource {
  return async (forceRefresh = false) => {
    const [credentials] = await tx
      .select()
      .from(mail_credentials)
      .where(eq(mail_credentials.connection_id, connection.id))
    if (!credentials)
      throw Reject.t('server.api.mail.noStoredAccess', { account: connection.account_email }, 'account_refused')
    if (!forceRefresh && Date.parse(credentials.expires_at) - Date.now() > REFRESH_MARGIN_MS)
      return decryptSecret(credentials.access_token_encrypted, mailSlot(connection.id, 'access'))
    const refreshToken = decryptSecret(credentials.refresh_token_encrypted, mailSlot(connection.id, 'refresh'))
    const oauth = await oauthOrReject(tx, ctx, connection.provider)
    try {
      const tokens = await oauth.refresh(refreshToken)
      await saveTokens(tx, connection, tokens, tokens.refreshToken ?? refreshToken)
      void noteProviderOk(APP_PROVIDER[connection.provider])
      return tokens.accessToken
    } catch (e) {
      noteMailAppFailure(e)
      if (e instanceof MailError && e.kind === 'auth' && !isAppFailure(e))
        // A code, not the provider's words: the row is synced to every member (MailConnectError).
        await markNeedsReconnect(connection.id, 'account_refused' satisfies MailConnectError)
      throw e
    }
  }
}

/**
 * The adapter for a connected mailbox of a workspace, for reading its messages (the support mail analysis). A grant the
 * provider refused while reading marks the mailbox `needs_reconnect`.
 */
export async function mailboxFor(tx: Tx, ctx: Pick<HandlerCtx, 'mail'>, workspaceId: string, connectionId: string) {
  const [connection] = await tx
    .select()
    .from(mail_connections)
    .where(and(eq(mail_connections.id, connectionId), eq(mail_connections.workspace_id, workspaceId)))
  if (!connection) throw Reject.t('server.api.mail.accountNotFound', undefined, 'not_connected')
  const provider = servicesOf(ctx).provider(connection.provider, {
    accessToken: tokenSource(tx, ctx, connection),
    accountEmail: connection.account_email,
  })
  return { connection, provider }
}

export const mailConnectionHandlers: Record<string, Handler> = {
  'mail.connectStart': async ({ tx, actor, now, ...ctx }, input: { provider: MailProviderId }) => {
    const workspace_id = workspaceOf(actor)
    // A mailbox connected while signed in as someone else would put the admin's mail into the user's workspace.
    if (actor.impersonation) throw Forbidden.t('server.api.notWhileImpersonating')
    const oauth = await oauthOrReject(tx, ctx, input.provider)
    if (!hasSecretsKey()) throw Reject.t('server.api.mail.noSecretsKey', undefined, 'no_secrets_key')
    const { verifier, challenge } = await pkcePair()
    const state = randomBytes(32).toString('base64url')
    await tx.delete(mail_oauth_states).where(lt(mail_oauth_states.expires_at, now))
    await tx.insert(mail_oauth_states).values({
      id: state,
      workspace_id,
      user_id: actor.actorId,
      provider: input.provider,
      code_verifier: verifier,
      expires_at: new Date(Date.parse(now) + STATE_TTL_MS).toISOString(),
    })
    const data: MailConnectStartData = {
      url: oauth.authorizeUrl({ redirectUri: mailRedirectUri(input.provider), state, codeChallenge: challenge }),
    }
    return { rows: {}, data }
  },

  'mail.connectFinish': async (
    { tx, actor, now, onRollback, ...ctx },
    input: { provider: MailProviderId; state: string; code: string },
  ) => {
    const workspace_id = workspaceOf(actor)
    if (actor.impersonation) throw Forbidden.t('server.api.notWhileImpersonating')
    // The state is single use and only good for the member who started the connect, in that workspace.
    const [started] = await tx.delete(mail_oauth_states).where(eq(mail_oauth_states.id, input.state)).returning()
    if (
      !started ||
      started.user_id !== actor.actorId ||
      started.provider !== input.provider ||
      Date.parse(started.expires_at) < Date.parse(now)
    )
      throw Reject.t('server.api.mail.connectExpired', undefined, 'expired')
    if (started.workspace_id !== workspace_id)
      throw Reject.t('server.api.mail.switchedWorkspace', undefined, 'other_workspace')
    const oauth = await oauthOrReject(tx, ctx, input.provider)
    let tokens: OAuthTokens
    try {
      tokens = await oauth.exchangeCode({
        code: input.code,
        redirectUri: mailRedirectUri(input.provider),
        codeVerifier: started.code_verifier,
      })
    } catch (e) {
      return rejectMailError(e, input.provider)
    }
    const grant = tokens.refreshToken ?? tokens.accessToken
    // Whatever goes wrong from here, the grant just made is withdrawn again, unless the account is connected already
    // (here or in another workspace): Google withdraws the account's whole grant to the app, the working one too.
    let account_email: string | null = null
    onRollback?.(async () => {
      // i18n-ignore: the command log's note on the undo, never shown in the app
      if (account_email && (await heldByAnother(input.provider, account_email)))
        return 'the access was kept: the mailbox is connected already'
      return (await oauth.revoke(grant).catch(() => false))
        ? // i18n-ignore: the command log's note on the undo, never shown in the app
          'the new access was revoked'
        : // i18n-ignore: the command log's note on the undo, never shown in the app
          'the new access could not be revoked'
    })
    let emailFailure: unknown
    account_email = await oauth
      .accountEmail(tokens.accessToken)
      .then(email => email.trim().toLowerCase())
      .catch(e => {
        emailFailure = e
        return null
      })
    const label = MAIL_PROVIDER_LABEL[input.provider]
    if (!tokens.refreshToken) throw Reject.t('server.api.mail.noLastingAccess', { provider: label }, 'no_grant')
    if (!oauth.grantsMailRead(tokens.scope))
      throw Reject.t('server.api.mail.missingScope', { provider: label }, 'scope')
    if (!account_email) return rejectMailError(emailFailure, input.provider)
    // One message read proves the access works (and, for Gmail, that the app's project has the Gmail API on).
    const check = servicesOf(ctx).provider(input.provider, {
      accessToken: async () => tokens.accessToken,
      accountEmail: account_email,
    })
    await check.listMessages({ max: 1 }).catch(e => rejectMailError(e, input.provider))
    void noteProviderOk(APP_PROVIDER[input.provider])

    const [existing] = await tx
      .select()
      .from(mail_connections)
      .where(
        and(
          eq(mail_connections.workspace_id, workspace_id),
          eq(mail_connections.provider, input.provider),
          eq(mail_connections.account_email, account_email),
        ),
      )
    const [connection] = existing
      ? await tx
          .update(mail_connections)
          .set({ status: 'connected', last_error: null, connected_by: actor.actorId })
          .where(eq(mail_connections.id, existing.id))
          .returning()
      : await tx
          .insert(mail_connections)
          .values({
            id: newId('mail'),
            workspace_id,
            provider: input.provider,
            account_email,
            connected_by: actor.actorId,
          })
          .returning()
    await saveTokens(tx, connection!, tokens, tokens.refreshToken)
    const data: MailConnectFinishData = { connectionId: connection!.id }
    return { rows: { mail_connections: [connection!] }, data }
  },

  // Deleted here first; the provider is asked last. A provider that cannot be reached does not keep the mailbox
  // connected: the tokens are gone either way, and the result says whether the grant may remain.
  'mail.disconnect': async ({ tx, actor, ...ctx }, input: { connectionId: string }) => {
    const workspace_id = workspaceOf(actor)
    // Read before the delete: the tokens go with the connection (foreign key cascade).
    const [credentials] = await tx
      .select({ refresh: mail_credentials.refresh_token_encrypted })
      .from(mail_credentials)
      .where(
        and(eq(mail_credentials.connection_id, input.connectionId), eq(mail_credentials.workspace_id, workspace_id)),
      )
    const [connection] = await tx
      .delete(mail_connections)
      .where(and(eq(mail_connections.id, input.connectionId), eq(mail_connections.workspace_id, workspace_id)))
      .returning()
    if (!connection) throw Reject.t('server.api.mail.accountNotFound', undefined, 'not_connected')
    let revoked = false
    // Google withdraws the whole grant of the account to the app: one another workspace holds too stays.
    const [shared] = await tx
      .select({ id: mail_connections.id })
      .from(mail_connections)
      .where(
        and(
          eq(mail_connections.provider, connection.provider),
          eq(mail_connections.account_email, connection.account_email),
        ),
      )
      .limit(1)
    const oauth = shared
      ? null
      : await servicesOf(ctx)
          .oauth(tx, connection.provider)
          .catch(() => null)
    if (oauth && credentials) {
      revoked = await oauth.revoke(decryptSecret(credentials.refresh, mailSlot(connection.id, 'refresh'))).catch(e => {
        console.error(`could not revoke mail connection ${connection.id}: ${errorMessage(e)}`)
        return false
      })
    }
    const data: MailDisconnectData = { revoked }
    return { rows: {}, deleted: { mail_connections: [connection.id] }, data }
  },
}
