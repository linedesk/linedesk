// The admin overview: how much the install is used, what that roughly costs per provider, and
// whether its parts (API, LiveKit, SIP, voice agent, email) work. Numbers are cheap SQL; health is
// a separate request because LiveKit and SMTP can take seconds to answer.
import {
  categoryNames,
  type ProviderCategory,
  type ProviderFailure,
  type ProviderName,
  providerSpec,
} from '@linedesk/actions'
import type { Tx } from '@linedesk/db'
import { sql } from 'drizzle-orm'
import { db } from './db.ts'
import { emailSender } from './email.ts'
import { livekitStatus, type ServiceStatus } from './livekit-status.ts'
import { listProviderFailures } from './provider-failures.ts'
import { activeProvider, realtimeInUse } from './provider-settings.ts'

/**
 * List price per call minute in USD, from docs/stack.md ("US cost per call-minute"). Rough on
 * purpose: the overview says "about", the real bill is at each provider.
 */
export const pricePerMinute: Record<ProviderName, number> = {
  telnyx: 0.004,
  twilio: 0.0085,
  deepgram: 0.0077,
  elevenlabs_stt: 0.0067,
  openai_stt: 0.003,
  openrouter: 0.003,
  openai: 0.003,
  anthropic: 0.006,
  gemini: 0.002,
  groq: 0.002,
  mistral: 0.002,
  elevenlabs: 0.018,
  cartesia: 0.018,
  // gpt-realtime (the default), audio in and out with a call's growing context, measured on test calls (2026-11-13):
  // about $0.12 a minute; gpt-realtime-mini about $0.03. In place of the three stages.
  openai_realtime: 0.12,
  // After-call transcription, per minute of the recording (only the selected one runs).
  openai_transcript: 0.0045,
  deepgram_transcript: 0.0043,
  assemblyai: 0.0035,
  elevenlabs_transcript: 0.0067,
  // Recording storage is billed per stored byte, not per call minute: not part of this estimate.
  file: 0,
  s3: 0,
  // Email, sign-in and calendar apps are not billed per call minute either.
  calendly: 0,
  calcom: 0,
  smtp: 0,
  resend: 0,
  postmark: 0,
  sendgrid: 0,
  brevo: 0,
  mailgun: 0,
  gmail: 0,
  google: 0,
  microsoft: 0,
  github: 0,
  oidc: 0,
  // Business lookup is billed per search and listing in onboarding, not per call minute.
  google_places: 0,
  // Billing charges the businesses; Stripe's fees are per charge, not per call minute.
  stripe: 0,
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
  /** Providers failing now: quota used up, key rejected (provider-failures.ts). */
  failures: ProviderFailure[]
}

const minutes = (seconds: number) => Math.round(seconds / 6) / 10
const dollars = (value: number) => Math.round(value * 100) / 100

// biome-ignore lint/suspicious/noExplicitAny: one row of a hand-written aggregate query
const one = async (tx: Tx, query: ReturnType<typeof sql>) => (await tx.execute(query)).rows[0] as Record<string, any>

