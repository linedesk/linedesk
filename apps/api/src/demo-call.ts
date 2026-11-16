// Public demo calls: a visitor of the install's own website talks to one of its demo assistants in the browser, with
// no account, for at most DEMO_CALL_MAX_SECONDS. Off unless DEMO_CALLS=on: then POST /v1/demo/call answers, else 404,
// so an install that never set it up exposes nothing.
//
// The browser never calls this route. The website's own server (the "gateway": a serverless function next to the
// site) checks the visitor (a bot check, the country, its own per-address limit), hashes the visitor's address with a
// pepper only it knows, and asks here with `Authorization: Bearer <DEMO_GATEWAY_SECRET>` and
// `{ industry, ipHash, country?, language? }`. This route answers with a LiveKit token for one new room `demo-…` that
// may publish the microphone only and dispatches the voice agent with `{ source: 'test', demo: true, workspaceId,
// assistantId }`, plus `mainLanguage` when the visitor picked a language other than English (DEMO_LANGUAGES): the
// call then speaks only that language. The gateway passes the answer on to the browser. The LiveKit key never leaves
// the API: any key can sign any grant.
// docs/runbook.md ("Put a live demo on your website") has the whole contract and a minimal gateway.
//
// Every limit is counted in Postgres under one advisory lock, from the command-log rows of the tokens issued
// (DEMO_CALL_TOKEN) and the live demo calls, so several API processes and a burst of requests see the same counts:
// per visitor (ipHash) an hour and a day, calls at once on the install, a daily budget in USD at the worst-case cost
// of a full-length call and a hard count per day, the demo workspace's own monthly spending cap, and whether the voice
// agent would answer. Each request also checks the demo workspace (DEMO_WORKSPACE_ID) is still set up the safe way the
// setup script left it: no phone number, calendar or webhook, the assistant not recording and putting nobody through.
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  businessOfGreeting,
  DEMO_CALL_MAX_SECONDS,
  DEMO_LANGUAGES,
  type DemoLanguage,
  isDemoLanguage,
  LANGUAGES,
  voiceSpeaks,
} from '@linedesk/actions'
import {
  assistants,
  calendar_connections,
  calls,
  commands,
  organization,
  phone_numbers,
  type Tx,
  webhook_endpoints,
} from '@linedesk/db'
import { and, eq, gt, like, sql } from 'drizzle-orm'
import type { Env as HonoEnv, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { type CostEstimate, costEstimate } from './admin-overview.ts'
import { addressBucket, clientIpOf } from './client-ip.ts'
import { db } from './db.ts'
import { DEMO_CALL_TOKEN, DEMO_ROOM_MAX_MS, DEMO_ROOM_PREFIX } from './demo-rooms.ts'
import { spendingCap } from './spending-cap.ts'
import { browserRoomToken, TOKEN_TTL_SEC, type TestCallMetadata, voiceAgentProblem } from './test-call.ts'
import { assistantVoiceOf } from './usage-levels.ts'

type Env = Record<string, string | undefined>

// The command-log entry of each demo token issued: every limit below counts these.
export { DEMO_CALL_TOKEN }
/** The command log's actor for demo tokens: nobody signed in asked for them. */
export const DEMO_ACTOR = 'public-demo'
/** A shorter gateway secret is not taken: it must not be guessable. */
export const DEMO_SECRET_MIN_LENGTH = 32

/** Defaults of the limits; each has its env variable (docs/runbook.md). */
export const DEMO_DEFAULTS = { maxConcurrent: 3, perIpHour: 3, perIpDay: 6, dailyCalls: 300 } as const
/**
 * What the daily budget counts per token: a call that runs to the stale-call sweep's backstop (DEMO_ROOM_MAX_MS plus
 * one sweep: the agent's own goodbye at DEMO_CALL_MAX_SECONDS may not come), at the install's rates, plus the
 * after-call summary (one language-model request), which the per-minute rates leave out.
 */
export const DEMO_BUDGET_SECONDS = DEMO_ROOM_MAX_MS / 1000 + 60
export const DEMO_SUMMARY_USD = 0.01
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Seconds the website waits before trying again when every demo line is busy. */
const BUSY_RETRY_SEC = 30
/** The same when the voice agent has not checked in lately: it may be restarting. */
const AGENT_AWAY_RETRY_SEC = 60

export type DemoConfig = {
  secret: string
  /** The workspace the demo assistants live in (DEMO_WORKSPACE_ID); null: not set, so demo calls are off. */
  workspaceId: string | null
  /** Industry (the website's value, like `home-services`) to assistant id. */
  assistants: Map<string, string>
  /** null: DEMO_DAILY_USD is not set, so demo calls are off (there is no budget in code). */
  dailyUsd: number | null
  maxConcurrent: number
  perIpHour: number
  perIpDay: number
  /** Tokens per UTC day on the install, whatever the rates say (DEMO_DAILY_CALLS). */
  dailyCalls: number
}

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw?.trim())
  return raw?.trim() && Number.isInteger(n) && n > 0 ? n : fallback
}

