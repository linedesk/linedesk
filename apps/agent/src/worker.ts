// The voice agent: a LiveKit Agents worker. One job per call room; all writes go through the API.
// Which speech and language vendors are used is decided in pipeline.ts.
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { agentTokenProblem, ASSISTANT_CALL_MAX_MINUTES, callFlagUrgent, callStartRecording, callTakeMessage, mainLanguageOf, otherLanguagesOf, spokenLines } from '@linedesk/actions'
import { lookUpPassages } from './look-up.ts'
import { cli, defineAgent, llm, ServerOptions, voice, type JobContext } from '@livekit/agents'
import type { RemoteParticipant } from '@livekit/rtc-node'
import { z } from 'zod'
import { apiClientFromEnv, type ApiClient } from './api-client.ts'
import { bookingTools } from './booking-tools.ts'
import { type CollectContext, collectTools } from './collect/collect-tools.ts'
import { partialPhoneNumberIn } from './collect/collectors.ts'
import { activeMenu, runKeypadMenu } from './keypad-menu.ts'
import { CallLog, finishCall, hangUp, once, RECORDING_WAIT_MS } from './call-log.ts'
import { callOrigin, parseTestMetadata, startCall, type CallSession } from './call-session.ts'
import { earlyOrigin, livekitParticipants } from './early-origin.ts'
import { createConfigLoader, parseProviderSettings, type AgentConfig } from './config.ts'
import { AGENT_NAME, requireLivekitEnv } from './env.ts'
import { checkReadiness, declineCall, describeReadiness, type Readiness } from './not-ready.ts'
import { createPipeline, createTts, greetingVoice, summaryLlm, warmUpLlm } from './pipeline.ts'
import { audioStream, createGreetingCache, greetingKey, synthesize } from './greeting-cache.ts'
import { logTurnMetrics } from './turn-metrics.ts'
import { followCallerLanguage } from './caller-language.ts'
import { skipQuietToolReplies } from './tool-replies.ts'
import { hangUpAfterLine, hangUpAfterSpeech, hangUpAtCallLimit, remindOnSilence, silencePolicyOf, speakingOf } from './hang-up.ts'
import { playLine, unansweredLine } from './busy-line.ts'
import { promisesUrgent, urgentFlagger } from './urgent-promise.ts'
import { buildInstructions, canChangeBookings, collectLanguageRule } from './prompt.ts'
import { describeRecording, livekitRecorder, resolveRecording, saveRecording, startRecording, stopRecording, stopRecordingOrThrow } from './recording.ts'
import { ALL_PARTICIPANT_KINDS, waitForCounterpart } from './counterpart.ts'
import { runTestCaller } from './test-caller/caller.ts'
import { type Dialable, transferContactsFor } from './transfer.ts'
import { watchTakeOver } from './take-over.ts'
import { onCallDialerFor, type Reachable, transferTool } from './transfer-tool.ts'
import { parseTestCallerMetadata, type TestCallerMetadata } from './test-caller/scenarios.ts'
import { type OnCallResponderMetadata, parseOnCallResponderMetadata, runOnCallResponder } from './oncall-responder.ts'
import { type AgentSetup, SETUP_ATTRIBUTE } from './test-caller/latency.ts'

let configLoader: (() => Promise<AgentConfig>) | undefined
/** The effective provider config: Linedesk's provider settings first, the environment as fallback, cached briefly per process. */
function loadAgentConfig(): Promise<AgentConfig> {
  configLoader ??= createConfigLoader({ fetchSettings: async () => parseProviderSettings(await apiClientFromEnv().providerSettings()) })
  return configLoader()
}

/** A test call ends by itself after this long, so a forgotten browser tab does not run up provider minutes. */
export const TEST_CALL_LIMIT_MS = 5 * 60_000


