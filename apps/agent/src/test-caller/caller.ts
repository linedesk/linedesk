// The test caller: the same pipeline as the assistant, playing a caller from a scenario. Over the
// phone it talks to the SIP participant the call-test command dialled; in room mode it talks to the
// business's own agent in the same room. It hangs up when the scenario is done.
import { llm, voice, type JobContext } from '@livekit/agents'
import { z } from 'zod'
import { dtmfCode } from '../collect/collection.ts'
import type { AgentConfig } from '../config.ts'
import { ALL_PARTICIPANT_KINDS, waitForCounterpart } from '../counterpart.ts'
import { createPipeline } from '../pipeline.ts'
import { measureLatency } from './latency.ts'
import { callerInstructions, scenarios, type TestCallerMetadata } from './scenarios.ts'

/** The SIP participant the call-test command dials; the business's assistant answers on it. */
export const CALLEE_IDENTITY = 'callee'
/** A caller line that ends the conversation. */
export const isGoodbye = (text: string) => /\b(good ?bye|bye|have a (good|nice|great) (day|one))\b/i.test(text)
/** A test call never runs longer than this, whatever the model does. */
export const TEST_CALLER_LIMIT_MS = 2 * 60_000
/** How long a silent caller stays on the line before hanging up. */
export const SILENT_CALLER_MS = 25_000
/** Pause between two keypad presses, like a person typing. */
const KEY_GAP_MS = 250
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
  let saidGoodbye = false
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || !item.textContent) return
    if (item.role === 'assistant') saidGoodbye = isGoodbye(item.textContent)
    console.log(`${item.role === 'assistant' ? 'caller' : 'business'}: ${item.textContent}`)
  })
  const endCall = llm.tool({
    description: 'Hang up. Use it only right after you have said goodbye out loud.',
    execute: async () => {
      // Models sometimes hang up together with their first sentence; a test call must not end there.
      if (!saidGoodbye) return 'Do not hang up yet: you have not said goodbye. Continue the call.'
      setTimeout(hangUp, GOODBYE_MS).unref()
      return 'Hanging up.'
    },
  })
  const pressKeys = llm.tool({
    description: 'Type keys on the phone keypad (digits, * and #), for example when asked to type a number and press pound.',
    parameters: z.object({ keys: z.string().describe('The keys in order, e.g. "5035550142#".') }),
    execute: async ({ keys }) => {
      for (const key of keys.replace(/[^\d*#]/g, '')) {
        await ctx.room.localParticipant!.publishDtmf(dtmfCode(key), key)
        await new Promise(r => setTimeout(r, KEY_GAP_MS))
      }
      return 'Typed. Wait for the assistant.'
    },
  })
  measureLatency(ctx, counterpart, session)
  await session.start({
    agent: new voice.Agent({ instructions: callerInstructions(scenario), tools: { end_call: endCall, press_keys: pressKeys } }),
    room: ctx.room,
    inputOptions: { participantIdentity: counterpart.identity, participantKinds: ALL_PARTICIPANT_KINDS, closeOnDisconnect: true },
  })
}