/** `home-services=asst_1,auto=asst_2`: industry to assistant id. Entries that are not `slug=id` are left out. */
export function parseDemoAssistants(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of (raw ?? '').split(',')) {
    const [industry, id, ...rest] = entry.split('=').map(part => part.trim())
    if (rest.length || !industry || !id || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(industry)) continue
    map.set(industry, id)
  }
  return map
}

/** The demo settings from env; null when demo calls are off (DEMO_CALLS is not `on`, or there is no usable secret). */
export function demoConfig(env: Env = process.env): DemoConfig | null {
  if (env.DEMO_CALLS?.trim() !== 'on') return null
  const secret = env.DEMO_GATEWAY_SECRET?.trim() ?? ''
  if (secret.length < DEMO_SECRET_MIN_LENGTH) {
    warnOnce(
      'secret',
      `DEMO_CALLS is on, but DEMO_GATEWAY_SECRET is missing or shorter than ${DEMO_SECRET_MIN_LENGTH} characters: public demo calls stay off`,
    )
    return null
  }
  const daily = Number(env.DEMO_DAILY_USD?.trim())
  return {
    secret,
    workspaceId: env.DEMO_WORKSPACE_ID?.trim() || null,
    assistants: parseDemoAssistants(env.DEMO_ASSISTANTS),
    dailyUsd: env.DEMO_DAILY_USD?.trim() && Number.isFinite(daily) && daily >= 0 ? daily : null,
    maxConcurrent: positiveInt(env.DEMO_MAX_CONCURRENT, DEMO_DEFAULTS.maxConcurrent),
    perIpHour: positiveInt(env.DEMO_CALLS_PER_IP_HOUR, DEMO_DEFAULTS.perIpHour),
    perIpDay: positiveInt(env.DEMO_CALLS_PER_IP_DAY, DEMO_DEFAULTS.perIpDay),
    dailyCalls: positiveInt(env.DEMO_DAILY_CALLS, DEMO_DEFAULTS.dailyCalls),
  }
}

const warned = new Map<string, number>()
/** One log line per reason every 10 minutes at most, so a misconfigured or busy install does not flood the log. */
function warnOnce(reason: string, line: string, nowMs = Date.now()) {
  if (nowMs - (warned.get(reason) ?? -Infinity) < 10 * 60_000) return
  warned.set(reason, nowMs)
  console.error(line)
}
/** For tests: every reason may be logged again. */
export const resetDemoWarnings = () => warned.clear()

/** Whether the Authorization header carries the gateway secret; constant time, whatever the lengths. */
export function isGatewaySecret(header: string | undefined, secret: string): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim() ?? ''
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(given), digest(secret)) && given.length > 0
}

