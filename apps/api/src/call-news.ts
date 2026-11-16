// What goes out when a call is finished: the team's email, the "finished" push, the evaluation, the after-call webhook
// and the integrations' call_finished. call.finish sends it at once, or, when after-call transcription corrects the
// transcript first, holds it (calls.awaiting_transcript_until) until call.finalize brings the summary of the corrected
// transcript, or the CALL_RELEASE job finds the agent never did (AWAIT_TRANSCRIPT_MAX_SEC).
import { CALL_END_DELAY_SEC } from '@linedesk/actions'
import { calls, type Tx } from '@linedesk/db'
import type { Call } from '@linedesk/db/types'
import { and, eq, isNotNull } from 'drizzle-orm'
import { evaluatedAutomatically } from './evaluations.ts'
import { queueIntegrationDeliveries } from './integrations.ts'
import { queueAppPushes } from './app-pushes.ts'
import { queueCallEvaluation, queueCallNotification, queueCallPush } from './jobs.ts'
import { queueCallEnd } from './webhooks.ts'

/**
 * Queues a finished call's news in the caller's transaction. `webhookDelaySec`: how long the after-call webhook and
 * the integrations wait (CALL_END_DELAY_SEC, so the recording is saved by then; 0 once it is).
 */
export async function queueFinishedNews(tx: Tx, call: Call, webhookDelaySec = CALL_END_DELAY_SEC) {
  await queueCallNotification(tx, call.id)
  await queueCallPush(tx, call.id, 'finished')
  // Test calls are evaluated only when the call view asks (call.evaluate).
  if (evaluatedAutomatically(call)) await queueCallEvaluation(tx, call.id)
  await queueCallEnd(tx, call, webhookDelaySec)
  await queueIntegrationDeliveries(tx, call, webhookDelaySec)
  await queueAppPushes(tx, call, webhookDelaySec)
}

/**
 * Sends the news a call held for its corrected transcript, once: the first of call.finalize and the CALL_RELEASE job
 * takes the hold off and queues it; the other finds no hold (null). The recording is saved by then (or never will be).
 */
export async function releaseHeldNews(tx: Tx, callId: string): Promise<Call | null> {
  const [released] = await tx
    .update(calls)
    .set({ awaiting_transcript_until: null })
    .where(and(eq(calls.id, callId), isNotNull(calls.awaiting_transcript_until)))
    .returning()
  if (released) await queueFinishedNews(tx, released, 0)
  return released ?? null
}