/** Calls and seconds since UTC midnight, in the last 7 days and this UTC month; phone calls only for telephony. Sample calls are not usage. */
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
    from calls where deleted_at is null and source not in ('sample', 'simulated') and started_at >= least(${week}, ${month})`,
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

type ActiveRate = { category: ProviderCategory; provider: ProviderName | null; rate: number }

/** The active provider of each billed category and its price per minute (0 when none is set up). */
async function activeRates(tx: Tx): Promise<ActiveRate[]> {
  const rates: ActiveRate[] = []
  // Per call minute: the phone, and the realtime model when it answers calls, else the voice stages.
  const skipped = [
    'recording',
    'email',
    'sign_in',
    'business',
    'billing',
    ...((await realtimeInUse(tx)) ? ['stt', 'llm', 'tts'] : ['realtime']),
    // After-call transcription only while an admin has selected a provider (off by default).
    ...((await activeProvider(tx, 'transcript').catch(() => null)) ? [] : ['transcript']),
  ]
  for (const category of categoryNames.filter(c => !skipped.includes(c))) {
    const active = await activeProvider(tx, category).catch(() => null)
    rates.push({ category, provider: active?.provider ?? null, rate: active ? pricePerMinute[active.provider] : 0 })
  }
  return rates
}

/** Estimates call cost in USD from call seconds: the same rates as the overview's "about" figures. */
export type CostEstimate = (seconds: { all: number; phone: number }) => number

/**
 * The estimate with the providers active now: a carrier only bills phone calls; speech, language model and voice
 * also run in browser test calls. Used by the overview, the admin workspace list and the spending cap.
 */
export async function costEstimate(tx: Tx): Promise<CostEstimate> {
  const rates = await activeRates(tx)
  return ({ all, phone }) =>
    dollars(rates.reduce((sum, r) => sum + ((r.category === 'telephony' ? phone : all) / 60) * r.rate, 0))
}

export async function adminOverview(tx: Tx): Promise<AdminOverview> {
  const [t, p, failures] = await Promise.all([callTotals(tx), people(tx), listProviderFailures(tx)])
  const costs: ProviderCost[] = []
  for (const { category, provider, rate } of await activeRates(tx)) {
    const [sec7d, secMonth] = category === 'telephony' ? [t.phone_sec_7d, t.phone_sec_month] : [t.sec_7d, t.sec_month]
    costs.push({
      category,
      provider,
      label: provider ? providerSpec(provider).label : null,
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
    failures,
  }
}

// The voice agent reads its provider settings about every 30 s (a timer in worker.ts) and at the start of each call
// (GET /v1/agent/provider-config): the last time it did is its heartbeat. Per API process.
let agentSeenAt: number | null = null
export const noteAgentSeen = (nowMs = Date.now()) => {
  agentSeenAt = nowMs
}
/** Twice the agent's re-read interval plus slack. */
const AGENT_STALE_MS = 90_000

/** When this API process started: the agent has not had the chance to check in before that. */
const apiStartedAt = Date.now()

/**
 * Whether the voice agent has not checked in lately, so a call now would not be answered. Right after the API
 * starts it has not had the chance yet: not away until it is overdue.
 */
export function agentAway(nowMs = Date.now(), seenAt = agentSeenAt, startedAt = apiStartedAt): boolean {
  return nowMs - (seenAt ?? startedAt) > AGENT_STALE_MS
}

export function agentStatus(nowMs = Date.now(), seenAt = agentSeenAt, startedAt = apiStartedAt): ServiceStatus {
  // Right after the API starts the agent has not had its chance yet (agentAway): not failing until it is overdue.
  if (seenAt === null)
    return agentAway(nowMs, seenAt, startedAt)
      ? { ok: false, message: 'Not seen since the API started. Is the agent worker running?' }
      : { ok: true, message: 'Waiting for its first check-in (every 30 s) since the API started.' }
  const ago = Math.round((nowMs - seenAt) / 1000)
  if (nowMs - seenAt > AGENT_STALE_MS)
    return { ok: false, message: `Last seen ${ago} s ago. Is the agent worker running?` }
  return { ok: true, message: `Checked in ${ago} s ago.` }
}

/** Electric, the read sync behind GET /v1/shape: its own health endpoint (200 active, 202 still starting). */
export async function readSyncStatus(electricUrl = process.env.ELECTRIC_URL ?? 'http://localhost:3001'): Promise<ServiceStatus> {
  try {
    const res = await fetch(new URL('/v1/health', electricUrl), { signal: AbortSignal.timeout(3000) })
    if (res.status === 200) return { ok: true, message: 'Answering.' }
    if (res.status === 202) return { ok: false, message: 'Starting up. Lists in the app load once it is ready.' }
    return { ok: false, message: `Electric answered ${res.status}. Lists in the app don't load until it answers.` }
  } catch {
    return { ok: false, message: "Electric can't be reached. Is its container running? Lists in the app don't load until it is." }
  }
}

export type AdminHealth = {
  /** LiveKit is set in .env (LIVEKIT_URL): call audio is set up, whether or not it answers. */
  livekitConfigured: boolean
  api: ServiceStatus
  readSync: ServiceStatus
  livekit: ServiceStatus
  sip: ServiceStatus
  agent: ServiceStatus
  email: ServiceStatus
}

/**
 * Email as the check found it, unless sending failed since (provider-failures.ts): a login that works says nothing
 * about a sender the service refuses, and a provider with a recorded failure is never shown as working.
 */
async function emailHealth(): Promise<ServiceStatus> {
  const [checked, failures] = await Promise.all([emailSender.check(), listProviderFailures(db).catch(() => [])])
  const failing = failures.find(f => f.category === 'email')
  return checked.ok && failing ? { ok: false, message: failing.message } : checked
}

export async function adminHealth(): Promise<AdminHealth> {
  const [livekit, email, readSync] = await Promise.all([livekitStatus(), emailHealth(), readSyncStatus()])
  return {
    livekitConfigured: !!livekit.url,
    api: { ok: true, message: 'Answering.' },
    readSync,
    livekit: livekit.server,
    sip: livekit.sip,
    agent: agentStatus(),
    email,
  }
}