/** Wrong secrets one address may send in WRONG_SECRET_WINDOW_MS before it is answered 429. */
export const WRONG_SECRET_LIMIT = 20
const WRONG_SECRET_WINDOW_MS = 10 * 60_000
const wrongSecrets = new Map<string, { since: number; n: number }>()
/** For tests: every address starts over. */
export const resetWrongSecrets = () => wrongSecrets.clear()

/**
 * Counts a wrong secret from `bucket`; true when the address is over WRONG_SECRET_LIMIT in the window. Only wrong
 * secrets count and a right one is never held back, so someone sharing the gateway's address (its platform's egress)
 * cannot lock the gateway out.
 */
function tooManyWrongSecrets(bucket: string, nowMs: number): boolean {
  let entry = wrongSecrets.get(bucket)
  if (!entry || nowMs - entry.since > WRONG_SECRET_WINDOW_MS) entry = { since: nowMs, n: 0 }
  entry.n++
  wrongSecrets.set(bucket, entry)
  if (wrongSecrets.size > 10_000)
    for (const [key, e] of wrongSecrets) if (nowMs - e.since > WRONG_SECRET_WINDOW_MS) wrongSecrets.delete(key)
  if (entry.n <= WRONG_SECRET_LIMIT) return false
  warnOnce(
    'wrong-secret',
    `ALERT demo calls: more than ${WRONG_SECRET_LIMIT} wrong gateway secrets from ${bucket} in 10 minutes`,
    nowMs,
  )
  return true
}

/**
 * What the gateway sends. `ipHash`: its peppered hash of the visitor's address (never the address). `language`: the
 * one the visitor picked (DEMO_LANGUAGES); missing: English.
 */
export const demoCallInput = z.object({
  industry: z.string().trim().min(1).max(40),
  ipHash: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'a hex or base64url hash'),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  language: z.enum(DEMO_LANGUAGES).default('en'),
})
export type DemoCallInput = z.infer<typeof demoCallInput>

/** Whether the body names a language that is not one of DEMO_LANGUAGES (a missing one is English). */
const unknownLanguage = (body: unknown) =>
  !!body && typeof body === 'object' && 'language' in body && !isDemoLanguage(body.language)

/** `retryAfterSec`: when trying again may work; null when it will not today (or it cannot be said). */
export type DemoCallAnswer =
  | {
      status: 200
      body: {
        ok: true
        url: string
        token: string
        room: string
        maxSeconds: number
        business: string
        assistant: string
      }
    }
  | { status: 400; body: { ok: false; error: 'industry' | 'input' | 'language' } }
  | { status: 401; body: { ok: false; error: 'unauthorized' } }
  | { status: 404; body: { ok: false; error: 'not found' } }
  | { status: 415; body: { ok: false; error: 'json' } }
  | { status: 429; body: { ok: false; error: 'rate'; retryAfterSec: number } }
  | { status: 429; body: { ok: false; error: 'unauthorized'; retryAfterSec: number } }
  | { status: 503; body: { ok: false; error: 'busy' | 'budget' | 'off'; retryAfterSec: number | null } }

const refused = (error: 'busy' | 'budget' | 'off', retryAfterSec: number | null): DemoCallAnswer => ({
  status: 503,
  body: { ok: false, error, retryAfterSec },
})

/** Seconds from `nowMs` to the next UTC midnight / the first of next UTC month. */
const secondsToNextDay = (nowMs: number) => Math.ceil((Math.floor(nowMs / DAY_MS + 1) * DAY_MS - nowMs) / 1000)
function secondsToNextMonth(nowMs: number) {
  const now = new Date(nowMs)
  return Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - nowMs) / 1000)
}
const utcMidnight = (nowMs: number) => Math.floor(nowMs / DAY_MS) * DAY_MS
const iso = (ms: number) => new Date(ms).toISOString()

