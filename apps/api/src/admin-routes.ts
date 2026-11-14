// Reads for the admin area and for the voice agent. They cross workspaces, so they are plain
// routes with their own permission check instead of read sync.
import { AUDIT_KINDS, type AuditKind, isAuditCursor, isCalendarDay, listAudit } from './audit.ts'
import { secondFactorRefusal } from './admin-second-factor.ts'
import { avatarUrlOf, type Permission } from '@linedesk/actions'
import type { Tx } from '@linedesk/db'
import { sql } from 'drizzle-orm'
import type { Context, Hono, Next } from 'hono'
import { z } from 'zod'
import { adminHealth, adminOverview, costEstimate, noteAgentSeen } from './admin-overview.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { isEnvAdmin } from './instance-admin.ts'
import { livekitStatus } from './livekit-status.ts'
import { listProviderFailures } from './provider-failures.ts'
import { providerStatus, voiceProviderConfig } from './provider-settings.ts'
import { SecretsKeyError } from './secrets.ts'
import { agentSetupState, setupActor } from './agent-setup.ts'
import { installSetupState } from './install-setup.ts'
import { setupProgress } from './setup-mcp.ts'
import { setupChecklist, storedTests, statusContext } from './setup-checklist.ts'
import { LATENCY_DAYS_DEFAULT, LATENCY_DAYS_MAX, replyLatency } from './reply-latency.ts'
import { AT_RISK_MAX_DAYS, atRiskWorkspaces, workspacesOldEnough } from './setup-emails.ts'

type Env = { Variables: { actor: Actor } }
// biome-ignore lint/suspicious/noExplicitAny: rows of hand-written aggregate queries
type Row = Record<string, any>

const requirePermission = (permission: Permission) => async (c: Context<Env>, next: Next) => {
  const refusal = secondFactorRefusal(c.get('actor'), permission)
  if (refusal) return c.json(refusal, 403)
  if (!c.get('actor').permissions.includes(permission))
    return c.json({ ok: false, error: `missing permission ${permission}` }, 403)
  await next()
}

