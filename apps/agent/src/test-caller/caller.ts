// The test caller: the same pipeline as the assistant, playing a caller from a scenario. It runs in
// the room of an outbound SIP call to the business's number and hangs up when the scenario is done.
import { llm, voice, type JobContext } from '@livekit/agents'
import type { AgentConfig } from '../config.ts'
import { createPipeline, type Vad } from '../pipeline.ts'
import { callerInstructions, scenarios, type ScenarioName } from './scenarios.ts'

/** The SIP participant the call-test command dials; the business's assistant answers on it. */
export const CALLEE_IDENTITY = 'callee'
/** A test call never runs longer than this, whatever the model does. */
export const TEST_CALLER_LIMIT_MS = 2 * 60_000
/** Time for the goodbye to be spoken before the line is cut. */
const GOODBYE_MS = 4000

export async function runTestCaller(ctx: JobContext, scenarioName: ScenarioName, config: AgentConfig, vad: Vad) {
  const hangUp = () => void ctx.deleteRoom().catch(() => {})
  const limit = setTimeout(() => {
    console.log(`test caller (${scenarioName}): time limit reached, hanging up`)
    hangUp()
  }, TEST_CALLER_LIMIT_MS)
  limit.unref()
  ctx.addShutdownCallback(async () => clearTimeout(limit))

  const callee = await ctx.waitForParticipant(CALLEE_IDENTITY)
  // A voice other than the assistant's, so the two sides are easy to tell apart in a recording.
  const voiceId = process.env.TEST_CALLER_VOICE_ID
  const session = new voice.AgentSession(createPipeline(vad, config, voiceId ? { provider: config.tts.provider, voice_id: voiceId } : null))
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
  await session.start({
    agent: new voice.Agent({ instructions: callerInstructions(scenarios[scenarioName]), tools: { end_call: endCall } }),
    room: ctx.room,
    inputOptions: { participantIdentity: callee.identity, closeOnDisconnect: true },
  })
}
