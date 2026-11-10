import { actions } from '@callfront/actions'
import { assistants, organization, tableNames, type TableName } from '@callfront/db'
import { APIError } from 'better-auth/api'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { authMethods } from './auth-methods.ts'
import { auth, WORKSPACE_LIMIT } from './auth.ts'
import { resolveActor, type Actor } from './context.ts'
import { db } from './db.ts'
import { runAction } from './run-action.ts'

const ELECTRIC_URL = process.env.ELECTRIC_URL ?? 'http://localhost:3001'

export const app = new Hono<{ Variables: { actor: Actor } }>()

app.onError((err, c) => {
  console.error(err)
  return c.json({ ok: false, error: 'internal error' }, 500)
})

app.get('/healthz', c => c.json({ ok: true }))
app.on(['GET', 'POST'], '/api/auth/*', c => auth.handler(c.req.raw))

// Public: the sign-in screen asks which methods this install offers.
app.get('/v1/auth-methods', c => c.json(authMethods))

// Create a workspace (= organization) for the signed-in user, with its assistant, and make it active.
// Better Auth writes the organization on its own connection, so this is not one transaction:
// if the assistant cannot be written the organization is removed again and the call can be repeated.
app.post('/v1/workspaces', async c => {
  const headers = c.req.raw.headers
  if (!(await auth.api.getSession({ headers }))) return c.json({ ok: false, error: 'not signed in' }, 401)
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }))
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 80) return c.json({ ok: false, error: 'name is required (80 characters at most)' }, 422)
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 6)}`
  // Refused by Better Auth when signed out or at the workspace limit (auth.ts).
  const org = await auth.api.createOrganization({ body: { name, slug }, headers }).catch(err => {
    if (!(err instanceof APIError)) throw err
    const atLimit = err.body?.code === 'YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS'
    return { refused: atLimit ? `You can create up to ${WORKSPACE_LIMIT} workspaces.` : err.message || 'Could not create the workspace', status: err.statusCode }
  })
  if (!org) return c.json({ ok: false, error: 'not signed in' }, 401)
  if ('refused' in org) return c.json({ ok: false, error: org.refused }, org.status === 401 ? 401 : 403)
  try {
    await db.insert(assistants).values({
      id: `as_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`, workspace_id: org.id,
      greeting: `Thanks for calling ${name}. This is Maya, the AI assistant. How can I help?`,
    })
  } catch (err) {
    await db.delete(organization).where(eq(organization.id, org.id))
    throw err
  }
  // Not essential: without an active workspace the member's first one is used (context.ts).
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers }).catch(err => console.error('set active workspace failed', err))
  return c.json({ ok: true, workspace: { id: org.id, name: org.name } })
})

app.use('/v1/*', async (c, next) => {
  const actor = await resolveActor(c.req.raw.headers)
  if (!actor) return c.json({ ok: false, error: 'not signed in or no workspace' }, 401)
  c.set('actor', actor)
  await next()
})

app.get('/v1/me', async c => {
  const actor = c.get('actor')
  const [workspace] = actor.workspaceId ? await db.select().from(organization).where(eq(organization.id, actor.workspaceId)) : []
  return c.json({ actorId: actor.actorId, role: actor.role, permissions: actor.permissions, workspace: workspace ? { id: workspace.id, name: workspace.name } : null })
})

app.get('/v1/actions', c => c.json([...actions.values()].map(a => ({ name: a.name, description: a.description, permission: a.permission }))))

app.post('/v1/actions/:name', async c => {
  const input = await c.req.json().catch(() => ({}))
  const { status, body } = await runAction(c.req.param('name'), input, c.get('actor'), c.req.header('idempotency-key'))
  return c.json(body, status)
})

// Read sync: proxy to Electric. The server picks the table and adds the workspace filter;
// the client only controls the stream position.
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
  return new Response(res.body, { status: res.status, headers })
})