/** Demo tokens issued since `sinceMs`, with the oldest one's time; for one visitor when `ipHash` is given. */
async function tokensSince(tx: Tx, sinceMs: number, ipHash?: string) {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${commands.created_at})` })
    .from(commands)
    .where(
      and(
        eq(commands.action, DEMO_CALL_TOKEN),
        gt(commands.created_at, iso(sinceMs)),
        ipHash ? sql`${commands.input} @> ${JSON.stringify({ ipHash })}::jsonb` : undefined,
      ),
    )
  return { n: row?.n ?? 0, oldestMs: row?.oldest ? Date.parse(row.oldest) : null }
}

/**
 * Demo calls going on now: the live calls in demo rooms, plus the tokens of the last TOKEN_TTL_SEC whose room has no
 * call yet (the browser is still joining, or the agent is still picking up).
 */
async function demoCallsNow(tx: Tx, nowMs: number) {
  const [live] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(calls)
    .where(and(eq(calls.status, 'live'), eq(calls.source, 'test'), like(calls.room, `${DEMO_ROOM_PREFIX}%`)))
  const [joining] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(commands)
    .where(
      and(
        eq(commands.action, DEMO_CALL_TOKEN),
        gt(commands.created_at, iso(nowMs - TOKEN_TTL_SEC * 1000)),
        sql`not exists (select 1 from ${calls} where ${calls.workspace_id} = ${commands.workspace_id} and ${calls.room} = ${commands.result} -> 'data' ->> 'room')`,
      ),
    )
  return (live?.n ?? 0) + (joining?.n ?? 0)
}

/** Until the oldest counted token leaves the window. */
const retryAfter = (oldestMs: number | null, windowMs: number, nowMs: number) =>
  Math.max(1, Math.ceil(((oldestMs ?? nowMs) + windowMs - nowMs) / 1000))

type DemoAssistant = { id: string; workspaceId: string; name: string; business: string }

/**
 * The assistant DEMO_ASSISTANTS names for the industry, in an enabled workspace, able to speak `language`; null (and an
 * ALERT line) when it is not there or its voice can't speak the language.
 */
async function demoAssistant(
  tx: Tx,
  industry: string,
  id: string,
  workspaceId: string,
  language: DemoLanguage,
  nowMs: number,
): Promise<DemoAssistant | null> {
  const [row] = await tx
    .select({
      id: assistants.id,
      workspaceId: assistants.workspace_id,
      name: assistants.name,
      greeting: assistants.greeting,
      voice: assistants.voice,
      llmModel: assistants.llm_model,
      voicePipeline: assistants.voice_pipeline,
      recordCalls: assistants.record_calls,
      transfers: assistants.transfers,
      transferNumber: assistants.transfer_number,
      transferUrgent: assistants.transfer_urgent,
      workspace: organization.name,
      disabledAt: organization.disabledAt,
    })
    .from(assistants)
    .innerJoin(organization, eq(organization.id, assistants.workspace_id))
    .where(eq(assistants.id, id))
  if (!row || row.disabledAt) {
    warnOnce(
      `assistant:${industry}`,
      `ALERT demo calls: DEMO_ASSISTANTS names ${id} for ${industry}, which is ${row ? 'in a disabled workspace' : 'no assistant of this install'}`,
    )
    return null
  }
  if (row.workspaceId !== workspaceId) {
    warnOnce(
      `assistant:${industry}`,
      `ALERT demo calls: DEMO_ASSISTANTS names ${id} for ${industry}, which is not in DEMO_WORKSPACE_ID`,
      nowMs,
    )
    return null
  }
  const unsafe = [
    row.recordCalls && 'records its calls',
    (row.transfers.length > 0 || row.transferNumber || row.transferUrgent) && 'puts callers through to someone',
  ].filter(Boolean)
  if (unsafe.length) {
    warnOnce(
      `unsafe:${id}`,
      `ALERT demo calls: the demo assistant ${id} (${industry}) ${unsafe.join(' and ')}, so its demo calls are refused`,
      nowMs,
    )
    return null
  }
  if (language !== 'en') {
    // The voice the call speaks with (none: a realtime model, which speaks every demo language) must speak it.
    const voice = await assistantVoiceOf(tx, {
      voice: row.voice,
      llm_model: row.llmModel,
      voice_pipeline: row.voicePipeline,
    })
    if (voice && !voiceSpeaks(voice, language)) {
      warnOnce(
        `language:${id}:${language}`,
        `ALERT demo calls: the voice of the demo assistant ${id} (${industry}, ${voice.model || voice.provider}) can't speak ${LANGUAGES[language]}, so demo calls in it are refused`,
        nowMs,
      )
      return null
    }
  }
  // The business the demo assistant answers for, as its greeting names it (the demo-workspace script writes the
  // default greeting); else the workspace's name.
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    business: businessOfGreeting(row.greeting) ?? row.workspace,
  }
}

