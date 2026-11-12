// Test calls from the web app: a member talks to the assistant in the browser, with no phone.
// The API only signs a LiveKit token. The token joins one new room, may publish the microphone
// and nothing else, and carries the agent dispatch with the workspace in its metadata; the browser
// cannot change any of it without breaking the signature.
import type { TestCallData } from '@linedesk/actions'
import { commands, type Tx } from '@linedesk/db'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { Reject } from './handlers.ts'
import { livekitToken } from './livekit-status.ts'
import { spendingCap } from './spending-cap.ts'

/** The voice agent's name (apps/agent/src/env.ts); it only joins rooms it is dispatched to by name. */
const AGENT_NAME = 'linedesk'
/** LiveKit checks a token only when joining: short, so it cannot open another test call after the room ends. */
const TOKEN_TTL_SEC = 60
/** A few test calls in a row are normal; more would only cost provider minutes. */
export const TEST_CALL_BURST = { max: 6, windowMs: 10 * 60_000 }

type Env = Record<string, string | undefined>

/** Test calls one user makes in a day, over all their workspaces: each one costs speech and model minutes. */
export const TEST_CALLS_PER_USER_PER_DAY = 20
/** Test calls on the whole install in a day, unless `TEST_CALLS_PER_DAY` says otherwise: the operator's ceiling. */
export const TEST_CALLS_PER_DAY = 200
const DAY_MS = 86_400_000

export function testCallsPerDay(env: Env = process.env) {
  const n = Number(env.TEST_CALLS_PER_DAY)
  return Number.isInteger(n) && n > 0 ? n : TEST_CALLS_PER_DAY
}

/**
 * The command-log entry for each test-call token issued (the action itself is read-only and not logged). The limits
 * count these: every test call needs a token, and a token issued but not used yet counts too, so a burst of tokens
 * cannot get past them. In the database, so every API process sees the same count.
 */
export const TEST_CALL_TOKEN = 'assistant.testCallToken'

/** Test-call tokens issued since `sinceMs`: the actor's, or the whole install's. */
async function tokensSince(tx: Tx, sinceMs: number, actorId?: string) {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(commands).where(and(
    eq(commands.action, TEST_CALL_TOKEN), gt(commands.created_at, new Date(sinceMs).toISOString()),
    actorId ? eq(commands.actor_id, actorId) : undefined,
  ))
  return row?.n ?? 0
}

/** Why the actor may not start another test call now, or null. */
async function testCallRefusal(tx: Tx, actor: Actor, nowMs: number, env: Env): Promise<string | null> {
  if ((await tokensSince(tx, nowMs - DAY_MS, actor.actorId)) >= TEST_CALLS_PER_USER_PER_DAY) return `You made ${TEST_CALLS_PER_USER_PER_DAY} test calls today. Try again tomorrow.`
  if ((await tokensSince(tx, nowMs - DAY_MS)) >= testCallsPerDay(env)) {
    console.error(`ALERT test calls: the install-wide limit of ${testCallsPerDay(env)} test calls a day is reached`)
    return 'This server has had as many test calls today as it allows. Try again tomorrow.'
  }
  if ((await tokensSince(tx, nowMs - TEST_CALL_BURST.windowMs, actor.actorId)) >= TEST_CALL_BURST.max) return 'Too many test calls in a short time. Try again in a few minutes.'
  return null
}

/** Why test calls are off in the workspace: its monthly spending cap is reached. */
export const TEST_CALLS_OVER_CAP = 'This workspace reached its monthly spending cap, so test calls are off until next month.'

/** Logs an issued token (its room, never the token) in the command log, where testCallRefusal counts it. */
async function recordToken(tx: Tx, actor: Actor, room: string, assistantId?: string) {
  await tx.insert(commands).values({
    id: `cmd_${crypto.randomUUID().replaceAll('-', '')}`,
    workspace_id: actor.workspaceId,
    actor_id: actor.actorId,
    action: TEST_CALL_TOKEN,
    input: assistantId ? { assistantId } : {},
    result: { ok: true, rows: {}, data: { room } },
    impersonated_by: actor.impersonation?.by ?? null,
  })
}

/** What the agent reads from the job metadata of a test room (apps/agent/src/worker.ts). */
/** `simulateTransfer`: a transfer on a test call reaches a simulated person who accepts, never a real phone. */
export type TestCallMetadata = { source: 'test'; workspaceId: string; assistantId?: string; simulateTransfer: true }

/**
 * `assistantId` must already be checked to be one of the actor's workspace's (the handler does). Counts and records
 * the token in one transaction, one test-call start at a time on the install, so two at once cannot both pass.
 */
export async function startTestCall(tx: Tx, actor: Actor, assistantId?: string, env: Env = process.env, nowMs = Date.now()): Promise<TestCallData> {
  if (!actor.workspaceId) throw new Reject('no workspace')
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) throw new Reject('test calls are not set up: LiveKit is not configured on the server')
  const room = `test-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
  await tx.transaction(async t => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtext('test-call-tokens'))`)
    const refusal = await testCallRefusal(t, actor, nowMs, env)
    if (refusal) throw new Reject(refusal)
    if ((await spendingCap(t, actor.workspaceId!, new Date(nowMs).toISOString()))?.reached) throw new Reject(TEST_CALLS_OVER_CAP)
    await recordToken(t, actor, room, assistantId)
  })

  const metadata: TestCallMetadata = { source: 'test', workspaceId: actor.workspaceId, ...(assistantId ? { assistantId } : {}), simulateTransfer: true }
  const nowSec = Math.floor(nowMs / 1000)
  const token = livekitToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    video: { roomJoin: true, room, canPublish: true, canPublishSources: ['microphone'], canSubscribe: true, canPublishData: false },
    // Created on join; the browser, the agent, a recording and a few teammates listening in or taking over
    // (call.listen, call.takeOver), closed soon after they leave.
    roomConfig: { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 8, agents: [{ agentName: AGENT_NAME, metadata: JSON.stringify(metadata) }] },
  }, nowSec, { identity: `web-${actor.actorId}`, ttlSec: TOKEN_TTL_SEC })
  // Where the browser reaches LiveKit; the API itself may use an internal address.
  const url = env.LIVEKIT_PUBLIC_URL || LIVEKIT_URL
  return { url, token, room, expiresAt: new Date((nowSec + TOKEN_TTL_SEC) * 1000).toISOString() }
}
