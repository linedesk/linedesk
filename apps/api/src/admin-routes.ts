// Reads for the admin area and for the voice agent. They cross workspaces, so they are plain
// routes with their own permission check instead of read sync.
import type { Permission } from '@linedesk/actions'
import type { Tx } from '@linedesk/db'
import { sql } from 'drizzle-orm'
import type { Context, Hono, Next } from 'hono'
import { adminHealth, adminOverview, noteAgentSeen } from './admin-overview.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { isEnvAdmin } from './instance-admin.ts'
import { livekitStatus } from './livekit-status.ts'
import { providerStatus, voiceProviderConfig } from './provider-settings.ts'
import { SecretsKeyError } from './secrets.ts'

type Env = { Variables: { actor: Actor } }
// biome-ignore lint/suspicious/noExplicitAny: rows of hand-written aggregate queries
type Row = Record<string, any>

const requirePermission = (permission: Permission) => async (c: Context<Env>, next: Next) => {
  if (!c.get('actor').permissions.includes(permission))
    return c.json({ ok: false, error: `missing permission ${permission}` }, 403)
  await next()
}

const rows = async (tx: Tx, query: ReturnType<typeof sql>) => (await tx.execute(query)).rows as Row[]
const minutes = (seconds: number) => Math.round(seconds / 6) / 10

// Timestamps leave as ISO strings. Better Auth's `timestamp` columns hold UTC; ours are `timestamptz`.
const ISO = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`)
const utc = (column: string) => sql`to_char(${sql.raw(column)}, ${ISO})`
const tz = (expression: string) => sql`to_char(${sql.raw(expression)} at time zone 'utc', ${ISO})`

const listWorkspaces = (tx: Tx) =>
  rows(
    tx,
    sql`
  select o.id, o.name, ${utc('o.created_at')} as created_at, ${utc('o.disabled_at')} as disabled_at,
    (select count(*)::int from member m where m.organization_id = o.id) as members,
    coalesce((select json_agg(p.e164 order by p.e164) from phone_numbers p where p.workspace_id = o.id), '[]'::json) as phone_numbers,
    (select count(*)::int from calls c where c.workspace_id = o.id and c.started_at > now() - interval '30 days') as calls_30d,
    (select ${tz('max(c.started_at)')} from calls c where c.workspace_id = o.id) as last_call_at,
    coalesce((select sum(c.duration_sec) from calls c where c.workspace_id = o.id
      and c.started_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'), 0)::int as seconds_this_month
  from organization o order by o.created_at, o.id`,
  )

const listUsers = (tx: Tx) =>
  rows(
    tx,
    sql`
  select u.id, u.name, u.email, u.email_verified, u.instance_admin,
    ${utc('u.created_at')} as created_at, ${utc('u.disabled_at')} as disabled_at,
    ${utc('coalesce(u.last_sign_in_at, (select max(s.created_at) from session s where s.user_id = u.id))')} as last_sign_in_at,
    coalesce((select json_agg(json_build_object('id', o.id, 'name', o.name, 'role', m.role) order by o.name)
      from member m join organization o on o.id = m.organization_id where m.user_id = u.id), '[]'::json) as workspaces
  from "user" u order by u.created_at, u.id`,
  )

const listUsage = (tx: Tx, months: number) =>
  rows(
    tx,
    sql`
  select c.workspace_id, o.name as workspace_name, to_char(c.started_at at time zone 'utc', 'YYYY-MM') as month,
    count(*)::int as calls, coalesce(sum(c.duration_sec), 0)::int as seconds
  from calls c left join organization o on o.id = c.workspace_id
  where c.started_at >= (date_trunc('month', now() at time zone 'utc') - make_interval(months => ${months - 1})) at time zone 'utc'
  group by 1, 2, 3 order by 3 desc, 2, 1`,
  )

export function registerAdminRoutes(app: Hono<Env>) {
  app.use('/v1/admin/*', requirePermission('instance:admin'))

  app.get('/v1/admin/workspaces', async c => {
    const workspaces = (await listWorkspaces(db)).map(({ seconds_this_month, ...w }) => ({
      ...w,
      minutes_this_month: minutes(seconds_this_month),
    }))
    return c.json({ workspaces })
  })

  app.get('/v1/admin/users', async c => {
    const users = (await listUsers(db)).map(({ email_verified, instance_admin, ...u }) => {
      const byEnv = isEnvAdmin({ email: u.email, emailVerified: email_verified })
      return { ...u, instance_admin: instance_admin || byEnv, instance_admin_by_env: byEnv }
    })
    return c.json({ users })
  })

  // Calls and answered minutes per workspace and calendar month (UTC), newest month first.
  app.get('/v1/admin/usage', async c => {
    const months = Math.min(24, Math.max(1, Number(c.req.query('months')) || 6))
    const usage = (await listUsage(db, months)).map(({ seconds, ...u }) => ({ ...u, minutes: minutes(seconds) }))
    return c.json({ months, usage })
  })

  // Numbers for the overview: calls, minutes, estimated provider cost, workspaces and users.
  app.get('/v1/admin/overview', async c => c.json(await adminOverview(db)))
  // Health of the parts of the install; can take a few seconds (LiveKit, SMTP).
  app.get('/v1/admin/health', async c => c.json(await adminHealth()))

  app.get('/v1/admin/providers', async c => c.json(await providerStatus(db)))

  // LiveKit is part of the install (keys in env): read-only status of the server and its SIP service.
  app.get('/v1/admin/system', async c => c.json({ livekit: await livekitStatus() }))

  // For the voice agent: the active speech and LLM providers with their keys, in clear. Agent token only;
  // no member, not even an instance admin. The agent asks at the start of each call.
  app.get('/v1/agent/provider-config', requirePermission('agent'), async c => {
    noteAgentSeen()
    try {
      c.header('cache-control', 'no-store')
      return c.json(await voiceProviderConfig(db))
    } catch (e) {
      if (e instanceof SecretsKeyError) return c.json({ ok: false, error: e.message }, 409)
      throw e
    }
  })
}