/**
 * What the demo workspace has that anonymous visitors must not reach, or none: a phone number (real callers, an
 * outbound caller ID), a calendar (real bookings, confirmation emails to any address) or a webhook (what visitors say,
 * sent out; lookups during the call). The setup script makes none; someone may add one later.
 */
async function unsafeWorkspace(tx: Tx, workspaceId: string): Promise<string[]> {
  const { rows } = await tx.execute<{ numbers: boolean; calendars: boolean; webhooks: boolean }>(sql`select
      exists (select 1 from ${phone_numbers} where ${phone_numbers.workspace_id} = ${workspaceId}) as numbers,
      exists (select 1 from ${calendar_connections} where ${calendar_connections.workspace_id} = ${workspaceId}) as calendars,
      exists (select 1 from ${webhook_endpoints} where ${webhook_endpoints.workspace_id} = ${workspaceId}
        and ${webhook_endpoints.status} = 'active') as webhooks`)
  const row = rows[0]
  return [
    row?.numbers && 'a phone number',
    row?.calendars && 'a calendar connection',
    row?.webhooks && 'a webhook',
  ].filter((x): x is string => !!x)
}

/**
 * Why no demo token may be issued now, or null. In the caller's transaction, under the lock. Per visitor first (a
 * visitor over their limit is told so even when the install is busy), then the install's own limits.
 */
