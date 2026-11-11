// The voice agent: a LiveKit Agents worker. One job per call room; all writes go through the API.
// Which speech and language vendors are used is decided in pipeline.ts.
import { fileURLToPath } from 'node:url'
import { callFlagUrgent, callTakeMessage } from '@linedesk/actions'
import { cli, defineAgent, llm, ServerOptions, voice, type JobContext } from '@livekit/agents'
import type { RemoteParticipant } from '@livekit/rtc-node'
import { z } from 'zod'
import { apiClientFromEnv, type ApiClient } from './api-client.ts'
import { bookingTools } from './booking-tools.ts'
import { CallLog, finishCall, hangUp, once, RECORDING_WAIT_MS } from './call-log.ts'
import { callOrigin, parseTestMetadata, startCall, type CallSession } from './call-session.ts'
import { earlyOrigin, livekitParticipants } from './early-origin.ts'
import { createConfigLoader, parseProviderSettings, type AgentConfig } from './config.ts'
import { AGENT_NAME, requireEnv, requireLivekitEnv } from './env.ts'
import { checkReadiness, declineCall, describeReadiness } from './not-ready.ts'
import { createPipeline, createTts, summaryLlm, ttsModelOf, voiceFor, warmUpLlm } from './pipeline.ts'
import { audioStream, createGreetingCache, greetingKey, synthesize } from './greeting-cache.ts'
import { logTurnMetrics } from './turn-metrics.ts'
import { skipQuietToolReplies } from './tool-replies.ts'
import { hangUpAfterSpeech, speakingOf } from './hang-up.ts'
import { buildInstructions, FALLBACK_GREETING } from './prompt.ts'
import { describeRecording, livekitRecorder, resolveRecording, saveRecording, startRecording, stopRecording, stopRecordingOrThrow } from './recording.ts'
import { ALL_PARTICIPANT_KINDS, waitForCounterpart } from './counterpart.ts'
import { runTestCaller } from './test-caller/caller.ts'
import { transferNumberFor } from './transfer.ts'
import { onCallDialerFor, transferTool } from './transfer-tool.ts'
import { parseTestCallerMetadata, type TestCallerMetadata } from './test-caller/scenarios.ts'
import { type AgentSetup, SETUP_ATTRIBUTE } from './test-caller/latency.ts'

let configLoader: (() => Promise<AgentConfig>) | undefined
/** The effective provider config: Linedesk's provider settings first, the environment as fallback, cached briefly per process. */
function loadAgentConfig(): Promise<AgentConfig> {
  configLoader ??= createConfigLoader({ fetchSettings: async () => parseProviderSettings(await apiClientFromEnv().providerSettings()) })
  return configLoader()
}

/** A test call ends by itself after this long, so a forgotten browser tab does not run up provider minutes. */
export const TEST_CALL_LIMIT_MS = 5 * 60_000

/** Deleting the room disconnects the browser; the session then closes and the call is finished as usual. */
function endTestCallLater(ctx: JobContext) {
  const timer = setTimeout(() => void ctx.deleteRoom().catch(() => {}), TEST_CALL_LIMIT_MS)
  timer.unref()
  ctx.addShutdownCallback(async () => clearTimeout(timer))
}

