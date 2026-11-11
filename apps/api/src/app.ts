import { actions, CLONE_BODY_MAX_BYTES, openApiDocument } from '@linedesk/actions'
import {
  assistants,
  member,
  organization,
  passkey,
  user,
  workspace_settings,
  tableNames,
  type TableName,
} from '@linedesk/db'
import { APIError } from 'better-auth/api'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

/** The largest action request body, except voice.clone (a recording). */
const ACTION_BODY_MAX_BYTES = 4 * 1024 * 1024
import { setFirstPassword } from './account.ts'
import { API_KEY_REQUESTS_PER_MINUTE, apiKeyWithinLimit, isApiKey, tooManyInvalidApiKeys } from './api-keys.ts'
import { registerAdminRoutes } from './admin-routes.ts'
import { clientIpOf, withClientIp } from './client-ip.ts'
import { MCP_MAX_BODY_BYTES, serveMcp } from './mcp.ts'
import { authMethods } from './auth-methods.ts'
import { auth, TRUSTED_ORIGINS, WEB_ORIGIN, WORKSPACE_LIMIT } from './auth.ts'
import { refuseCrossSite } from './csrf.ts'
import { calendarCallback } from './calendar-callback.ts'
import { configuredCalendarProviders } from '@linedesk/calendar'
import {
  ACCOUNT_HEADER,
  accessLost,
  accountRefusal,
  clientOutdated,
  resolveCaller,
  tooManyInvalidAgentTokens,
  WORKSPACE_HEADER,
  WORKSPACE_STATE_HEADER,
  workspaceRefusal,
  type Actor,
} from './context.ts'
import { db } from './db.ts'
import { COOKIE_ACTIONS } from './impersonation.ts'
import { NOT_WHILE_IMPERSONATING } from './impersonation-guard.ts'
import { registerImpersonationRoutes } from './impersonation-routes.ts'
import { isInstanceAdmin } from './instance-admin.ts'
import { previewInvitation } from './invitations.ts'
import { signUpOpen } from './auth-methods.ts'
import { newAssistant, newWorkspaceSettings, onboardingFor, phoneSetupFor } from './onboarding.ts'
import { firstUse } from './sample-calls.ts'
import { starPromptFor } from './star-prompt.ts'
import { voiceReady } from './provider-settings.ts'
import { serveRecording } from './recording-route.ts'
import { servePreview } from './voices.ts'
import { runAction } from './run-action.ts'

const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://localhost:3001'
/** Electric refuses shape requests without it (docker-compose.yml); only the API has it. */
const ELECTRIC_SECRET = process.env.ELECTRIC_SECRET

export const app = new Hono<{ Variables: { actor: Actor } }>()

app.onError((err, c) => {
  console.error(err)
  return c.json({ ok: false, error: 'internal error' }, 500)
})

app.get('/healthz', c => c.json({ ok: true }))
app.on(['GET', 'POST'], '/api/auth/*', c => auth.handler(withClientIp(c)))

// Before every /v1 route: a write signed in by the cookie only from the web app, as JSON (csrf.ts).
app.use('/v1/*', refuseCrossSite(TRUSTED_ORIGINS))

// Public: the sign-in screen asks which methods this install offers.
app.get('/v1/auth-methods', c => c.json(authMethods))

// Public: the invitation link shows whom it is for and which workspace, before sign-in.
app.get('/v1/invitations/:id', async c => c.json(await previewInvitation(c.req.param('id'))))

export const WORKSPACE_CREATION_CLOSED =
  'New workspaces are created by an administrator on this server. Ask for an invitation to an existing one.'

/**
 * Creating a workspace is signing up a business: with sign-up closed (the default; AUTH_SIGNUP_ENABLED=true opens it) only
 * an instance admin creates one. Invitees, members and removed members join by invitation instead.
 * The admin's own account counts (a property of the user), also before they sign in again for the admin area.
 */
async function mayCreateWorkspace(userId: string): Promise<boolean> {
  if (signUpOpen()) return true
  const [account] = await db.select().from(user).where(eq(user.id, userId))
  return Boolean(account && !account.disabledAt && isInstanceAdmin(account))
}

