// The reads an integration (Zapier) needs besides the actions (docs/api.md, Integrations). API keys only: a person
// signed in has the app. Each answers in the workspace of the key.
//   GET /v1/api-key                    the key and its workspace (Zapier's connection test and label)
//   GET /v1/integrations/calls         the newest finished calls, as a subscription gets them (samples, polling)
//   GET /v1/integrations/contacts      contacts with a phone number (Zapier's "Find contact")
//   GET /v1/integrations/samples/:event  the newest events of a kind, as a subscription gets them (Zap samples)
//   GET /v1/integrations/options/:kind   ids with what names them, for Zapier's dropdowns (calls, contacts, ...)
import { INTEGRATION_SAMPLE_CALLS_MAX, integrationEvents, type Permission, phoneFromDigits } from '@linedesk/actions'
import { api_keys, appointment_types, assistant_calendars, assistants, bookings, calls, contacts, organization, workspace_members } from '@linedesk/db'
import { and, asc, desc, eq, gte, ilike, isNotNull, isNull, ne, or } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { integrationCallOf, sampleCalls, sampleEvents } from './integrations.ts'

type Env = { Variables: { actor: Actor } }

/** Said to a session or the voice agent on these routes. */
export const API_KEYS_ONLY = 'only a workspace API key reads this (Authorization: Bearer ld_…)'

/** The key's actor with a workspace and `permission` (call:read by default), or the refusal to answer with. */
function keyActor(c: Context<Env>, permission: Permission = 'call:read'): { apiKeyId: string; workspaceId: string } | Response {
  const actor = c.get('actor')
  if (!actor.apiKeyId || !actor.workspaceId) return c.json({ ok: false, error: API_KEYS_ONLY, code: 'forbidden' }, 403)
  for (const needed of new Set<Permission>(['call:read', permission]))
    if (!actor.permissions.includes(needed))
      return c.json({ ok: false, error: `missing permission ${needed}`, code: 'forbidden' }, 403)
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
    const id = c.req.query('id')?.trim()
    // One call by id (Zapier's "Find call"): without a recording link, like the samples.
    if (id) {
      // Phone calls only, like the samples: test calls never reach an integration.
      const [row] = await db
        .select({ id: calls.id })
        .from(calls)
        .where(and(eq(calls.workspace_id, key.workspaceId), eq(calls.id, id.slice(0, 100)), eq(calls.source, 'phone')))
      const call = row ? await integrationCallOf(db, key.workspaceId, row.id) : null
      return c.json({ ok: true, calls: call ? [{ ...call, recording_url: null, recording_expires_at: null }] : [] })
    }
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

  app.get('/v1/integrations/samples/:event', async c => {
    const key = keyActor(c)
    if (key instanceof Response) return key
    const event = integrationEvents.find(e => e === c.req.param('event'))
    if (!event) return c.json({ ok: false, error: `event: one of ${integrationEvents.join(', ')}` }, 404)
    const asked = Number(c.req.query('limit') ?? 3)
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, INTEGRATION_SAMPLE_CALLS_MAX) : 3
    return c.json({ ok: true, items: await sampleEvents(db, key.workspaceId, event, limit) })
  })

  app.get('/v1/integrations/options/:kind', async c => {
    const kind = c.req.param('kind')
    const option = Object.hasOwn(OPTIONS, kind) ? OPTIONS[kind] : undefined
    if (!option) return c.json({ ok: false, error: `kind: one of ${Object.keys(OPTIONS).join(', ')}` }, 404)
    const key = keyActor(c, option.permission)
    if (key instanceof Response) return key
    const q = (c.req.query('q') ?? '').trim().slice(0, 100)
    return c.json({ ok: true, options: await option.list(key.workspaceId, q) })
  })
}

