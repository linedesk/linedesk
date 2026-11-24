// How agent setup goes (LIN-657, the agent setup counts (no card since LIN-747)): which AI agent people pick when they make a
// setup link, and whether that agent ever connects. Only counts per day, kind of link and agent (agent_setup_counts):
// no person, workspace or key, nothing sent anywhere. A link counts as made when agentSetup.create*Key makes it, and as
// connected once, on its first setup_status call (agent_setup_keys.connected_at), on the day the link was made.
import { type AgentClient, agentClients } from '@linedesk/actions'
import { agent_setup_counts, agent_setup_keys, type Tx } from '@linedesk/db'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { db } from './db.ts'

export type SetupLinkKind = 'install' | 'workspace' | 'partner'
/** One of agentClients, or `none` for a link made without one (an API call). */
export type CountedClient = AgentClient | 'none'

const counted = (client: string | null | undefined): CountedClient =>
  (agentClients as readonly string[]).includes(client ?? '') ? (client as AgentClient) : 'none'

const dayOf = (iso: string) => iso.slice(0, 10)

/** A setup link was made (inside the transaction that makes it). */
export async function countLinkMade(tx: Tx, kind: SetupLinkKind, client: string | null, now: string) {
  await tx
    .insert(agent_setup_counts)
    .values({ day: dayOf(now), kind, client: counted(client), made: 1 })
    .onConflictDoUpdate({
      target: [agent_setup_counts.day, agent_setup_counts.kind, agent_setup_counts.client],
      set: { made: sql`${agent_setup_counts.made} + 1` },
    })
}

/**
 * The agent called setup_status with this key: counted once per key. Never fails the tool: a count that could not be
 * written is only lost.
 */
export async function countLinkConnected(keyId: string | undefined, now = new Date().toISOString()) {
  if (!keyId) return
  try {
    await db.transaction(async tx => {
      const [key] = await tx
        .update(agent_setup_keys)
        .set({ connected_at: now })
        .where(and(eq(agent_setup_keys.id, keyId), isNull(agent_setup_keys.connected_at)))
        .returning({
          created_at: agent_setup_keys.created_at,
          client: agent_setup_keys.client,
          workspace_id: agent_setup_keys.workspace_id,
          partner_id: agent_setup_keys.partner_id,
        })
      if (!key) return
      const kind: SetupLinkKind = key.partner_id ? 'partner' : key.workspace_id ? 'workspace' : 'install'
      // Only a link counted as made (keys from before the counts never are): a day's connected never exceeds its made.
      await tx
        .update(agent_setup_counts)
        .set({ connected: sql`${agent_setup_counts.connected} + 1` })
        .where(
          and(
            eq(agent_setup_counts.day, sql`(${key.created_at}::timestamptz at time zone 'utc')::date`),
            eq(agent_setup_counts.kind, kind),
            eq(agent_setup_counts.client, counted(key.client)),
            lt(agent_setup_counts.connected, agent_setup_counts.made),
          ),
        )
    })
  } catch (e) {
    console.warn('agent setup count not written', e instanceof Error ? e.message : e)
  }
}

export type AgentSetupCountRow = { client: CountedClient; made: number; connected: number }
export type AgentSetupCounts = {
  weeks: number
  kind: SetupLinkKind | 'all'
  rows: AgentSetupCountRow[]
  total: { made: number; connected: number }
}

export const AGENT_SETUP_KINDS = ['all', 'install', 'workspace', 'partner'] as const

/** `kind` of GET /v1/admin/agent-setup-counts: one of AGENT_SETUP_KINDS, else all. */
export function countsKind(value: string | undefined): SetupLinkKind | 'all' {
  return (AGENT_SETUP_KINDS as readonly string[]).includes(value ?? '') ? (value as SetupLinkKind | 'all') : 'all'
}

/**
 * The links made in the last `weeks` weeks (the current one included, weeks start on Monday, UTC, as the funnel) per
 * agent, most made first; agents nobody picked are left out.
 */
export async function adminAgentSetupCounts(
  tx: Tx,
  weeks: number,
  kind: SetupLinkKind | 'all',
  now = new Date().toISOString(),
): Promise<AgentSetupCounts> {
  const { rows } = await tx.execute<{ client: CountedClient; made: number; connected: number }>(sql`
    select client, sum(made)::int as made, sum(connected)::int as connected
    from agent_setup_counts
    where day >= (date_trunc('week', ${now}::timestamptz at time zone 'utc') - make_interval(weeks => ${weeks - 1}))::date
      and (${kind} = 'all' or kind = ${kind})
    group by client
    having sum(made) > 0 or sum(connected) > 0
    order by sum(made) desc, client`)
  const total = rows.reduce((t, r) => ({ made: t.made + r.made, connected: t.connected + r.connected }), {
    made: 0,
    connected: 0,
  })
  return { weeks, kind, rows, total }
}
