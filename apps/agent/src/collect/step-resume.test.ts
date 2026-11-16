// A collection step on a real LiveKit AgentSession (fake STT and LLM): after the step hands back, the assistant's
// reply plays, the session goes back to listening (so the silence reminder can come) and a fixed line still plays
// (the call's time limit).
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web'
import { initializeLogger, llm, stt, voice } from '@livekit/agents'
import { AudioFrame } from '@livekit/rtc-node'
import { afterEach, expect, test } from 'vitest'
import { CallLog } from '../call-log.ts'
import type { CallSession } from '../call-session.ts'
import { CollectTask } from './collect-task.ts'
import { collectTools } from './collect-tools.ts'

initializeLogger({ pretty: false, level: 'silent' })

const NAME_TURN = 'My name is Dana Ruiz.'
const QUESTION = 'Are you open on Saturdays?'
const ANSWER = 'Yes, we are open on Saturdays from 8 to 12.'
const LIMIT_LINE = 'This demo ends here. Thanks for calling!'
const AWAY_AFTER_S = 0.5

/** What the model is asked now: the step's opening, else the caller's last line or the last tool result. */
function askedNow(chatCtx: llm.ChatContext): string {
  const instructions =
    chatCtx.items.find((item): item is llm.ChatMessage => item.type === 'message' && item.role === 'system')
      ?.textContent ?? ''
  if (instructions.includes('read it back instead of asking again')) return STEP_OPENING
  const last = chatCtx.items.filter(item => item.type !== 'agent_config_update').at(-1)
  if (last?.type === 'message' && last.role === 'user') return last.textContent ?? ''
  if (last?.type === 'function_call_output') return last.output
  return ''
}

const STEP_OPENING = 'step opening'

/**
 * The model: the caller's name turn starts the name step, the step asks to spell, the question in it is handed back,
 * and the assistant answers it. LiveKit's FakeLLM answers by the input text; this one picks that text from the context.
 */
class ScriptedLLM extends voice.testing.FakeLLM {
  override chat(options: Parameters<voice.testing.FakeLLM['chat']>[0]) {
    const asked = askedNow(options.chatCtx)
    const chatCtx = new llm.ChatContext()
    chatCtx.addMessage({ role: 'user', content: asked })
    return super.chat({ ...options, chatCtx })
  }
  override lookup(input: string): voice.testing.FakeLLMResponse | undefined {
    if (input === NAME_TURN) return { input, toolCalls: [{ name: 'get_name', args: {} }] }
    if (input === STEP_OPENING) return { input, content: 'Could you spell your last name?' }
    if (input === QUESTION) return { input, toolCalls: [{ name: 'hand_back', args: { question: QUESTION } }] }
    // The step's result (the question it handed back) comes back to the assistant.
    if (input.includes(QUESTION)) return { input, content: ANSWER }
    return undefined
  }
}

/** Audio in, like a phone line: frames only keep the STT stream running; what the caller says comes from the fake STT. */
class LineInput extends voice.AudioInput {
  private controller!: ReadableStreamDefaultController<AudioFrame>
  constructor() {
    super()
    this.multiStream.addInputStream(
      new ReadableStream<AudioFrame>({
        start: controller => {
          this.controller = controller
        },
      }),
    )
  }
  push(frame: AudioFrame) {
    this.controller.enqueue(frame)
  }
}

const silence = (ms: number) => {
  const samples = (16_000 * ms) / 1000
  return new AudioFrame(new Int16Array(samples), 16_000, 1, samples)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, label: string, timeoutMs = 5000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(20)
  }
}

function callSession(): CallSession {
  return {
    callId: 'call_1',
    workspaceId: 'ws_1',
    assistant: { id: 'as_1' } as CallSession['assistant'],
    contact: {} as CallSession['contact'],
    caller: null,
    blocked: false,
    forwardingCheck: false,
    busy: false,
    overCap: false,
    businessHours: null,
    booking: null,
    lookups: [],
    businessNumber: null,
    simulatedOnCall: null,
    timeZone: null,
    append: async () => {},
    finish: async () => {},
    recordTimings: async () => {},
  } as CallSession
}