/** `days` of GET /v1/admin/onboarding: whole days, clamped to 0 … AT_RISK_MAX_DAYS; anything else is the default. */
const setupDays = z.coerce.number().int()

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
  select o.id, o.name, ${utc('o.created_at')} as created_at, ${utc('o.disabled_at')} as disabled_at, o.spending_cap_cents,
    (select count(*)::int from member m where m.organization_id = o.id) as members,
    (select count(*)::int from member m join "user" u on u.id = m.user_id where m.organization_id = o.id
      and not u.instance_admin and not exists (select 1 from member other where other.user_id = m.user_id
      and other.organization_id <> o.id)) as members_only_here,
    (select count(*)::int from calls c where c.workspace_id = o.id) as calls_total,
    (select count(*)::int from contacts ct where ct.workspace_id = o.id) as contacts,
    coalesce((select json_agg(p.e164 order by p.e164) from phone_numbers p where p.workspace_id = o.id), '[]'::json) as phone_numbers,
    (select count(*)::int from calls c where c.workspace_id = o.id and c.source not in ('sample', 'simulated') and c.started_at > now() - interval '30 days') as calls_30d,
    (select ${tz('max(c.started_at)')} from calls c where c.workspace_id = o.id and c.source not in ('sample', 'simulated')) as last_call_at,
    coalesce((select sum(c.duration_sec) from calls c where c.workspace_id = o.id and c.source not in ('sample', 'simulated')
      and c.started_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'), 0)::int as seconds_this_month,
    coalesce((select sum(c.duration_sec) from calls c where c.workspace_id = o.id and c.source = 'phone'
      and c.started_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'), 0)::int as phone_seconds_this_month
  from organization o order by o.created_at, o.id`,
  )

const listUsers = (tx: Tx) =>
  rows(
    tx,
    sql`
  select u.id, u.name, u.email, u.email_verified, u.instance_admin,
    (select a.version from user_avatars a where a.user_id = u.id) as avatar_version,
    ${utc('u.created_at')} as created_at, ${utc('u.disabled_at')} as disabled_at,
    ${utc('coalesce(u.last_sign_in_at, (select max(s.created_at) from session s where s.user_id = u.id))')} as last_sign_in_at,
    coalesce((select json_agg(json_build_object('id', o.id, 'name', o.name, 'role', m.role, 'member_id', m.id) order by o.name)
      from member m join organization o on o.id = m.organization_id where m.user_id = u.id), '[]'::json) as workspaces,
    coalesce((select json_agg(json_build_object('id', i.id, 'workspace_id', o.id, 'workspace_name', o.name, 'role', coalesce(i.role, 'member'),
        'expires_at', ${utc('i.expires_at')}) order by i.created_at)
      from invitation i join organization o on o.id = i.organization_id
      where i.status = 'pending' and lower(i.email) = lower(u.email)), '[]'::json) as invitations,
    coalesce((select json_agg(json_build_object('name', p.name, 'device_type', p.device_type, 'created_at', ${utc('p.created_at')})
        order by p.created_at)
      from passkey p where p.user_id = u.id), '[]'::json) as passkeys
  from "user" u order by u.created_at, u.id`,
  )

/** A workspace's members and pending invitations, for its admin detail page. */
const listWorkspaceMembers = async (tx: Tx, workspaceId: string) => ({
  members: await rows(
    tx,
    sql`
  select m.id as member_id, u.id as user_id, u.name, u.email, m.role, ${utc('m.created_at')} as joined_at,
    (select a.version from user_avatars a where a.user_id = u.id) as avatar_version
  from member m join "user" u on u.id = m.user_id where m.organization_id = ${workspaceId}
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.name, u.email`,
  ),
  invitations: await rows(
    tx,
    sql`
  select i.id, i.email, coalesce(i.role, 'member') as role, inv.name as invited_by, ${utc('i.expires_at')} as expires_at,
    i.expires_at < now() at time zone 'utc' as expired
  from invitation i join "user" inv on inv.id = i.inviter_id
  where i.organization_id = ${workspaceId} and i.status = 'pending' order by i.created_at`,
  ),
})

const listUsage = (tx: Tx, months: number) =>
  rows(
    tx,
    sql`
  select c.workspace_id, o.name as workspace_name, to_char(c.started_at at time zone 'utc', 'YYYY-MM') as month,
    count(*)::int as calls, coalesce(sum(c.duration_sec), 0)::int as seconds
  from calls c left join organization o on o.id = c.workspace_id
  where c.source not in ('sample', 'simulated')
    and c.started_at >= (date_trunc('month', now() at time zone 'utc') - make_interval(months => ${months - 1})) at time zone 'utc'
  group by 1, 2, 3 order by 3 desc, 2, 1`,
  )

export function registerAdminRoutes(app: Hono<Env>) {
  app.use('/v1/admin/*', requirePermission('instance:admin'))

  app.get('/v1/admin/workspaces', async c => {
    const estimate = await costEstimate(db)
    const workspaces = (await listWorkspaces(db)).map(
      ({ seconds_this_month, phone_seconds_this_month, spending_cap_cents, ...w }) => ({
        ...w,
        minutes_this_month: minutes(seconds_this_month),
        // The spending cap's measure (spending-cap.ts): the estimated cost of this UTC month's calls.
        cost_this_month: estimate({ all: seconds_this_month, phone: phone_seconds_this_month }),
        spending_cap_usd: spending_cap_cents === null ? null : spending_cap_cents / 100,
      }),
    )
    return c.json({ workspaces })
  })

  app.get('/v1/admin/users', async c => {
    const users = (await listUsers(db)).map(({ email_verified, instance_admin, avatar_version, ...u }) => {
      const byEnv = isEnvAdmin({ email: u.email, emailVerified: email_verified })
      return {
        ...u,
        avatar_url: avatarUrlOf(u.id, avatar_version),
        instance_admin: instance_admin || byEnv,
        instance_admin_by_env: byEnv,
      }
    })
    return c.json({ users })
  })

  app.get('/v1/admin/workspaces/:id/members', async c => {
    const { members, invitations } = await listWorkspaceMembers(db, c.req.param('id'))
    return c.json({
      members: members.map(({ avatar_version, ...m }) => ({
        ...m,
        avatar_url: avatarUrlOf(m.user_id, avatar_version),
      })),
      invitations,
    })
  })

  // Calls and answered minutes per workspace and calendar month (UTC), newest month first.
  app.get('/v1/admin/usage', async c => {
    const months = Math.min(24, Math.max(1, Number(c.req.query('months')) || 6))
    const usage = (await listUsage(db, months)).map(({ seconds, ...u }) => ({ ...u, minutes: minutes(seconds) }))
    return c.json({ months, usage })
  })

  // The audit log: newest first, filtered by kind, person, workspace and dates; `before` pages on.
  app.get('/v1/admin/audit', async c => {
    const q = (name: string) => c.req.query(name)?.trim() || undefined
    const kind = q('kind')
    if (kind && !(AUDIT_KINDS as readonly string[]).includes(kind))
      return c.json({ ok: false, error: `unknown kind ${kind}` }, 400)
    const from = q('from')
    const to = q('to')
    for (const [name, value] of [
      ['from', from],
      ['to', to],
    ] as const)
      if (value !== undefined && !isCalendarDay(value))
        return c.json({ ok: false, error: `${name} must be a date like 2026-11-30` }, 400)
    const cursor = q('before')
    if (cursor !== undefined && !isAuditCursor(cursor)) return c.json({ ok: false, error: 'bad cursor' }, 400)
    return c.json(
      await listAudit(db, {
        kind: kind as AuditKind | undefined,
        who: q('who'),
        workspaceId: q('workspace'),
        from,
        to,
        before: cursor,
        limit: Number(q('limit')) || undefined,
      }),
    )
  })

  // Numbers for the overview: calls, minutes, estimated provider cost, workspaces and users.
  app.get('/v1/admin/overview', async c => c.json(await adminOverview(db)))
  // Reply delay per pipeline, split by where the time goes, over the last `days` (default 7, at most 90).
  app.get('/v1/admin/latency', async c => {
    const days = Math.min(LATENCY_DAYS_MAX, Math.max(1, Number(c.req.query('days')) || LATENCY_DAYS_DEFAULT))
    return c.json(await replyLatency(db, days))
  })
  // Workspaces that signed up more than `days` days ago (default 1) and no real call has reached yet: where each stopped.
  // `oldEnough`: how many workspaces signed up in that window at all, so an empty list on a new install says so.
  app.get('/v1/admin/onboarding', async c => {
    const parsed = setupDays.safeParse(c.req.query('days'))
    const days = parsed.success ? Math.min(AT_RISK_MAX_DAYS, Math.max(0, parsed.data)) : 1
    const now = new Date().toISOString()
    const [workspaces, oldEnough] = await Promise.all([
      atRiskWorkspaces(db, days, now),
      workspacesOldEnough(db, days, now),
    ])
    return c.json({ days, oldEnough, workspaces })
  })
  // Health of the parts of the install; can take a few seconds (LiveKit, SMTP).
  app.get('/v1/admin/health', async c => c.json(await adminHealth()))

  // The providers, which are in use, which are failing now (provider-failures.ts) and the last test of each one's keys
  // in effect (setup-checklist.ts): every screen starts from the stored result instead of testing again.
  app.get('/v1/admin/providers', async c =>
    c.json({
      ...(await providerStatus(db)),
      failures: await listProviderFailures(db),
      tests: await storedTests(db),
      status: await statusContext(db),
    }),
  )

  // Agent setup (agent-setup.ts): the admin's working setup key (never the key) and where agents connect.
  app.get('/v1/admin/agent-setup', async c => {
    const actor = c.get('actor')
    // ?part=key: the key alone, without the progress (which checks every provider group): the Allow dialog opens on it.
    if (c.req.query('part') === 'key') return c.json(await agentSetupState(actor.actorId))
    // The progress of the workspace the agent works in (the admin's first own business), not the session's one.
    const asAgent = (await setupActor(actor.actorId, 'page')) ?? actor
    return c.json({ ...(await agentSetupState(actor.actorId)), progress: await setupProgress(asAgent) })
  })

  // Install setup by hand (install-setup.ts): where the walkthrough is, and whether a saved change waits for a restart.
  app.get('/v1/admin/install-setup', async c => c.json(await installSetupState(c.get('actor'))))

  // Every provider group's status (setup-checklist.ts, statusGroups), read-only: tests run through provider.test.
  app.get('/v1/admin/setup-checklist', async c => c.json(await setupChecklist(db)))

  // LiveKit is part of the install (keys in env): read-only status of the server and its SIP service.
  app.get('/v1/admin/system', async c => c.json({ livekit: await livekitStatus() }))

  // For the voice agent: the active speech and LLM providers with their keys, in clear. The install-wide
  // agent token only: no member, not even an instance admin, and no call token (a leaked one must not
  // read the install's keys). The agent asks at the start of each call.
  app.get('/v1/agent/provider-config', requirePermission('agent'), async c => {
    if (c.get('actor').callId) return c.json({ ok: false, error: 'a call token cannot read the provider config' }, 403)
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