/** find_slots and book_appointment, only when the assistant has an appointment type and a calendar. */
// biome-ignore lint/suspicious/noExplicitAny: tools of different parameter types in one map
function bookingToolset(api: ApiClient, call: CallSession, log: CallLog): Record<string, llm.AnonFunctionTool<any, any, any>> {
  if (!call.booking) return {}
  const booking = bookingTools(api, call, log)
  const typeId = z.string().describe('The id of the appointment type whose "Use when" condition fits the request, from the list in your instructions.')
  const calendarId = z.string().describe('The id of the calendar whose "Use when" condition fits the request, from the list in your instructions.')
  const bookingDate = z.string().describe('The day of the appointment the caller wants to change, YYYY-MM-DD, as the caller said it.')
  const bookedName = z.string().describe('The full name the appointment is booked under, as the caller said it.')
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
        caller_name: z.string().nullish().describe("The caller's name; needed when the appointment type asks for it."),
        reason: z.string().describe('One sentence: what the appointment is for.'),
        address: z.string().nullish().describe('Where the visit is, if it is on site.'),
        email: z.string().nullish().describe("The caller's email address, if they gave one: the confirmation goes there."),
      }),
      // The name the caller confirmed letter by letter wins over the model's spelling of it.
      execute: args => booking.book({ ...args, caller_name: log.confirmedName ?? args.caller_name }),
    }),
    ...(canChangeBookings(call.booking)
      ? {
          cancel_appointment: llm.tool({
            description: 'Cancel an appointment of the caller, described by the day it is on and the name it is booked under, as the caller said them.',
            parameters: z.object({ booking_date: bookingDate, booked_name: bookedName }),
            execute: args => booking.cancel(args),
          }),
          reschedule_appointment: llm.tool({
            description: 'Move an appointment of the caller, described by its day and name as the caller said them, to a time from find_slots the caller agreed to.',
            parameters: z.object({
              booking_date: bookingDate,
              booked_name: bookedName,
              appointment_type_id: typeId,
              calendar_id: calendarId.describe('The calendar id you used for find_slots.'),
              start: z.string().describe('The exact new start in brackets from find_slots.'),
            }),
            execute: ({ start, appointment_type_id, calendar_id, ...which }) => booking.reschedule(which, start, { appointment_type_id, calendar_id }),
          }),
        }
      : {}),
  }
}

/** transfer_call, only when the assistant has transfer contacts on this call and someone can be dialled. */
type Transfer = Omit<Parameters<typeof transferTool>[0], 'api' | 'call' | 'log'> | null

function assistantTools(api: ApiClient, call: CallSession, log: CallLog, endCall: () => void, flagUrgent: () => Promise<void>, transfer: Transfer, collect: CollectContext) {
  const { callId } = call
  return {
    ...bookingToolset(api, call, log),
    ...(call.documents?.lookUp
      ? {
          look_up: llm.tool({
            description: "Search the business's reference documents for what the caller asked. Say a short filler like \"Let me check\" in the same response.",
            parameters: z.object({ query: z.string().describe('A few keywords from the question, like "warranty water heater".') }),
            execute: ({ query }) => lookUpPassages(api, call, log, query),
          }),
        }
      : {}),
    ...collectTools(collect),
    ...(transfer ? { transfer_call: transferTool({ ...transfer, api, call, log }) } : {}),
    take_message: llm.tool({
      description: 'Save a message for the team. Use it whenever the caller wants a callback, a visit, a quote or anything you cannot do yourself.',
      parameters: z.object({ message: z.string().describe('One complete sentence: who wants what. Add a callback number only if the caller gave one that is not their caller ID.') }),
      execute: async ({ message }) => {
        // A number the caller said can come out garbled ("503 551 42"): only a whole one is saved.
        const partial = partialPhoneNumberIn(message)
        if (partial) return `"${partial}" is not a complete phone number. Get the callback number with get_phone_number first, then call take_message again with the confirmed number.`
        await api.run(callTakeMessage, { callId, message }, call)
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
      description: 'Flag this call as urgent. Use it for emergencies that need a person right away. Whenever you tell the caller you are flagging or marking the call as urgent, call this in that same response; never say it without calling it.',
      execute: async () => {
        await flagUrgent()
        return 'The call is flagged as urgent for the team. Take a message now; do not promise a response time.'
      },
    }),
  }
}

/** Flags the call once, from the tool or from the guard below. */
function callFlagger(api: ApiClient, call: CallSession, log: CallLog) {
  return urgentFlagger(async () => {
    await api.run(callFlagUrgent, { callId: call.callId }, call)
    log.urgent = true
    log.record('system', 'Flagged as urgent', callFlagUrgent.name)
  })
}

/** When the assistant has said the call is flagged as urgent, it is: flag it if the model left out flag_urgent. */
function keepUrgentPromises(session: voice.AgentSession, flagUrgent: () => Promise<void>, callId: string) {
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || item.role !== 'assistant' || !item.textContent || !promisesUrgent(item.textContent)) return
    flagUrgent().catch(e => console.error(`call ${callId}: could not flag as urgent: ${e instanceof Error ? e.message : String(e)}`))
  })
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