/** find_slots and book_appointment, only when the assistant has an appointment type and a calendar. */
// biome-ignore lint/suspicious/noExplicitAny: tools of different parameter types in one map
function bookingToolset(api: ApiClient, call: CallSession, log: CallLog): Record<string, llm.AnonFunctionTool<any, any, any>> {
  if (!call.booking) return {}
  const booking = bookingTools(api, call, log)
  const typeId = z.string().describe('The id of the appointment type, from the list in your instructions.')
  const calendarId = z.string().describe('The id of the calendar whose note fits the request, from the list in your instructions.')
  return {
    find_slots: llm.tool({
      description: 'Look up free times for an appointment in one calendar. Say a short filler like "Let me check the calendar" in the same response.',
      parameters: z.object({
        appointment_type_id: typeId,
        calendar_id: calendarId,
        from_date: z.string().nullish().describe('First day to look at, YYYY-MM-DD; omit for today.'),
        to_date: z.string().nullish().describe('Last day to look at, YYYY-MM-DD; omit to look ahead as far as possible.'),
      }),
      execute: args => booking.findSlots(args),
    }),
    book_appointment: llm.tool({
      description: 'Book a time the caller chose from find_slots. Only after the caller agreed to that exact time.',
      parameters: z.object({
        appointment_type_id: typeId,
        calendar_id: calendarId,
        start: z.string().describe('The exact start in brackets from find_slots.'),
        caller_name: z.string().describe("The caller's name."),
        reason: z.string().describe('One sentence: what the appointment is for.'),
        address: z.string().nullish().describe('Where the visit is, if it is on site.'),
        email: z.string().nullish().describe("The caller's email address, if they gave one: the confirmation goes there."),
      }),
      execute: args => booking.book(args),
    }),
    ...(call.booking.upcoming.length
      ? {
          cancel_appointment: llm.tool({
            description: "Cancel one of the caller's upcoming appointments listed in your instructions, after the caller confirmed which one.",
            parameters: z.object({ booking_id: z.string().describe('The booking id from your instructions.') }),
            execute: ({ booking_id }) => booking.cancel(booking_id),
          }),
          reschedule_appointment: llm.tool({
            description: "Move one of the caller's upcoming appointments to a time from find_slots the caller agreed to.",
            parameters: z.object({
              booking_id: z.string().describe('The booking id from your instructions.'),
              start: z.string().describe('The exact start in brackets from find_slots.'),
            }),
            execute: ({ booking_id, start }) => booking.reschedule(booking_id, start),
          }),
        }
      : {}),
  }
}

/** transfer_call, only when the assistant puts urgent calls through on this call and someone can be dialled. */
type Transfer = Omit<Parameters<typeof transferTool>[0], 'api' | 'call' | 'log'> | null

function assistantTools(api: ApiClient, call: CallSession, log: CallLog, endCall: () => void, transfer: Transfer) {
  const { callId, workspaceId } = call
  return {
    ...bookingToolset(api, call, log),
    ...(transfer ? { transfer_call: transferTool({ ...transfer, api, call, log }) } : {}),
    take_message: llm.tool({
      description: 'Save a message for the team. Use it whenever the caller wants a callback, a visit, a quote or anything you cannot do yourself.',
      parameters: z.object({ message: z.string().describe('One complete sentence: who wants what, and how to reach them.') }),
      execute: async ({ message }) => {
        await api.run(callTakeMessage, { callId, message }, workspaceId)
        log.messages.push(message)
        log.record('system', 'Took a message', callTakeMessage.name)
        return 'The message is saved. Tell the caller the team will get back to them.'
      },
    }),
    end_call: llm.tool({
      description: 'Hang up. Use it only after you and the caller have both said goodbye, in the same response as your goodbye.',
      // No result: the call ends after the goodbye has played, without another reply.
      execute: async () => {
        endCall()
        return undefined
      },
    }),
    flag_urgent: llm.tool({
      description: 'Flag this call as urgent. Use it for emergencies that need a person right away.',
      execute: async () => {
        await api.run(callFlagUrgent, { callId }, workspaceId)
        log.urgent = true
        log.record('system', 'Flagged as urgent', callFlagUrgent.name)
        return 'The call is flagged as urgent for the team. Take a message now; do not promise a response time.'
      },
    }),
  }
}

function recordConversation(session: voice.AgentSession, log: CallLog) {
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || !item.textContent) return
    if (item.role === 'user') log.record('caller', item.textContent)
    if (item.role === 'assistant') log.record('agent', item.textContent)
  })
}

