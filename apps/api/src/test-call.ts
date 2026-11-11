// Test calls from the web app: a member talks to the assistant in the browser, with no phone.
// The API only signs a LiveKit token. The token joins one new room, may publish the microphone
// and nothing else, and carries the agent dispatch with the workspace in its metadata; the browser
// cannot change any of it without breaking the signature.
import type { TestCallData } from '@linedesk/actions'
import type { Actor } from './context.ts'
import { Reject } from './handlers.ts'
import { livekitToken } from './livekit-status.ts'
import { createRateLimiter } from './rate-limit.ts'

/** The voice agent's name (apps/agent/src/env.ts); it only joins rooms it is dispatched to by name. */
const AGENT_NAME = 'linedesk'
/** LiveKit checks a token only when joining: short, so it cannot open another test call after the room ends. */
const TOKEN_TTL_SEC = 60
/** A few test calls in a row are normal; more would only cost provider minutes. */
const allowTestCall = createRateLimiter({ max: 6, windowMs: 10 * 60_000 })

type Env = Record<string, string | undefined>

/** What the agent reads from the job metadata of a test room (apps/agent/src/worker.ts). */
export type TestCallMetadata = { source: 'test'; workspaceId: string; assistantId?: string }

/** `assistantId` must already be checked to be one of the actor's workspace's (the handler does). */
export function startTestCall(actor: Actor, assistantId?: string, env: Env = process.env, nowMs = Date.now()): TestCallData {
  if (!actor.workspaceId) throw new Reject('no workspace')
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) throw new Reject('test calls are not set up: LiveKit is not configured on the server')
  if (!allowTestCall(`${actor.workspaceId}:${actor.actorId}`, nowMs)) throw new Reject('Too many test calls in a short time. Try again in a few minutes.')

  const room = `test-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
  const metadata: TestCallMetadata = { source: 'test', workspaceId: actor.workspaceId, ...(assistantId ? { assistantId } : {}) }
  const nowSec = Math.floor(nowMs / 1000)
  const token = livekitToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    video: { roomJoin: true, room, canPublish: true, canPublishSources: ['microphone'], canSubscribe: true, canPublishData: false },
    // Created on join; the browser, the agent and a recording, closed soon after they leave.
    roomConfig: { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 3, agents: [{ agentName: AGENT_NAME, metadata: JSON.stringify(metadata) }] },
  }, nowSec, { identity: `web-${actor.actorId}`, ttlSec: TOKEN_TTL_SEC })
  // Where the browser reaches LiveKit; the API itself may use an internal address.
  const url = env.LIVEKIT_PUBLIC_URL || LIVEKIT_URL
  return { url, token, room, expiresAt: new Date((nowSec + TOKEN_TTL_SEC) * 1000).toISOString() }
}
