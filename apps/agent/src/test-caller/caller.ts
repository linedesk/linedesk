// The test caller: the same pipeline as the assistant, playing a caller from a scenario. Over the
// phone it talks to the SIP participant the call-test command dialled; in room mode it talks to the
// business's own agent in the same room. It hangs up when the scenario is done.
import { llm, voice, type JobContext } from '@livekit/agents'
import type { AgentConfig, RealtimeConfig } from '../config.ts'
import { ALL_PARTICIPANT_KINDS, waitForCounterpart } from '../counterpart.ts'
import { createPipeline, createRealtimeLineTts } from '../pipeline.ts'
import { measureLatency } from './latency.ts'
import { callerInstructions, callerLanguagesOf, type Scenario, scenarios, type TestCallerMetadata } from './scenarios.ts'

/** The SIP participant the call-test command dials; the business's assistant answers on it. */
export const CALLEE_IDENTITY = 'callee'
/** A caller line that ends the conversation, in English and in the languages of the language scenarios. */
export const isGoodbye = (text: string) =>
  /\b(good ?bye|bye|have a (good|nice|great) (day|one)|au revoir|auf wiedersehen|tschüss|arrivederci|tchau|adeus|tot ziens|do widzenia)\b|adi[oó]s|до свидания|नमस्ते|अलविदा|失礼します|さようなら|再见|안녕히/i.test(text)
/** A test call never runs longer than this, whatever the model does. */
export const TEST_CALLER_LIMIT_MS = 3 * 60_000
/** How long a silent caller stays on the line before hanging up. */
export const SILENT_CALLER_MS = 25_000
/**
 * The test caller's OpenAI voice when a realtime model's key is there: unlike the assistant's realtime voice (marin), and
 * cheaper than spending the voice provider's characters on test calls (TEST_CALLER_OPENAI_VOICE picks another).
 */
export const TEST_CALLER_OPENAI_VOICE = 'ash'

/** Time for the goodbye to be spoken before the line is cut. */
const GOODBYE_MS = 4000

/**
 * `openAi`: the realtime model's key, when one is set up: the caller then speaks through OpenAI's speech model instead of
 * the voice provider (its characters are kept for real calls, and a used-up quota does not silence the test caller).
 */
export async function runTestCaller(ctx: JobContext, { scenario: name, mode, persona }: TestCallerMetadata, config: AgentConfig, openAi: Pick<RealtimeConfig, 'apiKey'> | null = null) {
  const hangUp = () => void ctx.deleteRoom().catch(() => {})
  const after = (ms: number, why: string) => {
    const timer = setTimeout(() => {
      console.log(`test caller (${name}): ${why}, hanging up`)
      hangUp()
    }, ms)
    timer.unref()
    ctx.addShutdownCallback(async () => clearTimeout(timer))
  }
  const scenario: Scenario = persona ? { ...scenarios[name], persona } : scenarios[name]
  after(scenario.longCallMs ?? TEST_CALLER_LIMIT_MS, 'time limit reached')

  const counterpart = await waitForCounterpart(ctx, mode === 'phone' ? CALLEE_IDENTITY : undefined)
  if (!scenario.persona) {
    measureLatency(ctx, counterpart, null)
    return after(scenario.silentForMs ?? SILENT_CALLER_MS, 'stayed silent')
  }

  // A voice other than the assistant's, so the two sides are easy to tell apart in a recording.
  const voiceId = process.env.TEST_CALLER_VOICE_ID
  const voiceOf = voiceId ? { provider: config.tts.provider, voice_id: voiceId } : null
  const pipeline = createPipeline(config, voiceOf, undefined, callerLanguagesOf(scenario) ? { main: 'en', others: callerLanguagesOf(scenario)! } : undefined)
  const openAiVoice = openAi && createRealtimeLineTts({ apiKey: openAi.apiKey, voice: process.env.TEST_CALLER_OPENAI_VOICE || TEST_CALLER_OPENAI_VOICE })
  const session = new voice.AgentSession(openAiVoice ? { ...pipeline, tts: openAiVoice } : pipeline)
  let saidGoodbye = false
  let ownLines = 0
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || !item.textContent) return
    if (item.role === 'assistant') saidGoodbye = isGoodbye(item.textContent)
    if (item.role === 'assistant' && ++ownLines === scenario.silentAfterLines) goSilent()
    console.log(`${item.role === 'assistant' ? 'caller' : 'business'}: ${item.textContent}`)
  })
  // Muted both ways once its lines are said: no more turns, nothing to hear, until the assistant or the timer ends the call.
  const goSilent = () => {
    console.log(`test caller (${name}): silent from now on`)
    session.input.setAudioEnabled(false)
    setTimeout(() => session.output.setAudioEnabled(false), 1000).unref() // the line just said plays to its end
    after(scenario.silentForMs ?? SILENT_CALLER_MS, 'stayed silent')
  }
  const endCall = llm.tool({
    description: 'Hang up. Use it only right after you have said goodbye out loud.',
    execute: async () => {
      // The goodbye said with this call is recorded once it has played: wait for it.
      for (const deadline = Date.now() + GOODBYE_MS * 2; !saidGoodbye && Date.now() < deadline; ) await new Promise(r => setTimeout(r, 200))
      // Models sometimes hang up together with their first sentence; a test call must not end there.
      if (!saidGoodbye) return 'Do not hang up yet: you have not said goodbye. Continue the call.'
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
  for (const cue of scenario.cues ?? []) {
    const timer = setTimeout(() => {
      console.log(`test caller (${name}): cue at ${Math.round(cue.atMs / 1000)} s`)
      session.generateReply({ instructions: cue.say })
    }, cue.atMs)
    timer.unref()
    ctx.addShutdownCallback(async () => clearTimeout(timer))
  }
}
