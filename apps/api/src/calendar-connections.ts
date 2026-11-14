// Calendar accounts of a workspace: connecting by OAuth (with PKCE and a state bound to the member
// and workspace), tokens encrypted with SECRETS_KEY and refreshed when they run out, or by password
// (CalDAV: the login checked against the server, then stored encrypted the same way), the adapter
// for a connection, disconnecting with revocation, and the calendars an assistant books into.
import { randomBytes } from 'node:crypto'
import {
  type CalendarProviderId, type ConnectStartData, type ConnectWithPasswordData, type DisconnectData, type ListCalendarsData, type OAuthCalendarProviderId,
  type ProviderAudience, providerFailureText,
} from '@linedesk/actions'
import {
  type AccessTokenSource, CALENDAR_PROVIDER_LABEL, type CalendarAccess, CalendarError, type CalendarLogin, type CalendarOAuth, type CalendarProvider,
  type OAuthTokens, type PasswordCalendarProviderName, calendarOAuthFromEnv, createCalendarProvider, isPasswordProvider, pkcePair,
} from '@linedesk/calendar'
import { assistant_calendars, assistants, calendar_connections, calendar_credentials, calendar_oauth_states, type CalendarConnection, type Tx } from '@linedesk/db'
import { and, asc, eq, lt, ne } from 'drizzle-orm'
import { ensureAppointmentType, timeZoneOf } from './bookings.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { type Handler, type HandlerCtx, Forbidden, Reject } from './handler-context.ts'
import { audienceOf, noteProviderFailure, noteProviderOk } from './provider-failures.ts'
import { decryptSecret, encryptSecret, hasSecretsKey, SecretsKeyError } from './secrets.ts'
import { brandName } from './branding.ts'
import { calendarServerFetch, calendarServerUrl } from './calendar-server-fetch.ts'

/** How the API reaches calendar providers; tests pass fakes through the handler context. */
export type CalendarServices = {
  oauth(name: OAuthCalendarProviderId): CalendarOAuth | null
  provider(name: CalendarProviderId, access: CalendarAccess): CalendarProvider
  /** The calendar server a member typed for a password provider, or why it is refused. Default: calendarServerUrl. */
  serverUrl?(typed: string): Promise<URL | string>
}

export const defaultCalendarServices: CalendarServices = {
  oauth: name => calendarOAuthFromEnv(name, process.env),
  // A password provider's server is one a member named: its requests go through the address guard.
  provider: (name, access) =>
    createCalendarProvider(name, 'login' in access ? { ...access, fetch: calendarServerFetch(new URL(access.login.serverUrl)) } : access),
  serverUrl: typed => calendarServerUrl(typed),
}

const servicesOf = (ctx: Pick<HandlerCtx, 'calendars'>) => ctx.calendars ?? defaultCalendarServices

