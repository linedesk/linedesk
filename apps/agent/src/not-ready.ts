// The worker runs even when the speech and LLM providers are not configured yet, so the stack
// can include it from the first `docker compose up`. Until they are, it answers no call: each
// call is logged as missed in the inbox and the caller is hung up on. The config is read again
// at every call, so the first call after the keys exist is answered without a restart.
import type { CallResult, CallSession } from './call-session.ts'
import { loadAgentConfig, type AgentConfig } from './config.ts'
import { withRetry, type RetryOptions } from './retry.ts'

export type Readiness = { ready: true; config: AgentConfig } | { ready: false; reason: string }

/** The effective config, or why the agent cannot take calls. Never throws. */
export async function checkReadiness(load: () => Promise<AgentConfig> = loadAgentConfig): Promise<Readiness> {
  try {
    return { ready: true, config: await load() }
  } catch (e) {
    return { ready: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** One line for the worker's start-up log. */
export function describeReadiness(readiness: Readiness): string {
  if (!readiness.ready) return `not answering calls yet: ${readiness.reason} Calls are logged as missed until then; the config is checked again at every call.`
  const { stt, llm, tts } = readiness.config
  return `answering calls. Speech to text: ${stt.provider} ${stt.model}; LLM: ${llm.provider} ${llm.model}; text to speech: ${tts.provider}`
}

/** What the business sees in the inbox. The operator's detail (which key is missing) stays in the log. */
export const missedResult: CallResult = {
  outcome: 'hangup',
  title: 'Missed call: assistant not set up',
  summary: 'The call was not answered because the assistant is not set up yet: its speech and language providers are not configured.',
  actionItems: [{ text: 'Call back' }],
}

/** Logs the call as missed and ends it. `hangUp` disconnects the caller. Never throws. */
export async function declineCall(call: CallSession, reason: string, hangUp: () => Promise<void>, retry?: RetryOptions) {
  console.warn(`call ${call.callId} not answered: ${reason}`)
  const logged = (async () => {
    await call.append('system', 'Not answered: the assistant is not set up yet')
    await withRetry(() => call.finish(missedResult), retry)
  })().catch(e => console.error(`could not log missed call ${call.callId}: ${e instanceof Error ? e.message : e}`))
  await Promise.all([logged, hangUp().catch(() => {})])
}