/** `%q%` for ILIKE, with its wildcards taken literally. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`
const OPTIONS_MAX = 100

/** The dropdowns' lists: an id and the plain fields that name it (the integration words the label). */
const OPTIONS: Record<string, { permission: Permission; list: (workspaceId: string, q: string) => Promise<unknown[]> }> = {
  calls: {
    permission: 'call:read',
    list: (workspaceId, q) =>
      db
        .select({ id: calls.id, title: calls.title, from_number: calls.from_number, started_at: calls.started_at, outcome: calls.outcome, source: calls.source })
        .from(calls)
        .where(and(eq(calls.workspace_id, workspaceId), isNull(calls.deleted_at), ne(calls.source, 'test'), q ? or(ilike(calls.title, like(q)), ilike(calls.from_number, like(q))) : undefined))
        .orderBy(desc(calls.started_at))
        .limit(OPTIONS_MAX),
  },
  deleted_calls: {
    permission: 'call:read',
    list: (workspaceId, q) =>
      db
        .select({ id: calls.id, title: calls.title, from_number: calls.from_number, started_at: calls.started_at, outcome: calls.outcome, source: calls.source })
        .from(calls)
        .where(and(eq(calls.workspace_id, workspaceId), ne(calls.source, 'test'), isNotNull(calls.deleted_at), q ? or(ilike(calls.title, like(q)), ilike(calls.from_number, like(q))) : undefined))
        .orderBy(desc(calls.started_at))
        .limit(OPTIONS_MAX),
  },
  contacts: {
    permission: 'call:read',
    list: (workspaceId, q) =>
      db
        .select({ id: contacts.id, name: contacts.name, company: contacts.company, phone: contacts.phone, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.workspace_id, workspaceId), isNull(contacts.deleted_at), q ? or(ilike(contacts.name, like(q)), ilike(contacts.phone, like(q)), ilike(contacts.company, like(q))) : undefined))
        .orderBy(desc(contacts.created_at))
        .limit(OPTIONS_MAX),
  },
  deleted_contacts: {
    permission: 'call:read',
    list: (workspaceId, q) =>
      db
        .select({ id: contacts.id, name: contacts.name, company: contacts.company, phone: contacts.phone, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.workspace_id, workspaceId), isNotNull(contacts.deleted_at), q ? or(ilike(contacts.name, like(q)), ilike(contacts.phone, like(q))) : undefined))
        .orderBy(desc(contacts.deleted_at))
        .limit(OPTIONS_MAX),
  },
  members: {
    permission: 'team:read',
    list: workspaceId =>
      db
        .select({ id: workspace_members.user_id, name: workspace_members.name, role: workspace_members.role })
        .from(workspace_members)
        .where(and(eq(workspace_members.workspace_id, workspaceId), eq(workspace_members.disabled, false)))
        .orderBy(asc(workspace_members.name)),
  },
  assistants: {
    permission: 'call:read',
    list: workspaceId =>
      db.select({ id: assistants.id, name: assistants.name }).from(assistants).where(eq(assistants.workspace_id, workspaceId)).orderBy(asc(assistants.name)),
  },
  appointment_types: {
    permission: 'calendar:read',
    list: workspaceId =>
      db
        .select({ id: appointment_types.id, name: appointment_types.name, duration_min: appointment_types.duration_min })
        .from(appointment_types)
        .where(eq(appointment_types.workspace_id, workspaceId))
        .orderBy(asc(appointment_types.name)),
  },
  calendars: {
    permission: 'calendar:read',
    list: workspaceId =>
      db
        .select({ id: assistant_calendars.id, name: assistant_calendars.name, assistant_name: assistants.name, is_default: assistant_calendars.is_default })
        .from(assistant_calendars)
        .innerJoin(assistants, eq(assistants.id, assistant_calendars.assistant_id))
        .where(and(eq(assistant_calendars.workspace_id, workspaceId), eq(assistant_calendars.enabled, true)))
        .orderBy(asc(assistants.name), asc(assistant_calendars.name)),
  },
  bookings: {
    permission: 'calendar:read',
    list: workspaceId =>
      db
        .select({ id: bookings.id, title: bookings.title, start_at: bookings.start_at, status: bookings.status, calendar_name: bookings.calendar_name })
        .from(bookings)
        .where(and(eq(bookings.workspace_id, workspaceId), ne(bookings.status, 'cancelled'), gte(bookings.end_at, new Date().toISOString())))
        .orderBy(asc(bookings.start_at))
        .limit(OPTIONS_MAX),
  },
}