const LABEL = CALENDAR_PROVIDER_LABEL
const ENV: Record<OAuthCalendarProviderId, string> = { google: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET', microsoft: 'MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET' }

/**
 * A password connection's row in calendar_credentials: the login (JSON) where the access token goes, an empty refresh
 * token and an expiry long past, so the columns OAuth needs stay as they are (no migration) and key rotation covers it
 * too. This code never reads the expiry of a login. A release before this one (a rollback, the old API during an
 * update) reads the row as OAuth: the expiry makes it refresh with the empty token, which fails, so it never sends
 * the login anywhere as an access token.
 */
const PASSWORD_LOGIN_EXPIRES = '1970-01-01T00:00:00.000Z'

const NO_SECRETS_KEY = 'SECRETS_KEY is not set, so calendar access cannot be stored. Generate one with `openssl rand -base64 32`, set it in the environment of the API and restart.'

/** A started connect is good for this long: enough to pick an account and consent. */
const STATE_TTL_MS = 10 * 60_000
/** An access token is refreshed when it has less than this left, so no request starts with a dying one. */
const REFRESH_MARGIN_MS = 60_000

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Where the provider sends the browser back: the public address of this install, which serves /v1 too. */
export function calendarRedirectUri(provider: CalendarProviderId, base = process.env.BETTER_AUTH_URL ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173') {
  return new URL(`/v1/calendar/callback/${provider}`, base).toString()
}

/** The ciphertext of each token is bound to its connection and kind: a value moved to another row does not decrypt. */
/** The slot (secrets.ts) of a calendar connection's token. */
export const calendarSlot = (connectionId: string, kind: 'access' | 'refresh') => `calendar.${connectionId}.${kind}`
const slot = calendarSlot

function workspaceOf(actor: Actor) {
  if (!actor.workspaceId) throw new Reject('no workspace')
  return actor.workspaceId
}

function oauthOrReject(ctx: Pick<HandlerCtx, 'calendars'>, provider: OAuthCalendarProviderId) {
  const oauth = servicesOf(ctx).oauth(provider)
  if (!oauth) throw new Reject(`${LABEL[provider]} calendars are not set up on this server (${ENV[provider]})`)
  return oauth
}

/** Codes that mean the app (client ID and secret, its Google Cloud project) is refused, not one account. */
const APP_FAILURES = new Set(['invalid_client', 'unauthorized_client', 'api_disabled'])
/** The server's calendar app is refused: every account fails alike, none needs reconnecting. */
const isAppFailure = (e: CalendarError) => Boolean(e.code && APP_FAILURES.has(e.code))

/**
 * A calendar failure that is the install's to fix (an expired client secret, the Calendar API off) is recorded as a
 * failure of the sign-in and calendar app (provider-failures.ts); one account's lost grant is not.
 */
export function noteCalendarAppFailure(e: unknown) {
  if (!(e instanceof CalendarError) || !isAppFailure(e) || isPasswordProvider(e.provider)) return
  const label = LABEL[e.provider]
  void noteProviderFailure(
    e.provider,
    e.code === 'api_disabled'
      ? {
          reason: 'config',
          message: 'The Google Calendar API is not enabled in the Google Cloud project of the app: enable it there (APIs & Services). Calendars cannot be read or booked until then.',
        }
      : {
          reason: 'auth',
          message: `${label} refused the app's client ID or secret while using a calendar (an expired secret?). Enter a new client secret under Admin › Providers › ${label}.`,
        },
    'calendar',
  )
}

/** Provider failures are the member's to see: a reason, never a token, and no retry. */
function rejectCalendarError(e: unknown): never {
  noteCalendarAppFailure(e)
  if (e instanceof CalendarError) throw new Reject(e.message)
  if (e instanceof SecretsKeyError) throw new Reject(e.message)
  throw e
}

/** Marks a connection whose grant the provider refused; outside the action's transaction, so it sticks when the action is rejected. */
async function markNeedsReconnect(connectionId: string, reason: string) {
  await db.update(calendar_connections).set({ status: 'needs_reconnect', last_error: reason }).where(eq(calendar_connections.id, connectionId))
    .catch(e => console.error(`could not mark calendar connection ${connectionId}: ${errorMessage(e)}`))
}

async function saveTokens(tx: Tx, connection: Pick<CalendarConnection, 'id' | 'workspace_id'>, tokens: OAuthTokens, refreshToken: string) {
  const values = {
    access_token_encrypted: encryptSecret(tokens.accessToken, slot(connection.id, 'access')),
    refresh_token_encrypted: encryptSecret(refreshToken, slot(connection.id, 'refresh')),
    expires_at: tokens.expiresAt,
    scope: tokens.scope,
    updated_at: new Date().toISOString(),
  }
  await tx.insert(calendar_credentials).values({ connection_id: connection.id, workspace_id: connection.workspace_id, ...values })
    .onConflictDoUpdate({ target: calendar_credentials.connection_id, set: values })
}

/**
 * The token source for a connection: the stored access token while it is good, else a refreshed one,
 * stored again (Microsoft may hand out a new refresh token each time; the newest is kept). A refused
 * refresh marks the connection `needs_reconnect`.
 */
export function tokenSource(tx: Tx, ctx: Pick<HandlerCtx, 'calendars'>, connection: CalendarConnection): AccessTokenSource {
  const provider = connection.provider
  if (isPasswordProvider(provider)) throw new Error(`a ${LABEL[provider]} connection signs in with its login, not a token`)
  return async (forceRefresh = false) => {
    const [credentials] = await tx.select().from(calendar_credentials).where(eq(calendar_credentials.connection_id, connection.id))
    if (!credentials) throw new Reject(`the ${LABEL[connection.provider]} account ${connection.account_email} has no stored access: connect it again`)
    if (!forceRefresh && Date.parse(credentials.expires_at) - Date.now() > REFRESH_MARGIN_MS) {
      return decryptSecret(credentials.access_token_encrypted, slot(connection.id, 'access'))
    }
    const refreshToken = decryptSecret(credentials.refresh_token_encrypted, slot(connection.id, 'refresh'))
    try {
      const tokens = await oauthOrReject(ctx, provider).refresh(refreshToken)
      await saveTokens(tx, connection, tokens, tokens.refreshToken ?? refreshToken)
      void noteProviderOk(provider)
      return tokens.accessToken
    } catch (e) {
      noteCalendarAppFailure(e)
      if (e instanceof CalendarError && e.kind === 'auth' && !isAppFailure(e)) await markNeedsReconnect(connection.id, e.message)
      throw e
    }
  }
}

async function saveLogin(tx: Tx, connection: Pick<CalendarConnection, 'id' | 'workspace_id'>, login: CalendarLogin) {
  const values = {
    access_token_encrypted: encryptSecret(JSON.stringify(login), slot(connection.id, 'access')),
    refresh_token_encrypted: encryptSecret('', slot(connection.id, 'refresh')),
    expires_at: PASSWORD_LOGIN_EXPIRES,
    scope: null,
    updated_at: new Date().toISOString(),
  }
  await tx.insert(calendar_credentials).values({ connection_id: connection.id, workspace_id: connection.workspace_id, ...values })
    .onConflictDoUpdate({ target: calendar_credentials.connection_id, set: values })
}

/** The stored login of a password connection. */
async function loginOf(tx: Tx, connection: CalendarConnection): Promise<CalendarLogin> {
  const [credentials] = await tx.select({ access: calendar_credentials.access_token_encrypted }).from(calendar_credentials)
    .where(eq(calendar_credentials.connection_id, connection.id))
  if (!credentials) throw new Reject(`the ${LABEL[connection.provider]} account ${connection.account_email} has no stored login: connect it again`)
  const login = JSON.parse(decryptSecret(credentials.access, slot(connection.id, 'access'))) as Partial<CalendarLogin>
  if (typeof login.serverUrl !== 'string' || typeof login.username !== 'string' || typeof login.password !== 'string') {
    throw new Reject(`the stored login of ${connection.account_email} is unreadable: connect it again`)
  }
  return { serverUrl: login.serverUrl, username: login.username, password: login.password }
}

/**
 * A password provider has no refresh: a refused login means the password was revoked or changed (an Apple ID password
 * change revokes every app-specific password). The connection is marked, like a refused OAuth refresh.
 */
function markingRefusedLogin(provider: CalendarProvider, connection: CalendarConnection): CalendarProvider {
  const marked = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try {
      return await call(...args)
    } catch (e) {
      if (e instanceof CalendarError && e.kind === 'auth') await markNeedsReconnect(connection.id, e.message)
      throw e
    }
  }
  return {
    name: provider.name,
    listCalendars: marked(() => provider.listCalendars()),
    busy: marked((ids, window) => provider.busy(ids, window)),
    createEvent: marked((id, event) => provider.createEvent(id, event)),
    updateEvent: marked((id, eventId, event) => provider.updateEvent(id, eventId, event)),
    deleteEvent: marked((id, eventId) => provider.deleteEvent(id, eventId)),
    getEvent: marked((id, eventId) => provider.getEvent(id, eventId)),
  }
}