/** What the assistant opens the call with: its greeting, else the fallback in its main language. */
const openingOf = (call: CallSession) => call.assistant?.greeting || spokenLines(mainLanguageOf(call.assistant?.languages)).fallbackGreeting

/**
 * Starts the greeting: the stored audio when there is some for this text and voice, else the voice
 * provider live, while the audio is made and stored for the next call.
 */
async function greet(session: voice.AgentSession, config: AgentConfig, call: CallSession, cached: Promise<Awaited<ReturnType<typeof greetingCache.get>>>, key: string) {
  const text = openingOf(call)
  // A greeting with the caller's name is said live and never stored: it is theirs alone.
  if (call.caller?.greetedByName) {
    session.say(text)
    return 'personal'
  }
  const audio = await cached
  if (audio) {
    session.say(text, { audio: audioStream(audio) })
    return 'cached'
  }
  session.say(text)
  void synthesize(createTts(config.tts, call.assistant?.voice, mainLanguageOf(call.assistant?.languages)), text)
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
    ...greetingVoice(config, call), text: openingOf(call),
  })
  const cachedGreeting = call.caller?.greetedByName ? Promise.resolve(null) : greetingCache.get(key) // read while the session starts
  let callerIdentity: string | undefined
  void callerJoined.then(caller => (callerIdentity = caller.identity), () => {})
  const silence = silencePolicyOf(call.assistant)
  const languages = { main: mainLanguageOf(call.assistant?.languages), others: otherLanguagesOf(call.assistant?.languages) }
  const pipeline = createPipeline(config, call.assistant?.voice, silence.firstGapS, languages)
  const session = new voice.AgentSession(pipeline)
  // Fixed lines during the call are in the language spoken now: the main one until the caller switches.
  const spokenNow = followCallerLanguage(session, pipeline.tts, languages, call.callId)
  const lines = () => spokenLines(spokenNow())
  const onSpeaking = ({ newState }: { newState: string }) => {
    if (newState !== 'speaking') return
    session.off(voice.AgentSessionEventTypes.AgentStateChanged, onSpeaking)
    setup.mark('greeting audio')
    setup.log(call.callId, ctx.room)
  }
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, onSpeaking)
  recordConversation(session, log)
  const flagUrgent = callFlagger(api, call, log)
  keepUrgentPromises(session, flagUrgent, call.callId)
  logTurnMetrics(session, call.callId)
  skipQuietToolReplies(session, QUIET_TOOLS, lines)
  session.on(voice.AgentSessionEventTypes.Close, onClose)
  const deleteRoom = () => void ctx.deleteRoom().catch(() => {})
  // The assistant always says something before the call ends: its goodbye (else the goodbye line in the language spoken), the closing line
  // after silence, or the goodbye at its time limit.
  const sayLine = (text: string) => session.say(text, { allowInterruptions: false }).waitForPlayout()
  const speaking = speakingOf(session)
  const endCall = () => hangUpAfterSpeech(speaking, deleteRoom, () => sayLine(lines().goodbye))
  // After a warm transfer or a take-over the caller talks with a person and the assistant is out of it: neither silence on its
  // side nor its time limit ends that call (the trunk's CALL_MAX_MINUTES does).
  const transferred = () => log.transferred
  remindOnSilence(session, silence, {
    remind: () => void session.say(lines().stillThere),
    close: () => {
      log.record('system', 'Hung up after silence on the line')
      hangUpAfterLine(sayLine(silence.closing), deleteRoom)
    },
    transferred,
  })
  // A test call from the web app ends sooner, so a forgotten browser tab does not run up provider minutes.
  const isTest = call.businessNumber === null
  const limitMinutes = isTest ? TEST_CALL_LIMIT_MS / 60_000 : ASSISTANT_CALL_MAX_MINUTES
  const cancelLimit = hangUpAtCallLimit(limitMinutes * 60_000, {
    transferred,
    goodbye: () => {
      log.record('system', `Call ended after ${limitMinutes} minutes`)
      hangUpAfterLine(sayLine(isTest ? lines().testCallLimit : lines().callLimit), deleteRoom)
    },
  })
  session.on(voice.AgentSessionEventTypes.Close, cancelLimit)
  const instructions = buildInstructions(call.assistant, call.businessHours, call.booking, [], call.caller, call.documents)
  const collect: CollectContext = {
    log,
    room: ctx.room,
    callerIdentity: () => callerIdentity,
    today: () => call.booking?.todayDate ?? new Date().toISOString().slice(0, 10),
    languageRule: collectLanguageRule(call.assistant) ?? undefined,
  }
  const agent = new voice.Agent({ instructions, tools: assistantTools(api, call, log, endCall, flagUrgent, null, collect) })
  void warmUpLlm(config.llm, instructions)
  await session.start({
    agent,
    room: ctx.room,
    // Linked to the caller when known by now, else to the first participant that joins (only the caller does).
    inputOptions: { ...(callerIdentity ? { participantIdentity: callerIdentity } : {}), participantKinds: ALL_PARTICIPANT_KINDS, closeOnDisconnect: true },
  })
  setup.mark('session')
  // A member can take the call over from the web app at any point now (call.takeOver).
  const stopWatching = watchTakeOver({ room: ctx.room, session, log, stopRecording: stopRecordingForTransfer, sayLine, endCall: deleteRoom })
  session.on(voice.AgentSessionEventTypes.Close, stopWatching)
  setup.note(await greet(session, config, call, cachedGreeting, key))
  let transferOn = false
  void addTransfer(agent, callerJoined, { ctx, api, call, config, log, endCall, flagUrgent, collect, stopRecording: stopRecordingForTransfer }).then(on => {
    transferOn = on
  })
  const menu = activeMenu(call.assistant)
  if (menu)
    void runKeypadMenu({
      session, room: ctx.room, menu, callerIdentity: () => callerIdentity, canTransfer: () => transferOn,
      record: event => log.record('system', event),
      lines: spokenLines(languages.main),
    }).catch(e => console.warn(`keypad menu on call ${call.callId}: ${e instanceof Error ? e.message : String(e)}`))
}

