import { actions } from '@callfront/actions'
import { assistants, organization, tableNames, type TableName } from '@callfront/db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { auth } from './auth.ts'
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

// Create a workspace (= organization) for the signed-in user, with its assistant, and make it active.
app.post('/v1/workspaces', async c => {
  const { name } = await c.req.json<{ name?: string }>()
  if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 422)
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${crypto.randomUUID().slice(0, 6)}`
  const org = await auth.api.createOrganization({ body: { name: name.trim(), slug }, headers: c.req.raw.headers })
  if (!org) return c.json({ ok: false, error: 'not signed in' }, 401)
  await db.insert(assistants).values({
    id: `as_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`, workspace_id: org.id,
    greeting: `Thanks for calling ${name.trim()}. This is Maya, the AI assistant. How can I help?`,
  })
  await auth.api.setActiveOrganization({ body: { organizationId: org.id }, headers: c.req.raw.headers })
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