async function demoRefusal(
  tx: Tx,
  config: DemoConfig,
  input: DemoCallInput,
  assistant: DemoAssistant,
  nowMs: number,
  estimate: (tx: Tx) => Promise<CostEstimate>,
): Promise<DemoCallAnswer | null> {
  const hour = await tokensSince(tx, nowMs - HOUR_MS, input.ipHash)
  if (hour.n >= config.perIpHour)
    return { status: 429, body: { ok: false, error: 'rate', retryAfterSec: retryAfter(hour.oldestMs, HOUR_MS, nowMs) } }
  const day = await tokensSince(tx, nowMs - DAY_MS, input.ipHash)
  if (day.n >= config.perIpDay)
    return { status: 429, body: { ok: false, error: 'rate', retryAfterSec: retryAfter(day.oldestMs, DAY_MS, nowMs) } }

  // The daily limits: a count, and the budget with every token at the worst case (Server admin › Overview's rates).
  const today = await tokensSince(tx, utcMidnight(nowMs))
  if (today.n >= config.dailyCalls) {
    warnOnce(
      'daily-calls',
      `ALERT demo calls: the ${config.dailyCalls} demo calls of today (DEMO_DAILY_CALLS) are used up`,
      nowMs,
    )
    return refused('budget', secondsToNextDay(nowMs))
  }
  const callUsd = (await estimate(tx))({ all: DEMO_BUDGET_SECONDS, phone: 0 })
  const worstCaseUsd = callUsd + DEMO_SUMMARY_USD
  if (callUsd > 0 && (today.n + 1) * worstCaseUsd > config.dailyUsd!) {
    warnOnce(
      'budget',
      `ALERT demo calls: the daily budget of $${config.dailyUsd} (DEMO_DAILY_USD) is reached: ${today.n} demo calls today at up to $${worstCaseUsd} each`,
      nowMs,
    )
    return refused('budget', secondsToNextDay(nowMs))
  }
  if ((await spendingCap(tx, assistant.workspaceId, iso(nowMs)))?.reached) {
    warnOnce(
      'cap',
      `ALERT demo calls: the demo workspace ${assistant.workspaceId} reached its monthly spending cap`,
      nowMs,
    )
    return refused('budget', secondsToNextMonth(nowMs))
  }
  const now = await demoCallsNow(tx, nowMs)
  if (now >= config.maxConcurrent) {
    warnOnce('busy', `ALERT demo calls: all ${config.maxConcurrent} demo lines are busy (DEMO_MAX_CONCURRENT)`, nowMs)
    return refused('busy', BUSY_RETRY_SEC)
  }
  const unsafe = await unsafeWorkspace(tx, assistant.workspaceId)
  if (unsafe.length) {
    warnOnce(
      'unsafe-workspace',
      `ALERT demo calls: the demo workspace ${assistant.workspaceId} has ${unsafe.join(', ')}, so demo calls are refused`,
      nowMs,
    )
    return refused('off', null)
  }
  const agent = await voiceAgentProblem(tx, nowMs)
  if (agent === 'no_pipeline') {
    warnOnce(
      'pipeline',
      'ALERT demo calls: the voice agent has nothing to answer with (Server admin › Providers)',
      nowMs,
    )
    return refused('off', null)
  }
  if (agent === 'away') {
    warnOnce('away', "ALERT demo calls: the voice agent hasn't checked in lately, so demo calls are refused", nowMs)
    return refused('busy', AGENT_AWAY_RETRY_SEC)
  }
  if (callUsd <= 0) {
    // At $0 a call the budget would never stop anything: the active providers have no price the estimate knows.
    warnOnce(
      'no-rates',
      'ALERT demo calls: a demo call is estimated at $0 (no priced provider active, Server admin › Overview), so demo calls are refused',
      nowMs,
    )
    return refused('off', null)
  }
  return null
}

/** The request as the route reads it. */
export type DemoCallRequest = {
  authorization?: string
  contentType?: string
  body: () => Promise<unknown>
  /** The per-address bucket of the requester (client-ip.ts), for the wrong-secret throttle. */
  clientBucket?: string
}