/** The adapter for a connection of the actor's workspace. */
export async function providerFor(tx: Tx, ctx: Pick<HandlerCtx, 'calendars'>, workspaceId: string, connectionId: string) {
  const [connection] = await tx.select().from(calendar_connections)
    .where(and(eq(calendar_connections.id, connectionId), eq(calendar_connections.workspace_id, workspaceId)))
  if (!connection) throw new Reject('calendar account not found')
  const services = servicesOf(ctx)
  if (isPasswordProvider(connection.provider)) {
    const login = await loginOf(tx, connection).catch(e => rejectCalendarError(e))
    // All-day events in a CalDAV calendar have no zone of their own: they are the business's days.
    const timeZone = await timeZoneOf(tx, workspaceId)
    return { connection, provider: markingRefusedLogin(services.provider(connection.provider, { login, timeZone }), connection) }
  }
  return { connection, provider: services.provider(connection.provider, { accessToken: tokenSource(tx, ctx, connection) }) }
}

/**
 * Why the calendars could not be listed, in the shared provider-failure words (LIN-111): the server's calendar app
 * refused (admins: Server admin › Providers, members: whoever runs the server), the account's access withdrawn (connect
 * it again), the provider busy or down (try again). Anything else keeps the provider's reason. Exported for tests.
 */
