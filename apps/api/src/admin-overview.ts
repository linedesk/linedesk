// The admin overview: how much the install is used, what that roughly costs per provider, and
// whether its parts (API, LiveKit, SIP, voice agent, email) work. Numbers are cheap SQL; health is
// a separate request because LiveKit and SMTP can take seconds to answer.
import { categoryNames, type ProviderCategory, type ProviderName, providerSpec } from '@callfront/actions'
import type { Tx } from '@callfront/db'
import { sql } from 'drizzle-orm'
import { emailSender } from './email.ts'
import { livekitStatus, type ServiceStatus } from './livekit-status.ts'
import { activeProvider } from './provider-settings.ts'

/**
 * List price per call minute in USD, from docs/stack.md ("US cost per call-minute"). Rough on
 * purpose: the overview says "about", the real bill is at each provider.
 */
export const pricePerMinute: Record<ProviderName, number> = {
  telnyx: 0.004,
  twilio: 0.0085,
  deepgram: 0.0077,
  openrouter: 0.003,
  openai: 0.003,
  elevenlabs: 0.018,
  cartesia: 0.018,
  // Recording storage is billed per stored byte, not per call minute: not part of this estimate.
  file: 0,
  s3: 0,
}

export type ProviderCost = {
  category: ProviderCategory
  provider: ProviderName | null
  label: string | null
  minutes7d: number
  cost7d: number
  costMonth: number
}

export type AdminOverview = {
  calls: { today: number; last7d: number; month: number }
  minutes: { today: number; last7d: number; month: number }
  costs: ProviderCost[]
  workspaces: { total: number; disabled: number; new7d: number }
  users: { total: number; disabled: number; new7d: number }
}

const minutes = (seconds: number) => Math.round(seconds / 6) / 10
const dollars = (value: number) => Math.round(value * 100) / 100

// biome-ignore lint/suspicious/noExplicitAny: one row of a hand-written aggregate query
const one = async (tx: Tx, query: ReturnType<typeof sql>) => (await tx.execute(query)).rows[0] as Record<string, any>

/** Calls and seconds since UTC midnight, in the last 7 days and this UTC month; phone calls only for telephony. */
function callTotals(tx: Tx) {
  const today = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`
  const month = sql`date_trunc('month', now() at time zone 'utc') at time zone 'utc'`
  const week = sql`now() - interval '7 days'`
  return one(
    tx,
    sql`
    select
      count(*) filter (where started_at >= ${today})::int as calls_today,
      count(*) filter (where started_at >= ${week})::int as calls_7d,
      count(*) filter (where started_at >= ${month})::int as calls_month,
      coalesce(sum(duration_sec) filter (where started_at >= ${today}), 0)::int as sec_today,
      coalesce(sum(duration_sec) filter (where started_at >= ${week}), 0)::int as sec_7d,
      coalesce(sum(duration_sec) filter (where started_at >= ${month}), 0)::int as sec_month,
      coalesce(sum(duration_sec) filter (where started_at >= ${week} and source = 'phone'), 0)::int as phone_sec_7d,
      coalesce(sum(duration_sec) filter (where started_at >= ${month} and source = 'phone'), 0)::int as phone_sec_month
    from calls where deleted_at is null and started_at >= least(${week}, ${month})`,
  )
}

function people(tx: Tx) {
  return one(
    tx,
    sql`
    select
      (select count(*)::int from organization) as workspaces,
      (select count(*)::int from organization where disabled_at is not null) as workspaces_disabled,
      (select count(*)::int from organization where created_at > now() - interval '7 days') as workspaces_new,
      (select count(*)::int from "user") as users,
      (select count(*)::int from "user" where disabled_at is not null) as users_disabled,
      (select count(*)::int from "user" where created_at > now() - interval '7 days') as users_new`,
  )
}

export async function adminOverview(tx: Tx): Promise<AdminOverview> {
  const [t, p] = await Promise.all([callTotals(tx), people(tx)])
  const costs: ProviderCost[] = []
  for (const category of categoryNames.filter(c => c !== 'recording')) {
    const active = await activeProvider(tx, category).catch(() => null)
    // A carrier only bills phone calls; speech, language model and voice also run in browser test calls.
    const [sec7d, secMonth] = category === 'telephony' ? [t.phone_sec_7d, t.phone_sec_month] : [t.sec_7d, t.sec_month]
    const rate = active ? pricePerMinute[active.provider] : 0
    costs.push({
      category,
      provider: active?.provider ?? null,
      label: active ? providerSpec(active.provider).label : null,
      minutes7d: minutes(sec7d),
      cost7d: dollars((sec7d / 60) * rate),
      costMonth: dollars((secMonth / 60) * rate),
    })
  }
  return {
    calls: { today: t.calls_today, last7d: t.calls_7d, month: t.calls_month },
    minutes: { today: minutes(t.sec_today), last7d: minutes(t.sec_7d), month: minutes(t.sec_month) },
    costs,
    workspaces: { total: p.workspaces, disabled: p.workspaces_disabled, new7d: p.workspaces_new },
    users: { total: p.users, disabled: p.users_disabled, new7d: p.users_new },
  }
}

// The voice agent reads its provider settings every 30 s and at the start of each call
// (GET /v1/agent/provider-config): the last time it did is its heartbeat. Per API process.
let agentSeenAt: number | null = null
export const noteAgentSeen = (nowMs = Date.now()) => {
  agentSeenAt = nowMs
}
/** Twice the agent's re-read interval plus slack. */
const AGENT_STALE_MS = 90_000

export function agentStatus(nowMs = Date.now(), seenAt = agentSeenAt): ServiceStatus {
  if (seenAt === null) return { ok: false, message: 'Not seen since the API started. Is the agent worker running?' }
  const ago = Math.round((nowMs - seenAt) / 1000)
  if (nowMs - seenAt > AGENT_STALE_MS)
    return { ok: false, message: `Last seen ${ago} s ago. Is the agent worker running?` }
  return { ok: true, message: `Checked in ${ago} s ago.` }
}

export type AdminHealth = {
  api: ServiceStatus
  livekit: ServiceStatus
  sip: ServiceStatus
  agent: ServiceStatus
  email: ServiceStatus
}

export async function adminHealth(): Promise<AdminHealth> {
  const [livekit, email] = await Promise.all([livekitStatus(), emailSender.check()])
  return {
    api: { ok: true, message: 'Answering.' },
    livekit: livekit.server,
    sip: livekit.sip,
    agent: agentStatus(),
    email,
  }
}
