// The agent's only way to write: POST /v1/actions/<name> with the agent token.
import type { ActionDef, ActionRejection, ActionResult } from '@callfront/actions'
import type { z } from 'zod'

/** No action takes long; a hung request must not hold up a call or its hang-up. */
const REQUEST_TIMEOUT_MS = 5000

export class ActionError extends Error {
  constructor(readonly action: string, readonly status: number, message: string) {
    super(`${action} failed (${status}): ${message}`)
  }
}

export interface ApiClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
}

export interface ApiClient {
  /** Runs one registry action. `workspaceId` scopes the agent once `call.start` has resolved it. */
  run<S extends z.ZodType>(def: ActionDef<S, any>, input: z.input<S>, workspaceId?: string): Promise<ActionResult>
}

export function createApiClient({ baseUrl, token, fetch: doFetch = fetch }: ApiClientOptions): ApiClient {
  return {
    async run(def, input, workspaceId) {
      const res = await doFetch(new URL(`/v1/actions/${def.name}`, baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'idempotency-key': crypto.randomUUID(),
          ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = (await res.json().catch(() => null)) as ActionResult | ActionRejection | null
      if (!res.ok || !body?.ok) throw new ActionError(def.name, res.status, body && !body.ok ? body.error : res.statusText)
      return body
    },
  }
}

/** Reads the API settings from the environment; throws naming the variable that is missing. */
export function apiClientFromEnv(env: NodeJS.ProcessEnv = process.env): ApiClient {
  const token = env.AGENT_API_TOKEN
  if (!token) throw new Error('AGENT_API_TOKEN is not set')
  return createApiClient({ baseUrl: env.CALLFRONT_API_URL ?? 'http://localhost:3100', token })
}