export function calendarProblemText(e: CalendarError, connection: Pick<CalendarConnection, 'provider' | 'account_email'>, audience: ProviderAudience): string {
  const label = LABEL[connection.provider]
  if (e.code === 'api_disabled') return providerFailureText('config', `The ${label} Calendar app of this server`, audience)
  if (isAppFailure(e)) return providerFailureText('auth', `${label} Calendar`, audience)
  if (e.kind === 'auth' && isPasswordProvider(connection.provider))
    return `The calendar server no longer accepts the password of ${connection.account_email}. Connect the account again with a new app-specific password.`
  if (e.kind === 'auth') return `${label} no longer accepts the access to ${connection.account_email}. Connect the account again.`
  if (e.kind === 'rate_limited' || e.kind === 'unavailable') return providerFailureText('network', `${label} Calendar`, audience)
  return e.message
}

/** The member's calendars on a provider; a refused grant marks the connection and says so. */
async function listAt(provider: CalendarProvider, connection: CalendarConnection, audience: ProviderAudience) {
  try {
    return await provider.listCalendars()
  } catch (e) {
    if (e instanceof CalendarError && e.kind === 'auth' && !isAppFailure(e)) await markNeedsReconnect(connection.id, e.message)
    if (e instanceof CalendarError) {
      noteCalendarAppFailure(e)
      throw new Reject(calendarProblemText(e, connection, audience))
    }
    return rejectCalendarError(e)
  }
}

/** Google lets the member untick scopes on the consent page; without these the connection is useless. */
const REQUIRED_SCOPES: Record<OAuthCalendarProviderId, RegExp[]> = {
  google: [/\/auth\/calendar\.events(\s|$)/, /\/auth\/calendar\.freebusy(\s|$)/, /\/auth\/calendar\.calendarlist\.readonly(\s|$)/],
  microsoft: [/calendars\.readwrite/i],
}

function missingScope(provider: OAuthCalendarProviderId, scope: string | null) {
  // A provider that does not report the scopes is trusted; the first calendar request would fail anyway.
  return scope !== null && REQUIRED_SCOPES[provider].some(required => !required.test(scope))
}