// Create a workspace (= organization) for the signed-in user, with its assistant, and make it active.
// Better Auth writes the organization on its own connection, so this is not one transaction:
// if the assistant cannot be written the organization is removed again and the call can be repeated.
app.post('/v1/workspaces', async c => {
  const headers = c.req.raw.headers
  const session = await auth.api.getSession({ headers })
  if (!session) return c.json({ ok: false, error: 'not signed in' }, 401)
  // A workspace made as the user would outlast the impersonation (impersonation-guard.ts).
  if (session.session.impersonatedBy) return c.json({ ok: false, error: NOT_WHILE_IMPERSONATING }, 403)
  if (!(await mayCreateWorkspace(session.user.id)))
    return c.json({ ok: false, code: 'workspace_creation_closed', error: WORKSPACE_CREATION_CLOSED }, 403)
  const body = await c.req
    .json<{ name?: unknown; timeZone?: unknown }>()
    .catch(() => ({ name: undefined, timeZone: undefined }))
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 80) return c.json({ ok: false, error: 'name is required (80 characters at most)' }, 422)
  const slug = `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 6)}`
  // Refused by Better Auth when signed out or at the workspace limit (auth.ts).
  const org = await auth.api.createOrganization({ body: { name, slug }, headers }).catch(err => {
    if (!(err instanceof APIError)) throw err
    const atLimit = err.body?.code === 'YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS'
    return {
      refused: atLimit
        ? `You can create up to ${WORKSPACE_LIMIT} workspaces.`
        : err.message || 'Could not create the workspace',
      status: err.statusCode,
    }
  })
  if (!org) return c.json({ ok: false, error: 'not signed in' }, 401)
  if ('refused' in org) return c.json({ ok: false, error: org.refused }, org.status === 401 ? 401 : 403)
  try {
    await db.insert(assistants).values(newAssistant(org.id, name))
    await db.insert(workspace_settings).values(newWorkspaceSettings(org.id, body.timeZone))
  } catch (err) {
    await db.delete(organization).where(eq(organization.id, org.id))
    throw err
  }
  // Not essential: without an active workspace the member's first one is used (context.ts).
  await auth.api
    .setActiveOrganization({ body: { organizationId: org.id }, headers })
    .catch(err => console.error('set active workspace failed', err))
  return c.json({ ok: true, workspace: { id: org.id, name: org.name } })
})

// Public, before the guard: the API description lists no data, only the public actions' schemas.
const openApi = openApiDocument(actions.values(), process.env.PUBLIC_URL || WEB_ORIGIN)
app.get('/v1/openapi.json', c => c.json(openApi))

// MCP for a workspace's own AI tools: API keys only, its own gate (mcp.ts).
// The size limit applies while the body is read, also to a chunked one without content-length.
app.use('/mcp', bodyLimit({ maxSize: MCP_MAX_BODY_BYTES, onError: c => c.json({ error: 'request too large' }, 413) }))
app.all('/mcp', c => serveMcp(c.req.raw, clientIpOf(c)))

// Before the workspace guard: a member without a workspace has an account too.
app.post('/v1/account/password', setFirstPassword)

// The provider sends the browser back here after the consent page. Before the guard: it answers
// with a redirect to the settings page in every case, also when the session is gone.
app.get('/v1/calendar/callback/:provider', async c =>
  c.redirect(
    await calendarCallback(c.req.param('provider'), new URL(c.req.url).searchParams, c.req.raw.headers, WEB_ORIGIN),
  ),
)

app.use('/v1/*', async (c, next) => {
  const ip = clientIpOf(c)
  const requested = c.req.header(WORKSPACE_HEADER) ?? null
  const caller = await resolveCaller(c.req.raw.headers, ip)
  // A tab of a workspace its member was just removed from (or their last one): no access, not "signed out".
  if ('missing' in caller && caller.missing === 'no_workspace' && requested) return c.json(accessLost(), 403)
  const actor = 'actor' in caller ? caller.actor : null
  if (!actor) {
    // An address that sent too many unknown keys is not looked up any more (api-keys.ts).
    const bearer = c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
    if (isApiKey(bearer) && tooManyInvalidApiKeys(ip)) {
      c.header('retry-after', '600')
      return c.json({ ok: false, error: 'too many invalid API keys from this address; try again later' }, 429)
    }
    // Guessing the agent token: the address is refused for a while (context.ts).
    if (bearer && !isApiKey(bearer) && tooManyInvalidAgentTokens(ip)) {
      c.header('retry-after', '600')
      return c.json({ ok: false, error: 'too many invalid tokens from this address; try again later' }, 429)
    }
    // `signed_out`: no valid session (expired, signed out, account disabled); `no_workspace`: signed in, member of none.
    const code = 'missing' in caller ? caller.missing : 'signed_out'
    return c.json({ ok: false, error: 'not signed in or no workspace', code }, 401)
  }
  if (actor.apiKeyId && !apiKeyWithinLimit(actor.apiKeyId)) {
    c.header('retry-after', '60')
    return c.json({ ok: false, error: `rate limit: ${API_KEY_REQUESTS_PER_MINUTE} requests a minute per API key` }, 429)
  }
  // The tab's workspace must be the session's: never read or write another one (a switch in another tab).
  const refusal =
    accountRefusal(actor, c.req.header(ACCOUNT_HEADER) ?? null) ??
    clientOutdated(actor, { method: c.req.method, path: c.req.path, header: name => c.req.header(name) }) ??
    (await workspaceRefusal(actor, requested))
  if (refusal) return c.json(refusal, 403)
  c.set('actor', actor)
  await next()
  // Whether the workspace is disabled, on every answer: an open tab notices a disable or enable at its next request.
  if (actor.workspaceId) {
    const state = actor.workspaceDisabled ? 'disabled' : 'active'
    try {
      c.res.headers.set(WORKSPACE_STATE_HEADER, state)
    } catch {
      // A response passed through as it came (immutable headers): copy it once.
      c.res = new Response(c.res.body, c.res)
      c.res.headers.set(WORKSPACE_STATE_HEADER, state)
    }
  }
})