/** Gives the assistant transfer_call, and the instructions for it, once it is known that it can transfer now; true when it did. */
async function addTransfer(
  agent: voice.Agent, callerJoined: Promise<RemoteParticipant>,
  { ctx, api, call, config, log, endCall, flagUrgent, collect, stopRecording }: { ctx: JobContext; api: ApiClient; call: CallSession; config: AgentConfig; log: CallLog; endCall: () => void; flagUrgent: () => Promise<void>; collect: CollectContext; stopRecording: () => Promise<void> },
): Promise<boolean> {
  try {
    const caller = await callerJoined
    const transfer = await transferFor(ctx, api, call, config, caller.identity, stopRecording)
    if (!transfer) return false
    await agent.updateInstructions(buildInstructions(call.assistant, call.businessHours, call.booking, transfer.contacts.map(c => c.contact), call.caller, call.documents))
    await agent.updateTools(assistantTools(api, call, log, endCall, flagUrgent, transfer, collect))
    return true
  } catch (e) {
    console.warn(`call ${call.callId} goes on without transfer: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** What transfer_call needs on this call, or null when the assistant does not transfer now (no contact, closed, nobody to dial). */
async function transferFor(ctx: JobContext, api: ApiClient, call: CallSession, config: AgentConfig, callerIdentity: string, stopRecording: () => Promise<void>): Promise<Transfer> {
  const reachable = await Promise.all(
    transferContactsFor(call.assistant, call.businessHours).map(async (contact: Dialable): Promise<Reachable | null> => {
      const dialer = await onCallDialerFor(call, contact.number, config, api)
      return dialer ? { contact, dialer } : null
    }),
  )
  const contacts = reachable.filter((r): r is Reachable => r !== null)
  return contacts.length ? { ctx, config, callerIdentity, contacts, stopRecording } : null
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
  // A call to the test on-call number (live warm-transfer test): this agent plays the on-call person.
  const responder = parseOnCallResponderMetadata(ctx.job.metadata)
  if (responder) {
    await ctx.connect()
    return runAsOnCallResponder(ctx, responder)
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
    // The API already filed the call: in Spam (blocked caller) or as missed with a callback (busy, over the spending
    // cap). Each caller hears one line first, once the voice is set up.
    await tellCaller(ctx, call, unansweredLine(call), ready, callerJoined)
    await ctx.deleteRoom()
    return ctx.shutdown(call.overCap ? 'workspace over its monthly spending cap' : call.busy ? 'too many calls at once in the workspace' : 'blocked caller')
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
  const recorder = livekitRecorder(config.recording, process.env, async () =>
    (await api.run(callStartRecording, { callId: call.callId }, call)).data!.egressId as string)
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
  } catch (e) {
    await finishOnce()
    throw e
  }
}

/** How long an unanswered call waits for the caller to be in the room before it hangs up without the line. */
const BUSY_CALLER_WAIT_MS = 5000

/** Plays `line` to the caller once they are in the room; nothing when the voice is not set up. */
async function tellCaller(ctx: JobContext, call: CallSession, line: string, ready: Promise<Readiness>, callerJoined: Promise<RemoteParticipant>) {
  const readiness = await ready
  if (!readiness.ready) return
  const joined = await Promise.race([callerJoined.then(() => true, () => false), sleep(BUSY_CALLER_WAIT_MS).then(() => false)])
  if (joined) await playLine(ctx.room, readiness.config, call, line)
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

async function runAsOnCallResponder(ctx: JobContext, responder: OnCallResponderMetadata) {
  const readiness = await checkReadiness(loadAgentConfig)
  if (!readiness.ready) {
    console.error(`on-call responder cannot answer: ${readiness.reason}`)
    return ctx.deleteRoom()
  }
  await runOnCallResponder(ctx, responder, readiness.config)
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
  // Healthy on the worker's health port (8081), so an update (scripts/deploy.sh) does not wait for a
  // registration that never comes: an idle agent takes no calls, so replacing it loses none.
  createServer((_req, res) => res.end('idle')).listen(8081)
}

async function main() {
  try {
    // The worker cannot run without LiveKit and the API; it can run without speech and LLM keys.
    const tokenProblem = agentTokenProblem(process.env.AGENT_API_TOKEN, { production: process.env.NODE_ENV === 'production' })
    if (tokenProblem) throw new Error(tokenProblem)
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
