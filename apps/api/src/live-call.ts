// Listen in and take over (docs/architecture.md §7, "Live view"): a member of the call's workspace gets a
// LiveKit token for that call's room and nothing else. Listen: hidden, can hear, cannot publish anything.
// Take over: cannot publish either at first, and carries the member's name in an attribute the voice agent
// trusts (only the API signs it). The agent stops the recording, tells the caller who takes over, leaves the
// conversation and only then grants the member microphone publishing (apps/agent/src/take-over.ts).
// A member disabled while on a call keeps their connection until the call ends: tokens are checked only on
// joining, and nothing removes participants from running calls when a member is disabled.
import { type LiveCallJoin, TAKE_OVER_ATTRIBUTE } from '@linedesk/actions'
import { call_events, calls, workspace_members, type Tx } from '@linedesk/db'
import type { Call } from '@linedesk/db/types'
import { and, eq, gt, ne } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { Forbidden, type Handler, lockCall, notFound, Reject } from './handler-context.ts'
import { livekitToken } from './livekit-status.ts'

/** LiveKit checks a token only when joining: short, so a token cannot be kept to join later. */
const TOKEN_TTL_SEC = 60
/**
 * How long one member's take-over holds the call against another member's: the time to join plus the hand-over.
 * After that the agent decides: it hands the call to the first member who joins and removes anyone after them,
 * so a member who got a token but never joined (or was refused) does not lock the call.
 */
const TAKE_OVER_HOLD_MS = 90_000

type Env = Record<string, string | undefined>
type Mode = 'listen' | 'takeOver'

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/** Only a member signed in to the web app: never the assistant, an API key or an instance admin signed in as someone. */
function memberOf(actor: Actor): { workspaceId: string; userId: string } {
  if (!actor.workspaceId) throw new Reject('no workspace')
  if (actor.role === 'agent' || actor.apiKeyId || !actor.sessionId || actor.impersonation)
    throw new Forbidden('Only a signed-in member of the workspace can listen to or take over a call')
  return { workspaceId: actor.workspaceId, userId: actor.actorId }
}

/** The live call of the member's workspace; another workspace's call is not found, like any other row. */
async function liveCall(tx: Tx, workspaceId: string, callId: string): Promise<Call & { room: string }> {
  const [call] = await tx
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspace_id, workspaceId)))
  if (!call) throw notFound('calls')
  if (call.status !== 'live' || !call.room) throw new Reject('This call has ended.')
  return call as Call & { room: string }
}

async function memberName(tx: Tx, workspaceId: string, userId: string): Promise<string> {
  const [member] = await tx
    .select({ name: workspace_members.name, disabled: workspace_members.disabled })
    .from(workspace_members)
    .where(and(eq(workspace_members.workspace_id, workspaceId), eq(workspace_members.user_id, userId)))
  if (!member || member.disabled)
    throw new Forbidden('Only a member of the workspace can listen to or take over a call')
  return member.name.trim() || 'a colleague'
}

/**
 * Why the member cannot take the call over now, or null. The same member may take it over again (a reload, a
 * dropped connection); someone else may not, so the caller never ends up with two people talking at once.
 */
async function takeOverRefusal(tx: Tx, call: Call, userId: string, now: string): Promise<string | null> {
  if (call.transfer_result === 'dialing' || call.transfer_result === 'connected')
    return 'The assistant is putting this call through to someone else.'
  const [taken] = await tx
    .select({ name: workspace_members.name })
    .from(call_events)
    .leftJoin(
      workspace_members,
      and(
        eq(workspace_members.workspace_id, call_events.workspace_id),
        eq(workspace_members.user_id, call_events.actor_id),
      ),
    )
    .where(
      and(
        eq(call_events.call_id, call.id),
        eq(call_events.kind, 'took_over'),
        ne(call_events.actor_id, userId),
        gt(call_events.created_at, new Date(Date.parse(now) - TAKE_OVER_HOLD_MS).toISOString()),
      ),
    )
    .limit(1)
  return taken ? `${taken.name ?? 'Someone'} is taking this call over.` : null
}

/** Records the member's listen-in once per call (rejoining is not news), and every take-over. */
async function recordEvent(tx: Tx, call: Call, userId: string, kind: 'listened' | 'took_over', now: string) {
  if (kind === 'listened') {
    const [seen] = await tx
      .select({ id: call_events.id })
      .from(call_events)
      .where(and(eq(call_events.call_id, call.id), eq(call_events.kind, 'listened'), eq(call_events.actor_id, userId)))
      .limit(1)
    if (seen) return []
  }
  return tx
    .insert(call_events)
    .values({
      id: newId('cev'),
      workspace_id: call.workspace_id,
      call_id: call.id,
      kind,
      actor_id: userId,
      assignee_id: null,
      created_at: now,
    })
    .returning()
}

/**
 * The grants for each mode: hear only, no data, no changing its own attributes. A take-over is visible (the agent
 * must see it) and gets microphone publishing from the agent once the hand-over is done, never from the token.
 */
function grantsFor(mode: Mode, room: string) {
  const base = {
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: false,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  }
  return mode === 'listen' ? { ...base, hidden: true } : base
}

export function signJoin(
  mode: Mode,
  room: string,
  userId: string,
  name: string,
  env: Env = process.env,
  nowMs = Date.now(),
): LiveCallJoin {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET)
    throw new Reject('Listening in is not set up: LiveKit is not configured on the server')
  // Listeners get a new identity each time, so two tabs never push each other out; a take-over has one.
  const identity = mode === 'listen' ? `listen-${userId}-${crypto.randomUUID().slice(0, 8)}` : `takeover-${userId}`
  const nowSec = Math.floor(nowMs / 1000)
  const claims = {
    video: grantsFor(mode, room),
    name,
    ...(mode === 'takeOver' ? { attributes: { [TAKE_OVER_ATTRIBUTE]: name } } : {}),
  }
  const token = livekitToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, claims, nowSec, { identity, ttlSec: TOKEN_TTL_SEC })
  const url = env.LIVEKIT_PUBLIC_URL || LIVEKIT_URL
  return { url, token, room, identity, expiresAt: new Date((nowSec + TOKEN_TTL_SEC) * 1000).toISOString() }
}

export function liveCallHandlers(env: () => Env = () => process.env): Record<string, Handler> {
  return {
    'call.listen': async ({ tx, actor, now }, input: { callId: string }) => {
      const { workspaceId, userId } = memberOf(actor)
      const call = await liveCall(tx, workspaceId, input.callId)
      const name = await memberName(tx, workspaceId, userId)
      const data = signJoin('listen', call.room, userId, name, env())
      const events = await recordEvent(tx, call, userId, 'listened', now)
      return { rows: events.length ? { call_events: events } : {}, data }
    },

    'call.takeOver': async ({ tx, actor, now }, input: { callId: string }) =>
      tx.transaction(async t => {
        const { workspaceId, userId } = memberOf(actor)
        // One take-over at a time: two members clicking at once must not both join to take over.
        await lockCall(t, input.callId)
        const call = await liveCall(t, workspaceId, input.callId)
        const refusal = await takeOverRefusal(t, call, userId, now)
        if (refusal) throw new Reject(refusal)
        const name = await memberName(t, workspaceId, userId)
        const data = signJoin('takeOver', call.room, userId, name, env())
        const events = await recordEvent(t, call, userId, 'took_over', now)
        return { rows: { call_events: events }, data }
      }),
  }
}
