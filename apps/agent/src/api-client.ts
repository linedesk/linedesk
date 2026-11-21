// The agent's only way to the API: POST /v1/actions/<name> to write, and its one read,
// GET /v1/agent/provider-config. The install-wide agent token opens a call (`call.start`,
// `call.startTest`) and reads the providers; everything for a call then goes with the call token
// the API returned for it, which is bound to that call and its workspace.
import { type ActionDef, type ActionRejection, type ActionResult, TOOL_MAX_WAIT_MS } from '@linedesk/actions'
import type { z } from 'zod'

/** No action takes long; a hung request must not hold up a call or its hang-up. */
const REQUEST_TIMEOUT_MS = 5000
/**
 * Actions that wait on a calendar provider: the API gives each provider request 8 s and makes up to three. Cut off
 * sooner, a booking the API still made reached the caller as failed (Cal.com, LIN-204).
 */
const CALENDAR_ACTIONS = new Set([
  'calendar.findSlots',
  'appointment.book',
  'appointment.reschedule',
  'appointment.cancel',
])
const CALENDAR_TIMEOUT_MS = 25_000
/**
 * A during-call lookup: the API waits DURING_CALL_TIMEOUT_MS (7 s) for the business's system, plus its own work, which
 * took 2–3 s on a busy server (LIN-359). So no cut-off here before the caller's own one (TOOL_MAX_WAIT_MS, withFillers).
 */
const LOOKUP_ACTION = 'call.askWebhook'
const LOOKUP_TIMEOUT_MS = TOOL_MAX_WAIT_MS + 1000
/** call.correctTranscript waits while a transcription model hears the whole recording again. */
const TRANSCRIPT_TIMEOUT_MS = 30_000
const SLOW_ACTIONS: Record<string, number> = {
  [LOOKUP_ACTION]: LOOKUP_TIMEOUT_MS,
  'call.correctTranscript': TRANSCRIPT_TIMEOUT_MS,
}
const timeoutOf = (name: string) =>
  CALENDAR_ACTIONS.has(name) ? CALENDAR_TIMEOUT_MS : (SLOW_ACTIONS[name] ?? REQUEST_TIMEOUT_MS)

export class ActionError extends Error {
  readonly action: string
  readonly status: number

  constructor(action: string, status: number, message: string) {
    super(`${action} failed (${status}): ${message}`)
    this.action = action
    this.status = status
  }
}

export interface ApiClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
}

/**
 * Whom an action is for once `call.start` has resolved the call: its workspace and the call token.
 * Without a token (an API older than the agent returns none) the agent token and the workspace header.
 */
export type CallScope = { workspaceId: string; token?: string }

export interface ApiClient {
  /** Runs one registry action, for the call in `scope` once there is one. */
  run<S extends z.ZodType>(def: ActionDef<S, any>, input: z.input<S>, scope?: CallScope): Promise<ActionResult>
  /** The speech and LLM providers set up in Linedesk, with their keys. The body is never put into an error. */
  providerSettings(): Promise<unknown>
  /**
   * White-label own keys (S7): the partner's own keys for one call that call.start forecast on them (install token
   * only, like providerSettings). The body is never put into an error, and never cached.
   */
  callProviderSettings?(callId: string): Promise<unknown>
  /** What each assistant a phone number answers with would greet with now (greeting-prewarm.ts; install token only). */
  greetings?(): Promise<unknown>
}

export function createApiClient({ baseUrl, token, fetch: doFetch = fetch }: ApiClientOptions): ApiClient {
  return {
    async run(def, input, scope) {
      const res = await doFetch(new URL(`/v1/actions/${def.name}`, baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${scope?.token ?? token}`,
          'idempotency-key': crypto.randomUUID(),
          ...(scope ? { 'x-workspace-id': scope.workspaceId } : {}),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeoutOf(def.name)),
      })
      const body = (await res.json().catch(() => null)) as ActionResult | ActionRejection | null
      if (!res.ok || !body?.ok)
        throw new ActionError(def.name, res.status, body && !body.ok ? body.error : res.statusText)
      return body
    },
    async providerSettings() {
      const res = await doFetch(new URL('/v1/agent/provider-config', baseUrl), {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok)
        throw new ActionError(
          'provider-config',
          res.status,
          typeof body?.error === 'string' ? body.error : res.statusText,
        )
      return body
    },
    async callProviderSettings(callId) {
      const url = new URL('/v1/agent/call-provider-config', baseUrl)
      url.searchParams.set('callId', callId)
      const res = await doFetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok)
        throw new ActionError(
          'call-provider-config',
          res.status,
          typeof body?.error === 'string' ? body.error : res.statusText,
        )
      return body
    },
    async greetings() {
      const res = await doFetch(new URL('/v1/agent/greetings', baseUrl), {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok)
        throw new ActionError('greetings', res.status, typeof body?.error === 'string' ? body.error : res.statusText)
      return body
    },
  }
}

/** Reads the API settings from the environment; throws naming the variable that is missing. */
export function apiClientFromEnv(env: NodeJS.ProcessEnv = process.env): ApiClient {
  const token = env.AGENT_API_TOKEN
  if (!token) throw new Error('AGENT_API_TOKEN is not set')
  return createApiClient({ baseUrl: env.LINEDESK_API_URL ?? 'http://localhost:3100', token })
}