/** What a speech provider sends; the fake STT's queue is protected, so the test writes into it directly. */
type SttQueue = { queue: { put(event: stt.SpeechEvent): void } }

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

async function startCall() {
  const fakeStt = new stt.testing.FakeSTT({ capabilities: { streaming: true, interimResults: false } })
  const streams: SttQueue[] = []
  void (async () => {
    for await (const stream of fakeStt.streamCh) streams.push(stream as unknown as SttQueue)
  })()
  const log = new CallLog(callSession())
  const tools = collectTools({ log, today: () => '2026-11-16' })
  const agent = new voice.Agent({ instructions: 'You are the assistant.', tools: { get_name: tools.get_name } })
  const session = new voice.AgentSession({
    stt: fakeStt,
    llm: new ScriptedLLM(),
    vad: null,
    // As on a call: the speech provider detects the turns (Flux), the model starts early on a final transcript.
    turnHandling: {
      turnDetection: 'stt',
      endpointing: { minDelay: 50, maxDelay: 500 },
      preemptiveGeneration: { enabled: true },
    },
    userAwayTimeout: AWAY_AFTER_S,
  })
  const input = new LineInput()
  session.input.audio = input
  await session.start({ agent })
  const pump = setInterval(() => input.push(silence(20)), 20)
  cleanup = async () => {
    clearInterval(pump)
    await session.close().catch(() => {})
  }
  await until(() => streams.length > 0, 'the speech stream')
  const send = (event: stt.SpeechEvent) => streams.at(-1)!.queue.put(event)
  const said = (text: string) => {
    send({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text, language: 'en' as never, startTime: 0, endTime: 0, confidence: 1 }],
    })
    send({ type: stt.SpeechEventType.END_OF_SPEECH })
  }
  const assistantLines: string[] = []
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type === 'message' && item.role === 'assistant' && item.textContent) assistantLines.push(item.textContent)
  })
  const userStates: string[] = []
  session.on(voice.AgentSessionEventTypes.UserStateChanged, ({ newState }) => userStates.push(newState))
  return { session, send, said, assistantLines, userStates }
}

test('the caller goes on talking while the name step starts, asks a question in it and then waits: the answer plays, the call stays alive', async () => {
  const { session, send, said, assistantLines, userStates } = await startCall()

  send({ type: stt.SpeechEventType.START_OF_SPEECH })
  said(NAME_TURN)
  // The caller starts the next sentence while the assistant is already starting the name step (de-1, es-1 on 16.11.).
  await sleep(100)
  send({ type: stt.SpeechEventType.START_OF_SPEECH })
  await until(() => session.currentAgent instanceof CollectTask, 'the name step')
  await until(() => assistantLines.includes('Could you spell your last name?'), "the step's question")

  // The rest of that sentence is a question the step hands back; then the caller waits.
  said(QUESTION)
  await until(() => !(session.currentAgent instanceof CollectTask), 'the hand-back')
  await until(() => assistantLines.includes(ANSWER), "the assistant's answer", 3000)
  await until(() => session.agentState === 'listening', 'the assistant listening again')

  // Silence after the answer counts again: the caller is "away" after userAwayTimeout, which starts the reminders.
  await until(() => userStates.at(-1) === 'away', 'the caller marked away', 3000)

  // A fixed line (the time limit's) still plays after the hand-back.
  await session.say(LIMIT_LINE, { allowInterruptions: false }).waitForPlayout()
  expect(assistantLines.at(-1)).toBe(LIMIT_LINE)
}, 20_000)

test('a hand-back without the caller talking over the step start still answers (control)', async () => {
  const { session, send, said, assistantLines } = await startCall()

  send({ type: stt.SpeechEventType.START_OF_SPEECH })
  said(NAME_TURN)
  await until(() => session.currentAgent instanceof CollectTask, 'the name step')
  await until(() => assistantLines.includes('Could you spell your last name?'), "the step's question")
  send({ type: stt.SpeechEventType.START_OF_SPEECH })
  said(QUESTION)
  await until(() => assistantLines.includes(ANSWER), "the assistant's answer", 3000)
}, 20_000)