/** Answers one POST /v1/demo/call. Never throws for a bad request; a database failure does (a 500). */
export async function demoCall(
  tx: Tx,
  req: DemoCallRequest,
  env: Env = process.env,
  nowMs = Date.now(),
  /** The cost estimate at the install's rates; replaced in tests. */
  estimate: (tx: Tx) => Promise<CostEstimate> = costEstimate,
): Promise<DemoCallAnswer> {
  const config = demoConfig(env)
  if (!config) return { status: 404, body: { ok: false, error: 'not found' } }
  if (!isGatewaySecret(req.authorization, config.secret)) {
    if (tooManyWrongSecrets(req.clientBucket ?? 'unknown', nowMs))
      return { status: 429, body: { ok: false, error: 'unauthorized', retryAfterSec: WRONG_SECRET_WINDOW_MS / 1000 } }
    return { status: 401, body: { ok: false, error: 'unauthorized' } }
  }
  if (req.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    return { status: 415, body: { ok: false, error: 'json' } }
  const body = await req.body().catch(() => undefined)
  if (unknownLanguage(body)) return { status: 400, body: { ok: false, error: 'language' } }
  const parsed = demoCallInput.safeParse(body)
  if (!parsed.success) return { status: 400, body: { ok: false, error: 'input' } }
  const input = parsed.data

  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    warnOnce('livekit', 'ALERT demo calls: DEMO_CALLS is on, but LiveKit is not configured on the server', nowMs)
    return refused('off', null)
  }
  if (config.dailyUsd === null) {
    warnOnce('daily', 'ALERT demo calls: DEMO_CALLS is on, but DEMO_DAILY_USD is not set: demo calls stay off', nowMs)
    return refused('off', null)
  }
  if (!config.workspaceId) {
    warnOnce(
      'workspace',
      'ALERT demo calls: DEMO_CALLS is on, but DEMO_WORKSPACE_ID is not set: demo calls stay off',
      nowMs,
    )
    return refused('off', null)
  }
  if (!config.assistants.size) {
    warnOnce('assistants', 'ALERT demo calls: DEMO_CALLS is on, but DEMO_ASSISTANTS names no assistant', nowMs)
    return refused('off', null)
  }
  const assistantId = config.assistants.get(input.industry)
  if (!assistantId) return { status: 400, body: { ok: false, error: 'industry' } }

  const room = `${DEMO_ROOM_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
  const outcome = await tx.transaction(async t => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext('demo-call-tokens'))`)
    const assistant = await demoAssistant(t, input.industry, assistantId, config.workspaceId!, input.language, nowMs)
    if (!assistant) return refused('off', null)
    const refusal = await demoRefusal(t, config, input, assistant, nowMs, estimate)
    if (refusal) return refusal
    await t.insert(commands).values({
      id: `cmd_${crypto.randomUUID().replaceAll('-', '')}`,
      workspace_id: assistant.workspaceId,
      actor_id: DEMO_ACTOR,
      action: DEMO_CALL_TOKEN,
      input: {
        industry: input.industry,
        ipHash: input.ipHash,
        ...(input.country ? { country: input.country } : {}),
        language: input.language,
      },
      result: { ok: true, rows: {}, data: { room, assistantId: assistant.id } },
    })
    return assistant
  })
  if ('status' in outcome) return outcome

  const metadata: TestCallMetadata = {
    source: 'test',
    workspaceId: outcome.workspaceId,
    assistantId: outcome.id,
    simulateTransfer: true,
    demo: true,
    // English is the demo assistants' own language: the call is exactly as before. Another one is the call's only one.
    ...(input.language !== 'en' ? { mainLanguage: input.language } : {}),
  }
  const token = browserRoomToken(
    { LIVEKIT_API_KEY, LIVEKIT_API_SECRET },
    room,
    `visitor-${room.slice(DEMO_ROOM_PREFIX.length)}`,
    metadata,
    Math.floor(nowMs / 1000),
  )
  console.log(
    `demo call token issued: ${room} (${[input.industry, input.country, input.language].filter(Boolean).join(', ')})`,
  )
  return {
    status: 200,
    body: {
      ok: true,
      url: env.LIVEKIT_PUBLIC_URL || LIVEKIT_URL,
      token,
      room,
      maxSeconds: DEMO_CALL_MAX_SECONDS,
      business: outcome.business,
      assistant: outcome.name,
    },
  }
}

/** The gateway's request is a few short fields. */
const DEMO_BODY_MAX_BYTES = 4096

/**
 * POST /v1/demo/call, before the sign-in guard: the gateway's Bearer secret is its only credential. No CORS headers:
 * browsers never call it. The CSRF guard lets Bearer requests through (csrf.ts).
 */
export function registerDemoCallRoutes<E extends HonoEnv>(app: Hono<E>) {
  app.post(
    '/v1/demo/call',
    async (c, next) => (demoConfig() ? next() : c.json({ ok: false, error: 'not found' }, 404)),
    bodyLimit({ maxSize: DEMO_BODY_MAX_BYTES, onError: c => c.json({ ok: false, error: 'input' }, 400) }),
    async c => {
      const answer = await demoCall(db, {
        authorization: c.req.header('authorization'),
        contentType: c.req.header('content-type'),
        body: () => c.req.json(),
        clientBucket: addressBucket(clientIpOf(c)),
      })
      if ('retryAfterSec' in answer.body && answer.body.retryAfterSec)
        c.header('retry-after', String(answer.body.retryAfterSec))
      return c.json(answer.body, answer.status)
    },
  )
}
