// The test caller: the same pipeline as the assistant, playing a caller from a scenario. Over the
// phone it talks to the SIP participant the call-test command dialled; in room mode it talks to the
// business's own agent in the same room. It hangs up when the scenario is done.
import { llm, voice, type JobContext } from '@livekit/agents'
import type { AgentConfig } from '../config.ts'
import { ALL_PARTICIPANT_KINDS, waitForCounterpart } from '../counterpart.ts'
import { createPipeline } from '../pipeline.ts'
import { measureLatency } from './latency.ts'
import { callerInstructions, scenarios, type TestCallerMetadata } from './scenarios.ts'

/** The SIP participant the call-test command dials; the business's assistant answers on it. */
export const CALLEE_IDENTITY = 'callee'
/** A test call never runs longer than this, whatever the model does. */
export const TEST_CALLER_LIMIT_MS = 2 * 60_000
/** How long a silent caller stays on the line before hanging up. */
export const SILENT_CALLER_MS = 25_000
/** Time for the goodbye to be spoken before the line is cut. */
const GOODBYE_MS = 4000

export async function runTestCaller(ctx: JobContext, { scenario: name, mode }: TestCallerMetadata, config: AgentConfig) {
  const hangUp = () => void ctx.deleteRoom().catch(() => {})
  const after = (ms: number, why: string) => {
    const timer = setTimeout(() => {
      console.log(`test caller (${name}): ${why}, hanging up`)
      hangUp()
    }, ms)
    timer.unref()
    ctx.addShutdownCallback(async () => clearTimeout(timer))
  }
  after(TEST_CALLER_LIMIT_MS, 'time limit reached')

  const counterpart = await waitForCounterpart(ctx, mode === 'phone' ? CALLEE_IDENTITY : undefined)
  const scenario = scenarios[name]
  if (!scenario.persona) {
    measureLatency(ctx, counterpart, null)
    return after(SILENT_CALLER_MS, 'stayed silent')
  }

  // A voice other than the assistant's, so the two sides are easy to tell apart in a recording.
  const voiceId = process.env.TEST_CALLER_VOICE_ID
  const session = new voice.AgentSession(createPipeline(config, voiceId ? { provider: config.tts.provider, voice_id: voiceId } : null))
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type === 'message' && item.textContent) console.log(`${item.role === 'assistant' ? 'caller' : 'business'}: ${item.textContent}`)
  })
  const endCall = llm.tool({
    description: 'Hang up. Use it right after saying goodbye.',
    execute: async () => {
      setTimeout(hangUp, GOODBYE_MS).unref()
      return 'Hanging up.'
    },
  })
  measureLatency(ctx, counterpart, session)
  await session.start({
    agent: new voice.Agent({ instructions: callerInstructions(scenario), tools: { end_call: endCall } }),
    room: ctx.room,
    inputOptions: { participantIdentity: counterpart.identity, participantKinds: ALL_PARTICIPANT_KINDS, closeOnDisconnect: true },
  })
}
