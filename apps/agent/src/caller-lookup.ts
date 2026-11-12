// The assistant's call-start webhook (docs/webhooks.md): asked once as the call comes in, through the API
// (call.lookUpCaller), which posts to the business's system and keeps what it answered on the call. The
// greeting waits for it only when it uses caller details ({{name}}), and then at most GREETING_WAIT_MS.
import { CALL_START_TIMEOUT_MS, type CallLookUpData, callLookUpCaller } from '@linedesk/actions'
import type { CallerDetails } from '@linedesk/db/types'
import type { ApiClient } from './api-client.ts'
import type { CallSession } from './call-session.ts'

/** The longest the greeting waits for caller details: the webhook's own time limit and the trip to the API. */
export const GREETING_WAIT_MS = CALL_START_TIMEOUT_MS + 300

/** The caller details, or null when there is no webhook or it failed; never throws, so the call goes on without them. */
export async function lookUpCaller(api: ApiClient, call: CallSession): Promise<CallerDetails | null> {
  try {
    const { data } = await api.run(callLookUpCaller, { callId: call.callId }, call)
    return (data as CallLookUpData | undefined)?.details ?? null
  } catch (e) {
    console.warn(`call ${call.callId}: the call-start webhook could not be asked: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** What `pending` resolves to, or `fallback` once `ms` have passed. */
export function within<T>(pending: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  return Promise.race([pending, late]).finally(() => clearTimeout(timer))
}
