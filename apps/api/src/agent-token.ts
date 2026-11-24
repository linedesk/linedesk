// Per-call agent tokens. `call.start` and `call.startTest` hand the voice agent a short-lived token
// bound to the call's workspace and the call; every later request the agent makes for that call
// carries it instead of the install-wide AGENT_API_TOKEN, so a leaked call token reaches one call
// of one workspace for a few hours, never another workspace.
// Signed with a key derived from BETTER_AUTH_SECRET, which the agent never has: it cannot mint one.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const CALL_TOKEN_PREFIX = 'ldcall_'
/** Longer than any real call; the agent needs it until the recording is saved after the call. */
export const CALL_TOKEN_TTL_MS = 4 * 60 * 60_000

export type CallTokenClaims = { workspaceId: string; callId: string; expiresAt: number }

type Env = Record<string, string | undefined>

function signingKey(env: Env): Buffer {
  const secret = env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set: agent call tokens cannot be signed')
  return createHmac('sha256', secret).update('linedesk agent call token v1').digest()
}

const sign = (payload: string, env: Env) => createHmac('sha256', signingKey(env)).update(payload).digest('base64url')

export const isCallToken = (bearer: string) => bearer.startsWith(CALL_TOKEN_PREFIX)

export function issueCallToken(
  workspaceId: string,
  callId: string,
  nowMs = Date.now(),
  env: Env = process.env,
): string {
  const payload = Buffer.from(JSON.stringify({ w: workspaceId, c: callId, e: nowMs + CALL_TOKEN_TTL_MS })).toString(
    'base64url',
  )
  return `${CALL_TOKEN_PREFIX}${payload}.${sign(payload, env)}`
}

/** The claims of a valid, unexpired token; null for anything else. Never throws on bad input. */
export function verifyCallToken(token: string, nowMs = Date.now(), env: Env = process.env): CallTokenClaims | null {
  if (!isCallToken(token)) return null
  const [payload, signature, ...rest] = token.slice(CALL_TOKEN_PREFIX.length).split('.')
  if (!payload || !signature || rest.length) return null
  const [given, expected] = [Buffer.from(signature), Buffer.from(sign(payload, env))]
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const { w, c, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof w !== 'string' || typeof c !== 'string' || typeof e !== 'number' || e <= nowMs) return null
    return { workspaceId: w, callId: c, expiresAt: e }
  } catch {
    return null
  }
}
