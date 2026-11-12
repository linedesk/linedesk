// The worker runs even when the speech and LLM providers are not configured yet, so the stack
// can include it from the first `docker compose up`. Until they are, it answers no call: each
// call is logged as missed in the inbox and the caller is hung up on. The config is read again
// at every call, so the first call after the keys exist is answered without a restart.
import type { CallResult, CallSession } from './call-session.ts'
import { AgentConfigError, type CallConfig, isRealtime, type Stage } from './config.ts'
import { withRetry, type RetryOptions } from './retry.ts'

/** `reason` is for the operator's log; `stages` names what is missing in words the business may see. */
export type Readiness = { ready: true; config: CallConfig } | { ready: false; reason: string; stages: Stage[] }

/** The effective config, or why the agent cannot take calls. Never throws. */
export async function checkReadiness(load: () => Promise<CallConfig>): Promise<Readiness> {
  try {
    return { ready: true, config: await load() }
  } catch (e) {
    const stages = e instanceof AgentConfigError ? e.stages : []
    return { ready: false, reason: e instanceof Error ? e.message : String(e), stages }
  }
}

/** One line for the worker's start-up log. */
export function describeReadiness(readiness: Readiness): string {
  if (!readiness.ready)
    return `not answering calls yet: ${readiness.reason} Calls are logged as missed until then; the config is checked again at every call.`
  const { config } = readiness
  if (isRealtime(config)) return `answering calls. Realtime model: ${config.realtime.provider} ${config.realtime.model}, voice ${config.realtime.voice}`
  const { stt, llm, tts } = config
  return `answering calls. Speech to text: ${stt.provider} ${stt.model}; LLM: ${llm.provider} ${llm.model}; text to speech: ${tts.provider}`
}

/**
 * What the business sees in the inbox: a call nobody answered, from the caller's side. Why the
 * assistant was not answering is a setup problem, shown once in the app's status, not on every call;
 * the operator's detail stays in the worker log.
 */
export const missedResult: CallResult = {
  outcome: 'hangup',
  title: 'Missed call',
  summary: 'Nobody answered this call: the assistant was not taking calls yet. Call the caller back.',
  actionItems: [{ text: 'Call back' }],
}

/** Logs the call as missed and ends it. `hangUp` disconnects the caller. Never throws. */
export async function declineCall(
  call: CallSession,
  readiness: { reason: string; stages: Stage[] },
  hangUp: () => Promise<void>,
  retry?: RetryOptions,
) {
  console.warn(`call ${call.callId} not answered: ${readiness.reason}`)
  const logged = (async () => {
    await call.append('system', 'Missed')
    await withRetry(() => call.finish(missedResult), retry)
  })().catch(e => console.error(`could not log missed call ${call.callId}: ${e instanceof Error ? e.message : e}`))
  await Promise.all([logged, hangUp().catch(() => {})])
}