export const calendarConnectionHandlers: Record<string, Handler> = {
  'calendar.connectStart': async ({ tx, actor, now, ...ctx }, input: { provider: OAuthCalendarProviderId }) => {
    const workspace_id = workspaceOf(actor)
    // A calendar connected while signed in as someone else would put the admin's account into the user's workspace.
    if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
    const oauth = oauthOrReject(ctx, input.provider)
    if (!hasSecretsKey()) throw new Reject(NO_SECRETS_KEY)
    const { verifier, challenge } = await pkcePair()
    const state = randomBytes(32).toString('base64url')
    await tx.delete(calendar_oauth_states).where(lt(calendar_oauth_states.expires_at, now))
    await tx.insert(calendar_oauth_states).values({
      id: state, workspace_id, user_id: actor.actorId, provider: input.provider, code_verifier: verifier,
      expires_at: new Date(Date.parse(now) + STATE_TTL_MS).toISOString(),
    })
    const data: ConnectStartData = { url: oauth.authorizeUrl({ redirectUri: calendarRedirectUri(input.provider), state, codeChallenge: challenge }) }
    return { rows: {}, data }
  },

  'calendar.connectFinish': async ({ tx, actor, now, onRollback, ...ctx }, input: { provider: OAuthCalendarProviderId; state: string; code: string }) => {
    const workspace_id = workspaceOf(actor)
    if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
    // The state is single use and only good for the member who started the connect, in that workspace.
    const [started] = await tx.delete(calendar_oauth_states).where(eq(calendar_oauth_states.id, input.state)).returning()
    if (!started || started.user_id !== actor.actorId || started.provider !== input.provider || Date.parse(started.expires_at) < Date.parse(now)) {
      throw new Reject('This connect link has expired or is not yours. Start again from Settings.')
    }
    if (started.workspace_id !== workspace_id) throw new Reject('You switched workspace while connecting. Start again from Settings.')
    const oauth = oauthOrReject(ctx, input.provider)
    let tokens: OAuthTokens
    try {
      tokens = await oauth.exchangeCode({ code: input.code, redirectUri: calendarRedirectUri(input.provider), codeVerifier: started.code_verifier })
    } catch (e) {
      return rejectCalendarError(e)
    }
    const grant = tokens.refreshToken ?? tokens.accessToken
    // Whatever goes wrong from here, the grant just made is withdrawn again.
    onRollback?.(async () => ((await oauth.revoke(grant).catch(() => false)) ? 'the new access was revoked' : 'the new access could not be revoked'))
    if (!tokens.refreshToken) throw new Reject(`${LABEL[input.provider]} did not grant lasting access. Start again and allow access.`)
    if (missingScope(input.provider, tokens.scope)) throw new Reject(`${brandName()} needs to see and edit your calendar events. Start again and allow every calendar permission.`)
    const account_email = (await oauth.accountEmail(tokens.accessToken).catch(e => rejectCalendarError(e))).toLowerCase()

    const [existing] = await tx.select().from(calendar_connections).where(and(
      eq(calendar_connections.workspace_id, workspace_id), eq(calendar_connections.provider, input.provider), eq(calendar_connections.account_email, account_email),
    ))
    const [connection] = existing
      ? await tx.update(calendar_connections).set({ status: 'connected', last_error: null, connected_by: actor.actorId }).where(eq(calendar_connections.id, existing.id)).returning()
      : await tx.insert(calendar_connections).values({ id: newId('calc'), workspace_id, provider: input.provider, account_email, connected_by: actor.actorId }).returning()
    await saveTokens(tx, connection!, tokens, tokens.refreshToken)
    return { rows: { calendar_connections: [connection!] }, data: { connectionId: connection!.id } }
  },

  'calendar.connectWithPassword': async ({ tx, actor, ...ctx }, input: { provider: PasswordCalendarProviderName; serverUrl: string; username: string; password: string }) => {
    const workspace_id = workspaceOf(actor)
    if (actor.impersonation) throw new Forbidden('Not possible while signed in as another user.')
    if (!hasSecretsKey()) throw new Reject(NO_SECRETS_KEY)
    const services = servicesOf(ctx)
    const server = await (services.serverUrl ?? defaultCalendarServices.serverUrl!)(input.serverUrl)
    if (typeof server === 'string') throw new Reject(server)
    const login: CalendarLogin = { serverUrl: server.toString(), username: input.username, password: input.password }
    // The login is checked before anything is stored: the server must accept it and show at least one calendar.
    let calendars: Awaited<ReturnType<CalendarProvider['listCalendars']>>
    try {
      calendars = await services.provider(input.provider, { login }).listCalendars()
    } catch (e) {
      if (e instanceof CalendarError && e.kind === 'auth') {
        throw new Reject(`${server.host} did not accept that user name and password. Check both; for iCloud, use an app-specific password, not your Apple ID password.`)
      }
      return rejectCalendarError(e)
    }
    if (!calendars.length) throw new Reject(`${server.host} shows no calendars for ${input.username}.`)
    const account_email = passwordAccountLabel(login)

    const [existing] = await tx.select().from(calendar_connections).where(and(
      eq(calendar_connections.workspace_id, workspace_id), eq(calendar_connections.provider, input.provider), eq(calendar_connections.account_email, account_email),
    ))
    // The same account on another server is another account: its calendars must not be read from the new one.
    const stored = existing && (await loginOf(tx, existing).catch(() => null))
    if (stored && stored.serverUrl !== login.serverUrl) throw new Reject(`${account_email} is connected on ${new URL(stored.serverUrl).host} already. Disconnect it there first.`)
    const [connection] = existing
      ? await tx.update(calendar_connections).set({ status: 'connected', last_error: null, connected_by: actor.actorId }).where(eq(calendar_connections.id, existing.id)).returning()
      : await tx.insert(calendar_connections).values({ id: newId('calc'), workspace_id, provider: input.provider, account_email, connected_by: actor.actorId }).returning()
    await saveLogin(tx, connection!, login)
    const data: ConnectWithPasswordData = { connectionId: connection!.id }
    return { rows: { calendar_connections: [connection!] }, data }
  },

  'calendar.listCalendars': async ({ tx, actor, ...ctx }, input: { connectionId: string }) => {
    const { connection, provider } = await providerFor(tx, ctx, workspaceOf(actor), input.connectionId)
    const data: ListCalendarsData = { calendars: await listAt(provider, connection, audienceOf(actor)) }
    return { rows: {}, data }
  },

  // Deleted here first; the provider is asked last. A provider that cannot be reached does not keep
  // the account connected: the tokens are gone either way, and the result says the grant may remain.
  'calendar.disconnect': async ({ tx, actor, ...ctx }, input: { connectionId: string }) => {
    const workspace_id = workspaceOf(actor)
    // Read before the delete: the tokens go with the connection (foreign key cascade), as do its assistant calendars.
    const [credentials] = await tx.select({ refresh: calendar_credentials.refresh_token_encrypted }).from(calendar_credentials)
      .where(and(eq(calendar_credentials.connection_id, input.connectionId), eq(calendar_credentials.workspace_id, workspace_id)))
    const calendars = await tx.select({ id: assistant_calendars.id }).from(assistant_calendars)
      .where(and(eq(assistant_calendars.connection_id, input.connectionId), eq(assistant_calendars.workspace_id, workspace_id)))
    const [connection] = await tx.delete(calendar_connections)
      .where(and(eq(calendar_connections.id, input.connectionId), eq(calendar_connections.workspace_id, workspace_id))).returning()
    if (!connection) throw new Reject('calendar account not found')
    const data: DisconnectData = await revokeGrant(ctx, connection, credentials?.refresh)
    return { rows: {}, deleted: { calendar_connections: [connection.id], assistant_calendars: calendars.map(c => c.id) }, data }
  },

  'assistantCalendar.add': async ({ tx, actor, ...ctx }, input: { assistantId: string; connectionId: string; externalId: string; instruction?: string }) => {
    const workspace_id = workspaceOf(actor)
    const [assistant] = await tx.select({ id: assistants.id }).from(assistants).where(and(eq(assistants.id, input.assistantId), eq(assistants.workspace_id, workspace_id)))
    if (!assistant) throw new Reject('assistant not found')
    const { connection, provider } = await providerFor(tx, ctx, workspace_id, input.connectionId)
    // The calendar must be one this account can write to; its name comes from the provider.
    const calendar = (await listAt(provider, connection, audienceOf(actor))).find(c => c.id === input.externalId)
    if (!calendar) throw new Reject(`no such calendar in ${connection.account_email}`)
    if (!calendar.canWrite) throw new Reject(`${calendar.name} is read-only for ${connection.account_email}: pick a calendar you can add events to`)
    const [taken] = await tx.select({ id: assistant_calendars.id }).from(assistant_calendars).where(and(
      eq(assistant_calendars.assistant_id, assistant.id), eq(assistant_calendars.connection_id, connection.id), eq(assistant_calendars.external_id, calendar.id),
    ))
    if (taken) throw new Reject(`${calendar.name} is already one of the assistant's calendars`)
    const [first] = await tx.select({ id: assistant_calendars.id }).from(assistant_calendars).where(eq(assistant_calendars.assistant_id, assistant.id)).limit(1)
    const rows = await tx.insert(assistant_calendars).values({
      id: newId('acal'), workspace_id, assistant_id: assistant.id, connection_id: connection.id, external_id: calendar.id, name: calendar.name,
      instruction: input.instruction ?? '', is_default: !first,
    }).returning()
    const types = await ensureAppointmentType(tx, workspace_id)
    return {
      rows: { assistant_calendars: rows, ...(types.length && { appointment_types: types }) },
      data: { assistantCalendarId: rows[0]!.id },
    }
  },

  'assistantCalendar.setDefault': async ({ tx, actor }, input: { assistantCalendarId: string }) => {
    const chosen = await loadAssistantCalendar(tx, workspaceOf(actor), input.assistantCalendarId)
    const others = await tx.update(assistant_calendars).set({ is_default: false })
      .where(and(eq(assistant_calendars.assistant_id, chosen.assistant_id), ne(assistant_calendars.id, chosen.id), eq(assistant_calendars.is_default, true))).returning()
    const updated = await tx.update(assistant_calendars).set({ is_default: true, enabled: true }).where(eq(assistant_calendars.id, chosen.id)).returning()
    return { rows: { assistant_calendars: [...others, ...updated] } }
  },

  'assistantCalendar.remove': async ({ tx, actor }, input: { assistantCalendarId: string }) => {
    const removed = await loadAssistantCalendar(tx, workspaceOf(actor), input.assistantCalendarId)
    await tx.delete(assistant_calendars).where(eq(assistant_calendars.id, removed.id))
    const deleted = { assistant_calendars: [removed.id] }
    // The assistant keeps a default as long as it has a calendar: the oldest remaining one.
    if (!removed.is_default) return { rows: {}, deleted }
    const [next] = await tx.select().from(assistant_calendars).where(eq(assistant_calendars.assistant_id, removed.assistant_id)).orderBy(asc(assistant_calendars.created_at)).limit(1)
    return { rows: next ? { assistant_calendars: await tx.update(assistant_calendars).set({ is_default: true }).where(eq(assistant_calendars.id, next.id)).returning() } : {}, deleted }
  },
}