app.get('/v1/me', async c => {
  const actor = c.get('actor')
  const [workspace] = actor.workspaceId
    ? await db.select().from(organization).where(eq(organization.id, actor.workspaceId))
    : []
  return c.json({
    actorId: actor.actorId,
    role: actor.role,
    permissions: actor.permissions,
    workspace: workspace ? { id: workspace.id, name: workspace.name, disabled: Boolean(workspace.disabledAt) } : null,
    // Every workspace this member belongs to, for the switcher in the profile menu: known at boot, never fetched when it opens.
    workspaces: await workspacesOf(actor.actorId),
    onboarding: workspace ? await onboardingFor(actor) : null,
    phoneSetup: workspace ? await phoneSetupFor(actor) : null,
    impersonation: await impersonationOf(actor),
    // An instance admin whose session lacks the second factor: 'setup' (no passkey yet) or 'confirm'.
    adminSecondFactor: actor.adminSecondFactor ?? null,
    // An instance admin without a passkey: adding the first one asks for their enrolment code (passkey-enrolment.ts).
    passkeyEnrolment: await needsPasskeyEnrolment(actor),
    // The member's address is not confirmed yet: the app asks for a code (sensitive actions wait for it).
    emailUnconfirmed: Boolean(actor.emailUnverified && !actor.impersonation),
    // How this install introduces a new workspace after onboarding (FIRST_USE).
    firstUse: firstUse(),
    // The GitHub star prompt while it is due for this member (star-prompt.ts), else null.
    starPrompt: await starPromptFor(actor),
  })
})

/** Whether this is an instance admin (by account, also before the second factor) without a passkey. */
async function needsPasskeyEnrolment({ actorId, impersonation }: Actor): Promise<boolean> {
  if (impersonation) return false
  const [account] = await db.select().from(user).where(eq(user.id, actorId))
  if (!account || !isInstanceAdmin(account)) return false
  const [any] = await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, actorId)).limit(1)
  return !any
}

/** The workspaces a user is a member of, by name. */
function workspacesOf(userId: string) {
  return db
    .select({ id: organization.id, name: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(asc(organization.name))
}

/** Who is signed in as this user, for the banner while impersonating. */
async function impersonationOf({ actorId, impersonation }: Actor) {
  if (!impersonation) return null
  const person = (id: string) =>
    db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, id))
  const [[by], [as]] = await Promise.all([person(impersonation.by), person(actorId)])
  return by && as ? { by, user: as, expiresAt: impersonation.expiresAt.toISOString() } : null
}

// For the inbox header: can the assistant answer calls at all? Members see whether, never which key is missing.
app.get('/v1/assistant/status', async c => {
  c.header('cache-control', 'no-store')
  return c.json({ voiceReady: await voiceReady(db) })
})

// Which calendar providers this install can connect (their OAuth apps are set in env).
app.get('/v1/calendar/providers', c => c.json({ providers: configuredCalendarProviders(process.env) }))

registerAdminRoutes(app)
registerImpersonationRoutes(app)

app.get('/v1/actions', c =>
  c.json([...actions.values()].map(a => ({ name: a.name, description: a.description, permission: a.permission }))),
)

// A voice recording is the one large input: it is capped before the body is read; every other action at 4 MB (a contact import of 500 rows fits).
app.use(
  '/v1/actions/voice.clone',
  bodyLimit({
    maxSize: CLONE_BODY_MAX_BYTES,
    onError: c => c.json({ ok: false, error: 'the recording is larger than 10 MB' }, 413),
  }),
)
app.use('/v1/actions/:name', async (c, next) =>
  c.req.param('name') === 'voice.clone'
    ? next()
    : bodyLimit({
        maxSize: ACTION_BODY_MAX_BYTES,
        onError: c => c.json({ ok: false, error: 'request body too large' }, 413),
      })(c, next),
)

