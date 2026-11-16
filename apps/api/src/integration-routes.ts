// The reads an integration (Zapier) needs besides the actions (docs/api.md, Integrations). API keys only: a person
// signed in has the app. Each answers in the workspace of the key.
//   GET /v1/api-key                    the key and its workspace (Zapier's connection test and label)
//   GET /v1/integrations/calls         the newest finished calls, as a subscription gets them (samples, polling)
//   GET /v1/integrations/contacts      contacts with a phone number (Zapier's "Find contact")
import { INTEGRATION_SAMPLE_CALLS_MAX, phoneFromDigits } from '@linedesk/actions'
import { api_keys, contacts, organization } from '@linedesk/db'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { sampleCalls } from './integrations.ts'

type Env = { Variables: { actor: Actor } }

/** Said to a session or the voice agent on these routes. */
export const API_KEYS_ONLY = 'only a workspace API key reads this (Authorization: Bearer ld_…)'

/** The key's actor with a workspace and `call:read`, or the refusal to answer with. */
function keyActor(c: Context<Env>): { apiKeyId: string; workspaceId: string } | Response {
  const actor = c.get('actor')
  if (!actor.apiKeyId || !actor.workspaceId) return c.json({ ok: false, error: API_KEYS_ONLY, code: 'forbidden' }, 403)
  if (!actor.permissions.includes('call:read'))
    return c.json({ ok: false, error: 'missing permission call:read', code: 'forbidden' }, 403)
  return { apiKeyId: actor.apiKeyId, workspaceId: actor.workspaceId }
}

export function registerIntegrationRoutes(app: Hono<Env>) {
  app.get('/v1/api-key', async c => {
    const key = keyActor(c)
    if (key instanceof Response) return key
    const [row] = await db
      .select({
        id: api_keys.id,
        name: api_keys.name,
        prefix: api_keys.prefix,
        role: api_keys.role,
        workspaceName: organization.name,
      })
      .from(api_keys)
      .innerJoin(organization, eq(organization.id, api_keys.workspace_id))
      .where(eq(api_keys.id, key.apiKeyId))
    if (!row) return c.json({ ok: false, error: 'unknown or revoked API key' }, 401)
    return c.json({
      ok: true,
      workspace: { id: key.workspaceId, name: row.workspaceName },
      key: { id: row.id, name: row.name, prefix: row.prefix, role: row.role },
    })
  })

  app.get('/v1/integrations/calls', async c => {
    const key = keyActor(c)
    if (key instanceof Response) return key
    const asked = Number(c.req.query('limit') ?? 3)
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, INTEGRATION_SAMPLE_CALLS_MAX) : 3
    return c.json({ ok: true, calls: await sampleCalls(db, key.workspaceId, limit) })
  })

  app.get('/v1/integrations/contacts', async c => {
    const key = keyActor(c)
    if (key instanceof Response) return key
    const phone = c.req.query('phone')?.trim() ?? ''
    const country = (c.req.query('country') ?? 'US').toUpperCase()
    const parsed = phoneFromDigits(phone, country)
    if (!parsed.ok) return c.json({ ok: false, error: 'phone: a phone number, best in E.164 like +15035550100' }, 422)
    const rows = await db
      .select({
        id: contacts.id,
        name: contacts.name,
        company: contacts.company,
        phone: contacts.phone,
        email: contacts.email,
        address: contacts.address,
        note: contacts.note,
        blocked_at: contacts.blocked_at,
        created_at: contacts.created_at,
      })
      .from(contacts)
      .where(
        and(eq(contacts.workspace_id, key.workspaceId), isNull(contacts.deleted_at), eq(contacts.phone, parsed.e164)),
      )
      .orderBy(desc(contacts.created_at))
      .limit(10)
    return c.json({ ok: true, contacts: rows })
  })
}