/** How a password account is named in the app: its user name when that is an address, else `<user name>@<server host>`. */
export function passwordAccountLabel(login: CalendarLogin): string {
  const username = login.username.trim().toLowerCase()
  return username.includes('@') ? username : `${username}@${new URL(login.serverUrl).hostname}`
}

async function loadAssistantCalendar(tx: Tx, workspaceId: string, id: string) {
  const [row] = await tx.select().from(assistant_calendars).where(and(eq(assistant_calendars.id, id), eq(assistant_calendars.workspace_id, workspaceId)))
  if (!row) throw new Reject('calendar not found')
  return row
}

/** Withdraws the grant at the provider with the stored refresh token. Never throws: the result says what happened. */
async function revokeGrant(ctx: Pick<HandlerCtx, 'calendars'>, connection: CalendarConnection, refreshEncrypted: string | undefined): Promise<DisconnectData> {
  // A password cannot be withdrawn from here: its owner deletes it where they made it.
  if (isPasswordProvider(connection.provider)) {
    return { revoked: false, note: `The login is deleted here. Also delete the app-specific password you made for ${brandName()} (iCloud: account.apple.com, Sign-In and Security, App-Specific Passwords).` }
  }
  const oauth = servicesOf(ctx).oauth(connection.provider)
  if (!oauth || !refreshEncrypted) return { revoked: false, note: `Remove ${brandName()}'s access in your ${LABEL[connection.provider]} account settings.` }
  try {
    const revoked = await oauth.revoke(decryptSecret(refreshEncrypted, slot(connection.id, 'refresh')))
    return revoked ? { revoked, note: null } : { revoked, note: `${LABEL[connection.provider]} keeps the access until you remove ${brandName()} in your Microsoft account (account.microsoft.com, Privacy, Apps and services).` }
  } catch (e) {
    return { revoked: false, note: `${LABEL[connection.provider]} could not be reached to revoke access (${errorMessage(e)}): remove ${brandName()} in your account settings.` }
  }
}