app.post('/v1/actions/:name', async c => {
  // These change which session the browser holds, so only their own routes run them.
  if (COOKIE_ACTIONS.includes(c.req.param('name')))
    return c.json({ ok: false, error: 'use POST /v1/impersonation/start or /v1/impersonation/stop' }, 400)
  const input = await c.req.json().catch(() => ({}))
  const { status, body } = await runAction(c.req.param('name'), input, c.get('actor'), c.req.header('idempotency-key'))
  return c.json(body, status)
})

app.get('/v1/voices/preview/:voiceId', c =>
  servePreview(c.get('actor'), c.req.param('voiceId'), { providerName: c.req.query('provider') || undefined }),
)

app.get('/v1/calls/:id/recording', c => serveRecording(c.get('actor'), c.req.param('id'), c.req.header('range')))

// Read sync: proxy to Electric. The server picks the table and adds the workspace filter;
// the client only controls the stream position. The browser puts its workspace in the URL too
// (`?workspace=`), so each workspace's shape has its own URL and Electric's client keeps its
// per-URL state (expired handles) apart; it must be the request's workspace.

/** The 4xx Electric answers about the stream position, which its client handles (load the table again). */
const ELECTRIC_CLIENT_STATUSES = [400, 404, 409, 410]

const streamParams = ['offset', 'handle', 'live', 'cursor', 'live_sse', 'experimental_live_sse']
/** Which rows of a table a member's browser receives: their workspace's; webhook URLs (they can carry a token) only for owners and admins. */
function shapeFilter(table: TableName, permissions: readonly string[]) {
  if (table === 'calls') return 'workspace_id = $1 AND deleted_at IS NULL'
  if (table === 'webhook_endpoints' && !permissions.includes('settings:write')) return 'workspace_id = $1 AND false'
  return 'workspace_id = $1'
}

/** Read sync is the browser's: it streams whole tables, settings included (assistants, numbers, calendars, webhooks). */
export const SHAPE_NOT_FOR_API_KEYS =
  'API keys cannot use read sync; use the public API (GET /v1/openapi.json) or the MCP read tools'

app.get('/v1/shape/:table', async c => {
  const table = c.req.param('table') as TableName
  const { workspaceId, apiKeyId, role, permissions } = c.get('actor')
  if (apiKeyId) return c.json({ ok: false, error: SHAPE_NOT_FOR_API_KEYS, code: 'forbidden' }, 403)
  if (!tableNames.includes(table) || !workspaceId) return c.json({ ok: false, error: 'unknown table' }, 404)
  // Read sync is for members and API keys that read calls; never the voice agent, whose tools read nothing.
  if (role === 'agent' || !permissions.includes('call:read')) return c.json({ ok: false, error: 'missing permission call:read' }, 403)
  const refusal = await workspaceRefusal(c.get('actor'), c.req.query('workspace') ?? null)
  if (refusal) return c.json(refusal, 403)
  const target = new URL('/v1/shape', ELECTRIC_URL)
  for (const [k, v] of new URL(c.req.url).searchParams) if (streamParams.includes(k)) target.searchParams.set(k, v)
  target.searchParams.set('table', table)
  target.searchParams.set('replica', 'full')
  target.searchParams.set('where', shapeFilter(table, c.get('actor').permissions))
  target.searchParams.set('params[1]', workspaceId)
  if (ELECTRIC_SECRET) target.searchParams.set('secret', ELECTRIC_SECRET)
  const res = await fetch(target, { signal: c.req.raw.signal })
  // Electric's own 4xx (an unknown handle, an offset out of range, a changed shape) tell the client to
  // load the table again and pass through. Any other 4xx, a 401 or 403 from Electric or a proxy in
  // front of it, is a server fault: the browser must never take it for its own session being gone.
  if (res.status >= 400 && res.status < 500 && !ELECTRIC_CLIENT_STATUSES.includes(res.status)) {
    console.error(`shape ${table}: Electric answered ${res.status}`)
    return c.json({ ok: false, error: 'read sync is unavailable' }, 502)
  }
  const headers = new Headers(res.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  // Electric allows any origin; this API answers its own app only (cookies, no CORS).
  for (const name of [...headers.keys()]) if (name.startsWith('access-control-')) headers.delete(name)
  // Never from the browser's cache: a polled table asks again with the same URL after a write.
  headers.set('cache-control', 'no-store')
  headers.append('vary', 'Cookie, Authorization')
  return new Response(res.body, { status: res.status, headers })
})