/** Tools whose result the caller need not hear: no extra LLM round when the assistant already spoke. */
const QUIET_TOOLS = new Set(['take_message', 'flag_urgent', 'end_call'])

const greetingCache = createGreetingCache()

/**
 * Starts the greeting: the stored audio when there is some for this text and voice, else the voice
 * provider live, while the audio is made and stored for the next call.
 */
async function greet(session: voice.AgentSession, config: AgentConfig, call: CallSession, cached: Promise<Awaited<ReturnType<typeof greetingCache.get>>>, key: string) {
  const text = call.assistant?.greeting || FALLBACK_GREETING
  const audio = await cached
  if (audio) {
    session.say(text, { audio: audioStream(audio) })
    return 'cached'
  }
  session.say(text)
  void synthesize(createTts(config.tts, call.assistant?.voice), text)
    .then(synthesized => greetingCache.put(key, synthesized))
    .catch(e => console.warn(`could not store the greeting audio: ${e instanceof Error ? e.message : String(e)}`))
  return 'synthesized'
}

/**
 * Greets the caller and runs the conversation until the session closes. The session starts without
 * waiting for the caller: it links to them once they join (on a phone call they are there already),
 * and the greeting plays as soon as they hear the agent's audio. Transfer is added once it is known.
 */
async function converse(ctx: JobContext, callerJoined: Promise<RemoteParticipant>, api: ApiClient, config: AgentConfig, call: CallSession, log: CallLog, onClose: () => void, setup: SetupTimer, stopRecordingForTransfer: () => Promise<void>) {
  const key = greetingKey({
    provider: config.tts.provider, model: ttsModelOf(config.tts), voiceId: voiceFor(config.tts, call.assistant?.voice),
    text: call.assistant?.greeting || FALLBACK_GREETING,
  })
  const cachedGreeting = greetingCache.get(key) // read while the session starts
  let callerIdentity: string | undefined
  void callerJoined.then(caller => (callerIdentity = caller.identity), () => {})
  const session = new voice.AgentSession(createPipeline(config, call.assistant?.voice))
  const onSpeaking = ({ newState }: { newState: string }) => {
    if (newState !== 'speaking') return
    session.off(voice.AgentSessionEventTypes.AgentStateChanged, onSpeaking)
    setup.mark('greeting audio')
    setup.log(call.callId, ctx.room)
  }
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, onSpeaking)
  recordConversation(session, log)
  logTurnMetrics(session, call.callId)
  skipQuietToolReplies(session, QUIET_TOOLS)
  session.on(voice.AgentSessionEventTypes.Close, onClose)
  const endCall = () => hangUpAfterSpeech(speakingOf(session), () => void ctx.deleteRoom().catch(() => {}))
  const instructions = buildInstructions(call.assistant, call.businessHours, call.booking, false)
  const agent = new voice.Agent({ instructions, tools: assistantTools(api, call, log, endCall, null) })
  void warmUpLlm(config.llm, instructions)
  await session.start({
    agent,
    room: ctx.room,
    // Linked to the caller when known by now, else to the first participant that joins (only the caller does).
    inputOptions: { ...(callerIdentity ? { participantIdentity: callerIdentity } : {}), participantKinds: ALL_PARTICIPANT_KINDS, closeOnDisconnect: true },
  })
  setup.mark('session')
  setup.note(await greet(session, config, call, cachedGreeting, key))
  void addTransfer(agent, callerJoined, { ctx, api, call, config, log, endCall, stopRecording: stopRecordingForTransfer })
}

