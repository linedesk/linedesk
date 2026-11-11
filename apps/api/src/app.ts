import { actions } from '@linedesk/actions'
import { assistants, member, organization, user, workspace_settings, tableNames, type TableName } from '@linedesk/db'
import { APIError } from 'better-auth/api'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { setFirstPassword } from './account.ts'
import { registerAdminRoutes } from './admin-routes.ts'
import { withClientIp } from './client-ip.ts'
import { authMethods } from './auth-methods.ts'
import { auth, WEB_ORIGIN, WORKSPACE_LIMIT } from './auth.ts'
import { calendarCallback } from './calendar-callback.ts'
import { configuredCalendarProviders } from '@linedesk/calendar'
import { resolveActor, type Actor } from './context.ts'
import { db } from './db.ts'
import { COOKIE_ACTIONS } from './impersonation.ts'
import { registerImpersonationRoutes } from './impersonation-routes.ts'
import { previewInvitation } from './invitations.ts'
import { newAssistant, newWorkspaceSettings, onboardingFor, phoneSetupFor } from './onboarding.ts'
import { voiceReady } from './provider-settings.ts'
import { serveRecording } from './recording-route.ts'
import { runAction } from './run-action.ts'

const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://localhost:3001'

export const app = new Hono<{ Variables: { actor: Actor } }>()

app.onError((err, c) => {
  console.error(err)
  return c.json({ ok: false, error: 'internal error' }, 500)
})

app.get('/healthz', c => c.json({ ok: true }))
app.on(['GET', 'POST'], '/api/auth/*', c => auth.handler(withClientIp(c)))

// Public: the sign-in screen asks which methods this install offers.
app.get('/v1/auth-methods', c => c.json(authMethods))

// Public: the invitation link shows whom it is for and which workspace, before sign-in.
app.get('/v1/invitations/:id', async c => c.json(await previewInvitation(c.req.param('id'))))

// Create a workspace (= organization) for the signed-in user, with its assistant, and make it active.
// Better Auth writes the organization on its own connection, so this is not one transaction:
// if the assistant cannot be written the organization is removed again and the call can be repeated.
app.post('/v1/workspaces', async c => {
  const headers = c.req.raw.headers
  if (!(await auth.api.getSession({ headers }))) return c.json({ ok: false, error: 'not signed in' }, 401)
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

// Before the workspace guard: a member without a workspace has an account too.
app.post('/v1/account/password', setFirstPassword)

// The provider sends the browser back here after the consent page. Before the guard: it answers
// with a redirect to the settings page in every case, also when the session is gone.
app.get('/v1/calendar/callback/:provider', async c => c.redirect(await calendarCallback(c.req.param('provider'), new URL(c.req.url).searchParams, c.req.raw.headers, WEB_ORIGIN)))

app.use('/v1/*', async (c, next) => {
  const actor = await resolveActor(c.req.raw.headers)
  if (!actor) return c.json({ ok: false, error: 'not signed in or no workspace' }, 401)
  c.set('actor', actor)
  await next()
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
  })
})

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
  const person = (id: string) => db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, id))
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

app.post('/v1/actions/:name', async c => {
  // These change which session the browser holds, so only their own routes run them.
  if (COOKIE_ACTIONS.includes(c.req.param('name')))
    return c.json({ ok: false, error: 'use POST /v1/impersonation/start or /v1/impersonation/stop' }, 400)
  const input = await c.req.json().catch(() => ({}))
  const { status, body } = await runAction(c.req.param('name'), input, c.get('actor'), c.req.header('idempotency-key'))
  return c.json(body, status)
})

app.get('/v1/calls/:id/recording', c => serveRecording(c.get('actor'), c.req.param('id'), c.req.header('range')))

// Read sync: proxy to Electric. The server picks the table and adds the workspace filter;
// the client only controls the stream position.
/**
 * Shape responses hold one workspace's rows, but the URL is the same for every workspace.
 * Keeps Electric's lifetimes for the browser's own cache and forbids shared caches (proxies, CDNs).
 */
export function privateCacheControl(upstream: string | null) {
  const kept = (upstream ?? '')
    .split(',')
    .map(directive => directive.trim())
    .filter(directive => directive && !/^(public|private|s-maxage)\b/i.test(directive))
  return ['private', ...kept].join(', ')
}

const streamParams = ['offset', 'handle', 'live', 'cursor', 'live_sse', 'experimental_live_sse']
app.get('/v1/shape/:table', async c => {
  const table = c.req.param('table') as TableName
  const { workspaceId } = c.get('actor')
  if (!tableNames.includes(table) || !workspaceId) return c.json({ ok: false, error: 'unknown table' }, 404)
  const target = new URL('/v1/shape', ELECTRIC_URL)
  for (const [k, v] of new URL(c.req.url).searchParams) if (streamParams.includes(k)) target.searchParams.set(k, v)
  target.searchParams.set('table', table)
  target.searchParams.set('replica', 'full')
  target.searchParams.set('where', table === 'calls' ? 'workspace_id = $1 AND deleted_at IS NULL' : 'workspace_id = $1')
  target.searchParams.set('params[1]', workspaceId)
  const res = await fetch(target, { signal: c.req.raw.signal })
  const headers = new Headers(res.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.set('cache-control', privateCacheControl(res.headers.get('cache-control')))
  headers.append('vary', 'Cookie, Authorization')
  return new Response(res.body, { status: res.status, headers })
})