/** Gives the assistant transfer_call, and the instructions for it, once it is known that it can transfer now. */
async function addTransfer(
  agent: voice.Agent, callerJoined: Promise<RemoteParticipant>,
  { ctx, api, call, config, log, endCall, stopRecording }: { ctx: JobContext; api: ApiClient; call: CallSession; config: AgentConfig; log: CallLog; endCall: () => void; stopRecording: () => Promise<void> },
) {
  try {
    const caller = await callerJoined
    const transfer = await transferFor(ctx, api, call, config, caller.identity, stopRecording)
    if (!transfer) return
    await agent.updateInstructions(buildInstructions(call.assistant, call.businessHours, call.booking, true))
    await agent.updateTools(assistantTools(api, call, log, endCall, transfer))
  } catch (e) {
    console.warn(`call ${call.callId} goes on without transfer: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** What transfer_call needs on this call, or null when the assistant does not transfer now (off, closed, nobody to dial). */
async function transferFor(ctx: JobContext, api: ApiClient, call: CallSession, config: AgentConfig, callerIdentity: string, stopRecording: () => Promise<void>): Promise<Transfer> {
  const number = transferNumberFor(call.assistant, call.businessHours)
  if (!number) return null
  const dialer = await onCallDialerFor(call, number, config, api)
  return dialer ? { ctx, config, callerIdentity, number, dialer, stopRecording } : null
}

/** Times from the job's start to each setup step, logged once per call with the wall-clock start. */
type SetupTimer = ReturnType<typeof setupTimer>
function setupTimer(startedAt = Date.now()) {
  const steps: Record<string, number> = {}
  let detail = ''
  return {
    mark(step: string) {
      steps[step] = Date.now() - startedAt
    },
    note(text: string) {
      detail = text
    },
    /** Logs the timings and publishes them on the agent's participant, where the call test reads them. */
    log(callId: string, room?: JobContext['room']) {
      const marks = Object.entries(steps).map(([step, ms]) => `${step} +${ms} ms`)
      console.log(`setup ${callId}: job started ${new Date(startedAt).toISOString()}, ${marks.join(', ')}${detail ? ` (greeting ${detail})` : ''}`)
      const setup: AgentSetup = { steps, greeting: detail }
      void room?.localParticipant?.setAttributes({ [SETUP_ATTRIBUTE]: JSON.stringify(setup) }).catch(() => {})
    },
  }
}

async function entry(ctx: JobContext) {
  const setup = setupTimer()
  // A room the call-test command dialled out of: this agent plays the caller, not the business.
  const testCaller = parseTestCallerMetadata(ctx.job.metadata)
  if (testCaller) {
    await ctx.connect()
    return runAsTestCaller(ctx, testCaller)
  }
  const api = apiClientFromEnv()
  // The call is registered while the agent joins the room when its origin is known already;
  // a failure there is not final: it is registered again the normal way after joining.
  const early = registerEarly(ctx, api)
  await ctx.connect()
  setup.mark('connected')
  // Checked at every call: until the providers are configured the call is logged as missed and ended.
  // Started now, so the config lookup overlaps with waiting for the caller and registering the call.
  const ready = checkReadiness(loadAgentConfig)
  // A test call's caller may be our own test-caller agent (no-phone call test), which LiveKit's own wait skips.
  // Nothing below waits for the caller, unless the call could not be registered without them.
  const isTest = parseTestMetadata(ctx.job.metadata) !== null
  const callerJoined = (isTest ? waitForCounterpart(ctx) : ctx.waitForParticipant()).then(caller => {
    setup.mark('caller')
    return caller
  })
  callerJoined.catch(() => {}) // a caller who never comes: the session closes with the room; awaited below where needed
  const call = (await early) ?? (await startCall(api, callOrigin(ctx.job.metadata, (await callerJoined).attributes, ctx.room.name ?? '')))
  setup.mark('registered')
  if (call.blocked) {
    await ctx.deleteRoom() // blocked caller: the API already filed the call in Spam
    return ctx.shutdown('blocked caller')
  }
  const readiness = await ready
  if (!readiness.ready) {
    await declineCall(call, readiness, () => ctx.deleteRoom())
    return ctx.shutdown('assistant not set up')
  }
  setup.mark('providers')
  const { config } = readiness
  const log = new CallLog(call)

  // From here on the call exists and must be finished: on hang-up (session close), on any error
  // while setting up the conversation, and at job shutdown as the last resort.
  const recorder = livekitRecorder(config.recording)
  const recording = startRecording(recorder, call, ctx.room.name ?? call.callId)
  // Stopped at hang-up, or earlier when a warm transfer connects (the on-call conversation is not recorded).
  const stopCallRecording = async () => stopRecording(recorder, await recording) // at hang-up
  // A transfer only goes ahead when the recording really stopped.
  const stopRecordingForTransfer = async () => stopRecordingOrThrow(recorder, await recording)
  const finish = () => hangUp({
    stopRecording: stopCallRecording,
    finishCall: () => finishCall(call, log, summaryLlm(config)),
    saveRecording: async () => saveRecording(api, call, recorder, await recording, RECORDING_WAIT_MS),
  })
  const finishOnce = once(finish, `could not finish call ${call.callId}`)
  ctx.addShutdownCallback(finishOnce)
  try {
    await converse(ctx, callerJoined, api, config, call, log, finishOnce, setup, stopRecordingForTransfer)
    if (isTest) endTestCallLater(ctx)
  } catch (e) {
    await finishOnce()
    throw e
  }
}

/** call.start for an origin known before joining; null when it is not known or the request failed. */
async function registerEarly(ctx: JobContext, api: ApiClient): Promise<CallSession | null> {
  try {
    const origin = await earlyOrigin(ctx.job.metadata, ctx.job.room?.name ?? '', livekitParticipants())
    return origin ? await startCall(api, origin) : null
  } catch (e) {
    console.warn(`call could not be registered before joining, trying after: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

async function runAsTestCaller(ctx: JobContext, scenario: TestCallerMetadata) {
  const readiness = await checkReadiness(loadAgentConfig)
  if (!readiness.ready) {
    console.error(`test caller cannot call: ${readiness.reason}`)
    return ctx.deleteRoom()
  }
  await runTestCaller(ctx, scenario, readiness.config)
}

export default defineAgent({
  entry,
})

/**
 * A self-hosted stack starts the agent with everything else. Until it is configured it waits
 * instead of exiting, so the container stays up; it takes calls after a restart with the settings.
 */
function idle(reason: string) {
  console.log(`Voice agent is idle: ${reason} Calls are not answered until this is set and the agent is restarted.`)
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
  setInterval(() => {}, 2 ** 30)
}

async function main() {
  try {
    // The worker cannot run without LiveKit and the API; it can run without speech and LLM keys.
    requireEnv(['AGENT_API_TOKEN'])
    if (process.env.AGENT_API_TOKEN === 'change-me') throw new Error('AGENT_API_TOKEN is still the placeholder from .env.example.')
    requireLivekitEnv()
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    if (process.env.NODE_ENV === 'production') return idle(reason)
    console.error(reason)
    process.exit(1)
  }
  const readiness = await checkReadiness(loadAgentConfig)
  console.log(describeReadiness(readiness))
  console.log(describeRecording(readiness.ready ? readiness.config.recording : resolveRecording(null)))
  // Processes kept warm for the next call. Three by default: a call takes one, and a phone call test two
  // (the test caller and the business), while the next one starts (a new process needs ~2 s of CPU).
  const numIdleProcesses = Number(process.env.AGENT_IDLE_PROCESSES) || 3
  // How long a new process may take to load the agent. Under a running call on a small box this takes
  // well over the library's 10 s, and a process that times out is killed and started again in a loop.
  const initializeProcessTimeout = Number(process.env.AGENT_INIT_TIMEOUT_MS) || 60_000
  // LiveKit stops giving a worker jobs above this CPU load (0.7 by default in production). On a small
  // single-box install that refuses calls, and the second job of a call test, while one call runs.
  const loadThreshold = Number(process.env.AGENT_LOAD_THRESHOLD) || 0.95
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME, numIdleProcesses, loadThreshold, initializeProcessTimeout }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
