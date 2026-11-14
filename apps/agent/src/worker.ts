// The voice agent: a LiveKit Agents worker. One job per call room; all writes go through the API.
// Which speech and language vendors are used is decided in pipeline.ts.
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { agentTokenProblem, VOICE_FAILURE_ATTRIBUTE, type VoiceFailure, voiceProviderLabel, voiceStageNames, ASSISTANT_CALL_MAX_MINUTES, CALL_MAX_MINUTES, callFlagUrgent, callStartRecording, callTakeMessage, fillTemplate, mainLanguageOf, otherLanguagesOf, spokenLines, templateNames } from '@linedesk/actions'
import type { CallerDetails } from '@linedesk/db/types'
import { cli, defineAgent, llm, ServerOptions, voice, type JobContext } from '@livekit/agents'
import type { RemoteParticipant, Room } from '@livekit/rtc-node'
import { z } from 'zod'
import { apiClientFromEnv, type ApiClient } from './api-client.ts'
import { bookingTools } from './booking-tools.ts'
import { type CollectContext, collectTools, nudgeIfQuiet, stepFacts } from './collect/collect-tools.ts'
import { partialPhoneNumberIn } from './collect/collectors.ts'
import { callerIdOf, withCallbackNumber } from './callback-number.ts'
import { CallLog, finishCall, hangUp, once, RECORDING_WAIT_MS } from './call-log.ts'
import { onceEachStage, watchVoicePipeline } from './voice-failures.ts'
import { GREETING_WAIT_MS, lookUpCaller, within } from './caller-lookup.ts'
import { lookupTools } from './lookup-tools.ts'
import { callOrigin, parseTestMetadata, startCall, type CallSession } from './call-session.ts'
import { earlyOrigin, livekitParticipants } from './early-origin.ts'
import { type AgentConfig, type CallConfig, configForAssistant, createConfigLoader, isRealtime, parseProviderSettings, SETTINGS_TTL_MS, stagesOf, withRealtimeModel } from './config.ts'
import { AGENT_NAME, requireLivekitEnv } from './env.ts'
import { checkReadiness, declineCall, describeReadiness, type Readiness } from './not-ready.ts'
import { type CallLanguages, createPipeline, createRealtimePipeline, createTts, greetingVoice, type LineVoice, lineVoiceOf, realtimeLine, spokeWithBackup, ttsFor, realtimeRepliesEvent, type RealtimeEvents, summaryLlm, transferSpeechOf, talkingSpeedOf, warmUpLlm, REALTIME_TURNS } from './pipeline.ts'
import { audioStream, createGreetingCache, greetingKey, synthesize } from './greeting-cache.ts'
import { cascadedReplyTimer, logTurnMetrics } from './turn-metrics.ts'
import { describeRealtimeReply, realtimeTurnTimer } from './realtime-timing.ts'
import { describeRealtimeUsage, type RealtimeUsageMetrics, realtimeUsageCounter } from './realtime-usage.ts'
import { followCallerLanguage } from './caller-language.ts'
import { MESSAGE_SAVED_RESULT, skipQuietToolReplies } from './tool-replies.ts'
import { END_CALL_RESULT, greetingPlayed, hangUpAfterGoodbye, hangUpAfterLine, hangUpAtCallLimit, nextReplyOf, type Reply, remindOnSilence, saidWords, skipSecondGoodbye, silencePolicyOf, announcesHangUp, withoutEndCall, writesEndCall } from './hang-up.ts'
import { lineAudio, playLine, unansweredLine } from './busy-line.ts'
import { realtimeLineSpeaker, type SayFixedLine } from './realtime-lines.ts'
import { promisesUrgent, urgentFlagger } from './urgent-promise.ts'
import { buildInstructions, canChangeBookings, collectLanguageRule } from './prompt.ts'
import { describeRecording, livekitRecorder, resolveRecording, saveRecording, startRecording, stopRecording, stopRecordingOrThrow } from './recording.ts'
import { ALL_PARTICIPANT_KINDS, waitForCounterpart } from './counterpart.ts'
import { runTestCaller } from './test-caller/caller.ts'
import { type Dialable, transferContactsFor } from './transfer.ts'
import { watchTakeOver } from './take-over.ts'
import { onCallDialerFor, transferTool } from './transfer-tool.ts'
import { parseTestCallerMetadata, type TestCallerMetadata } from './test-caller/scenarios.ts'
import { type OnCallResponderMetadata, parseOnCallResponderMetadata, runOnCallResponder } from './oncall-responder.ts'
import { type AgentSetup, SETUP_ATTRIBUTE } from './test-caller/latency.ts'

let configLoader: (() => Promise<CallConfig>) | undefined
/** The effective provider config: Linedesk's provider settings first, the environment as fallback, cached briefly per process. */
function loadAgentConfig(): Promise<CallConfig> {
  configLoader ??= createConfigLoader({ fetchSettings: async () => parseProviderSettings(await apiClientFromEnv().providerSettings()) })
  return configLoader()
}

/** A test call ends by itself after this long, so a forgotten browser tab does not run up provider minutes. */
export const TEST_CALL_LIMIT_MS = 5 * 60_000


/** A booking tool's result; the assistant is asked to go on when its reply to it comes back empty (as after a collection step). */
async function nudged(opts: llm.ToolOptions, result: Promise<string>): Promise<string> {
  const text = await result
  nudgeIfQuiet(opts.ctx.session)
  return text
}

/** find_slots and book_appointment, only when the assistant has an appointment type and a calendar. */
// biome-ignore lint/suspicious/noExplicitAny: tools of different parameter types in one map
function bookingToolset(api: ApiClient, call: CallSession, log: CallLog): Record<string, llm.AnonFunctionTool<any, any, any>> {
  if (!call.booking) return {}
  const booking = bookingTools(api, call, log)
  const typeId = z.string().describe('The id of the appointment type whose "Use when" condition fits the request, from the list in your instructions.')
  const calendarId = z.string().nullish().describe('The id of the calendar whose "use when" fits the request, from the list in your instructions; leave it out when no calendars are listed.')
  const bookingDate = z.string().describe('The day of the appointment the caller wants to change, as the caller said it, in English ("Tuesday", "the 17th", "November 17") or YYYY-MM-DD.')
  return {
    find_slots: llm.tool({
      description: 'Look up free times for an appointment in one calendar. Say a short filler like "Let me check the calendar" in the same response.',
      parameters: z.object({
        appointment_type_id: typeId,
        calendar_id: calendarId,
        from_date: z.string().nullish().describe('First day to look at, as the caller said it, in English ("tomorrow", "Wednesday", "next week", "the 17th", "November 17") or YYYY-MM-DD; omit for today.'),
        to_date: z.string().nullish().describe('Last day to look at, said the same way ("Friday", "next week" for its Sunday); omit to look ahead as far as possible.'),
      }),
      execute: (args, opts) => nudged(opts, booking.findSlots(args)),
    }),
    book_appointment: llm.tool({
      description: 'Book a time the caller chose from find_slots. Only after the caller said yes to that exact time; never a time you picked for them without their yes.',
      parameters: z.object({
        appointment_type_id: typeId,
        calendar_id: calendarId,
        start: z.string().describe('The key in brackets of the chosen time from find_slots, like s3.'),
        caller_name: z.string().nullish().describe("The caller's name; needed when the appointment type asks for it."),
        reason: z.string().describe('One sentence: what the appointment is for.'),
        address: z.string().nullish().describe('Where the visit is, if it is on site.'),
        email: z.string().nullish().describe("The caller's email address, if they gave one: the confirmation goes there."),
      }),
      // The name the caller confirmed letter by letter wins over the model's spelling of it.
      execute: (args, opts) => nudged(opts, booking.book({ ...args, caller_name: log.confirmedName ?? args.caller_name })),
    }),
    ...(canChangeBookings(call.booking)
      ? {
          cancel_appointment: llm.tool({
            description: 'Cancel an appointment of the caller, described by the day it is on. It goes by the name the caller confirmed with get_name: get that first.',
            parameters: z.object({ booking_date: bookingDate }),
            execute: (args, opts) => nudged(opts, booking.cancel(args)),
          }),
          reschedule_appointment: llm.tool({
            description: 'Move an appointment of the caller, described by its day, to a time from find_slots the caller agreed to. It goes by the name the caller confirmed with get_name: get that first.',
            parameters: z.object({
              booking_date: bookingDate,
              appointment_type_id: typeId,
              calendar_id: calendarId.describe('The calendar id you used for find_slots.'),
              start: z.string().describe('The key in brackets of the new time from find_slots, like s3.'),
            }),
            execute: ({ start, appointment_type_id, calendar_id, ...which }, opts) => nudged(opts, booking.reschedule(which, start, { appointment_type_id, calendar_id })),
          }),
        }
      : {}),
  }
}

/** transfer_call, when the assistant has transfer contacts that take calls now; given from the start of the call. */
type Transfer = Omit<Parameters<typeof transferTool>[0], 'api' | 'call' | 'log'> | null

function assistantTools(api: ApiClient, call: CallSession, log: CallLog, endCall: (toolReply: Reply) => void, flagUrgent: () => Promise<void>, transfer: Transfer, collect: CollectContext) {
  const { callId } = call
  const callerId = callerIdOf(call)
  return {
    ...bookingToolset(api, call, log),
    ...collectTools(collect),
    ...(transfer ? { transfer_call: transferTool({ ...transfer, api, call, log }) } : {}),
    ...lookupTools(api, call, log),
    take_message: llm.tool({
      description: 'Save a message for the team. Use it whenever the caller wants a callback, a visit, a quote or anything you cannot do yourself.',
      parameters: z.object({
        message: z
          .string()
          .describe(
            callerId
              ? "One complete sentence: who wants what. Leave out the caller's number: caller ID is saved as the callback number by itself. Add another number only once get_phone_number confirmed it."
              : 'One complete sentence: who wants what, with the callback number confirmed with get_phone_number.',
          ),
      }),
      execute: async ({ message: said }) => {
        // A number the caller said can come out garbled ("503 551 42"): only a whole one is saved.
        const partial = partialPhoneNumberIn(said)
        if (partial) return `"${partial}" is not a complete phone number. Get the callback number with get_phone_number first, then call take_message again with the confirmed number.`
        // With caller ID that is the callback number; another one only as get_phone_number confirmed it.
        const checked = withCallbackNumber(said, callerId, { confirmed: log.confirmedNumbers, saved: log.messages })
        if ('refusal' in checked) return checked.refusal
        const message = checked.text
        await api.run(callTakeMessage, { callId, message }, call)
        log.messages.push(message)
        log.record('system', 'Took a message', callTakeMessage.name)
        return MESSAGE_SAVED_RESULT
      },
    }),
    end_call: llm.tool({
      description:
        'Hang up: when the caller said they need nothing else, or said goodbye. Call it without saying anything first; you say your goodbye right after it.',
      // The goodbye is the reply to this result; the call ends once it has played (hangUpAfterGoodbye).
      execute: async (_, { ctx }) => {
        endCall(ctx.speechHandle)
        return END_CALL_RESULT
      },
    }),
    flag_urgent: llm.tool({
      description: 'Flag this call as urgent. Use it when the call is urgent by what the business wants you to know, or when the caller says it is urgent. Whenever you tell the caller you are flagging or marking the call as urgent, call this in that same response; never say it without calling it.',
      execute: async () => {
        await flagUrgent()
        return 'The call is flagged as urgent for the team. Take a message now; do not promise a response time.'
      },
    }),
  }
}

/** Adds a detail as one more message for the team, once a message is saved on the call; false otherwise. */
async function addToMessage(api: ApiClient, call: CallSession, log: CallLog, detail: string): Promise<boolean> {
  if (!log.messages.length) return false
  try {
    await api.run(callTakeMessage, { callId: call.callId, message: detail }, call)
    log.messages.push(detail)
    log.record('system', 'Added to the message', callTakeMessage.name)
    return true
  } catch (e) {
    console.warn(`could not add to the message of call ${call.callId}: ${e instanceof Error ? e.message : String(e)}`)
    return false
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

/**
 * When the assistant said it hangs up now, or wrote end_call into its goodbye, but left out the tool, the call ends
 * after those words as if it had called it.
 */
function keepHangUpPromises(session: voice.AgentSession, log: CallLog, endCall: () => void) {
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || item.role !== 'assistant' || !item.textContent || log.transferred) return
    if (writesEndCall(item.textContent) || announcesHangUp(item.textContent)) endCall()
  })
}

function recordConversation(session: voice.AgentSession, log: CallLog) {
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || !item.textContent) return
    if (item.role === 'user') log.record('caller', item.textContent)
    // Put through to a person, the assistant is muted: a reply it still makes (to a tool of the same response) is never heard.
    const said = item.role === 'assistant' && !log.transferred && withoutEndCall(item.textContent)
    if (said) log.record('agent', said)
  })
}

/**
 * Tools whose result the caller need not hear: no extra LLM round when the assistant already spoke. Not end_call: its reply
 * is the goodbye (skipSecondGoodbye).
 */
const QUIET_TOOLS = new Set(['take_message', 'flag_urgent'])

const greetingCache = createGreetingCache()

/** What the assistant opens the call with: its greeting, else the fallback in its main language. */
const openingOf = (call: CallSession) => call.assistant?.greeting || spokenLines(mainLanguageOf(call.assistant?.languages)).fallbackGreeting

/**
 * Starts the greeting: the stored audio when there is some for this text and voice, else the voice
 * provider live, while the audio is made and stored for the next call.
 */
async function greet(session: voice.AgentSession, config: AgentConfig, call: CallSession, cached: Promise<Awaited<ReturnType<typeof greetingCache.get>>>, key: string, details: Promise<CallerDetails | null> | null) {
  // A greeting with caller details ({{name}}) waits briefly for them and is spoken live: it differs per caller.
  if (details) {
    const text = fillTemplate(openingOf(call), await within(details, GREETING_WAIT_MS, null))
    session.say(text)
    return 'personal'
  }
  const text = openingOf(call)
  const audio = await cached
  if (audio) {
    session.say(text, { audio: audioStream(audio) })
    return 'cached'
  }
  session.say(text)
  const voiceOfGreeting = createTts(config.tts, call.assistant?.voice, mainLanguageOf(call.assistant?.languages), talkingSpeedOf(call.assistant))
  // Made by the backup voice (the voice provider failed): not stored as the assistant's own greeting.
  void synthesize(voiceOfGreeting, text)
    .then(synthesized => (spokeWithBackup(voiceOfGreeting) ? undefined : greetingCache.put(key, synthesized)))
    .catch(e => console.warn(`could not store the greeting audio: ${e instanceof Error ? e.message : String(e)}`))
  return 'synthesized'
}

/**
 * A stage of the voice pipeline failed (voice-failures.ts): the call is marked (call.reportVoiceFailure, with a line on
 * its transcript), and the agent says it on itself (VOICE_FAILURE_ATTRIBUTE), where a test call's browser shows it at once.
 */
function reportVoiceFailure(room: Room, call: CallSession, log: CallLog, failure: VoiceFailure) {
  const stage = voiceStageNames[failure.stage]
  log.voiceFailed ??= stage
  // No reason on the transcript: the first one may still be refined (below); the call's failure keeps the cause.
  log.record('system', `${stage[0]!.toUpperCase()}${stage.slice(1)} failed: ${voiceProviderLabel(failure.provider)}`)
  const show = (shown: VoiceFailure) =>
    void room.localParticipant?.setAttributes({ [VOICE_FAILURE_ATTRIBUTE]: JSON.stringify(shown) }).catch(() => {})
  show(failure)
  // The API records it as the provider's failure too and may refine a vague reason (a used-up quota behind "no audio"):
  // the test call then shows the cause.
  void call.reportVoiceFailure?.(failure)
    .then(kept => { if (kept.reason !== failure.reason || kept.message !== failure.message) show(kept) })
    .catch(e => console.warn(`could not report the failure for call ${call.callId}: ${e instanceof Error ? e.message : String(e)}`))
}

/** The realtime model of a call, for its fixed lines: its session (once open) and how many turns the caller finished. */
type RealtimeLines = { model: () => RealtimeEvents | null; callerTurns: () => number; languages: CallLanguages }

/**
 * Says a fixed line. The three stages: the voice provider says it as written. A realtime model: the line is made in its
 * voice and played (realtime-lines.ts), when the call has one language; with other languages allowed the model is asked
 * to say it, in the caller's language, which it follows itself (the line is written in the language the call started in).
 */
function fixedLineSpeaker(session: voice.AgentSession, voiceOfLines: LineVoice, realtime: RealtimeLines | null): SayFixedLine {
  if (!realtime) return (text, options) => session.say(text, options).waitForPlayout()
  const askModel = (text: string) => session.generateReply({ instructions: realtimeLine(text) }).waitForPlayout()
  if (realtime.languages.others.length) return askModel
  return realtimeLineSpeaker({
    audio: text => lineAudio(voiceOfLines, text),
    play: (text, audio, allowInterruptions) => session.say(text, { audio: audioStream(audio), allowInterruptions }).waitForPlayout(),
    askModel,
    model: realtime.model,
    repliesEvent: on => realtimeRepliesEvent(on, realtime.languages),
    callerTurns: realtime.callerTurns,
    answer: () => void session.generateReply(),
  })
}

/**
 * Greets the caller and runs the conversation until the session closes. The session starts without
 * waiting for the caller: it links to them once they join (on a phone call they are there already),
 * and the greeting plays as soon as they hear the agent's audio.
 */
async function converse(ctx: JobContext, callerJoined: Promise<RemoteParticipant>, api: ApiClient, config: CallConfig, call: CallSession, log: CallLog, onClose: () => void, setup: SetupTimer, stopRecordingForTransfer: () => Promise<void>, callerDetails: Promise<CallerDetails | null>) {
  // The three stages answer the call, or a realtime model alone (then: no cached greeting, no quick tool replies).
  const stages = isRealtime(config) ? null : config
  const realtime = isRealtime(config) ? config.realtime : null
  const personalGreeting = templateNames(openingOf(call)).length > 0
  const key = stages && greetingKey({
    ...greetingVoice(stages, call), text: openingOf(call),
  })
  const cachedGreeting = personalGreeting || !key ? Promise.resolve(null) : greetingCache.get(key) // read while the session starts
  let callerIdentity: string | undefined
  void callerJoined.then(caller => (callerIdentity = caller.identity), () => {})
  const silence = silencePolicyOf(call.assistant)
  const languages = { main: mainLanguageOf(call.assistant?.languages), others: otherLanguagesOf(call.assistant?.languages) }
  const speed = talkingSpeedOf(call.assistant)
  const pipeline = stages && createPipeline(stages, call.assistant?.voice, silence.firstGapS, languages, speed)
  // The realtime session (again after a reconnect), and the caller's finished turns in it, for the fixed lines.
  let realtimeSession: RealtimeEvents | null = null
  let callerTurns = 0
  const session = new voice.AgentSession(realtime ? createRealtimePipeline(realtime, silence.firstGapS, speed, languages, events => {
    realtimeSession = events
    events.on('openai_client_event_queued', event => timer?.sent(event))
    events.on('openai_server_event_received', event => {
      if (event.type === 'input_audio_buffer.committed') callerTurns++
      timer?.received(event)
    })
  }) : pipeline!)
  // Any stage that fails marks the call and shows on a test call, instead of silence.
  watchVoicePipeline(
    session,
    stages
      ? { stt: stages.stt.provider, llm: stages.llm.provider, tts: ttsFor(stages.tts, call.assistant?.voice).provider }
      : { realtime: realtime!.provider },
    onceEachStage(failure => reportVoiceFailure(ctx.room, call, log, failure)),
    stages ? [stages.stt.apiKey, stages.llm.apiKey, stages.tts.apiKey] : [realtime!.apiKey],
  )
  const voiceOfLines = lineVoiceOf(config, call.assistant)
  const realtimeLines = realtime ? { model: () => realtimeSession, callerTurns: () => callerTurns, languages } : null
  const speak = fixedLineSpeaker(session, voiceOfLines, realtimeLines)
  // Fixed lines during the call are in the language spoken now: the main one until the caller switches. A realtime model
  // follows the caller's language itself: with other languages allowed it is asked to say a fixed line in it (fixedLineSpeaker).
  const spokenNow = pipeline ? followCallerLanguage(session, pipeline.tts, languages, call.callId) : () => languages.main
  const lines = () => spokenLines(spokenNow())
  // Silence only counts once the greeting has played (remindOnSilence).
  const greeted = greetingPlayed(session)
  // Where each reply's time goes (admin overview, Reply delay): realtime from OpenAI's events, the three stages from
  // their metrics. Kept on the call log and sent at hang-up; realtime replies are also logged.
  const timer = realtime
    ? realtimeTurnTimer(reply => {
        log.replies.push(reply)
        console.log(`latency ${call.callId}: ${describeRealtimeReply(reply)}`)
      }, { silenceMs: REALTIME_TURNS.silence_duration_ms })
    : null
  const stagesTimer = realtime ? null : cascadedReplyTimer(reply => log.replies.push(reply))
  log.timing = realtime
    ? { pipeline: 'realtime', providers: { turn: realtime.provider, model: realtime.provider } }
    : { pipeline: 'cascaded', providers: { turn: stages!.stt.provider, model: stages!.llm.provider, voice: stages!.tts.provider } }
  if (stagesTimer) session.on(voice.AgentSessionEventTypes.MetricsCollected, ({ metrics }) => stagesTimer.metrics(metrics as never))
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, ({ newState }) => {
    if (newState !== 'speaking') return
    timer?.speaking()
    stagesTimer?.speaking()
  })
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
  if (realtime) logRealtimeUsage(session, call.callId, realtime.model)
  // A realtime model has no voice for the ready lines: it only skips the reply after a turn it already spoke in.
  skipQuietToolReplies(session, QUIET_TOOLS, lines, { readyReplies: pipeline !== null })
  session.on(voice.AgentSessionEventTypes.Close, onClose)
  const deleteRoom = () => void ctx.deleteRoom().catch(() => {})
  // The assistant always says something before the call ends: its goodbye (else the goodbye line in the language spoken), the closing line
  // after silence, or the goodbye at its time limit.
  const sayLine = (text: string) => speak(text, { allowInterruptions: false, last: true })
  // Once per call: end_call (with the reply that called it) and the hang-up line (keepHangUpPromises: it has played) can
  // both ask for it.
  let ending = false
  let hangUpLineSaid = false
  let endCallReply: Reply | null = null
  skipSecondGoodbye(session, () => hangUpLineSaid || (endCallReply !== null && saidWords(endCallReply)))
  const endCall = (toolReply: Reply | null = null) => {
    if (toolReply) endCallReply = toolReply
    else hangUpLineSaid = true
    if (ending) return
    ending = true
    void hangUpAfterGoodbye({
      toolReply,
      goodbyeSaid: !toolReply,
      nextReply: nextReplyOf(session, toolReply),
      sayGoodbye: () => sayLine(lines().goodbye),
      stopListening: () => session.input.setAudioEnabled(false),
      hangUp: deleteRoom,
    })
  }
  keepHangUpPromises(session, log, () => endCall())
  // After a warm transfer or a take-over the caller talks with a person and the assistant is out of it: neither silence on its
  // side nor its time limit ends that call (the trunk's CALL_MAX_MINUTES does).
  const transferred = () => log.transferred
  remindOnSilence(session, silence, {
    remind: () => void speak(silence.reminder ?? lines().stillThere),
    close: () => {
      log.record('system', 'Hung up after silence on the line')
      hangUpAfterLine(sayLine(silence.closing), deleteRoom)
    },
    transferred,
    onHold: () => log.onHold,
    greeted,
  })
  // A test call from the web app ends sooner, so a forgotten browser tab does not run up provider minutes.
  const isTest = call.businessNumber === null
  // A realtime call's lines in its voice are made now, so the first one does not wait for it (then cached for every call).
  if (realtimeLines && !languages.others.length) {
    const texts = [silence.reminder ?? lines().stillThere, silence.closing, lines().goodbye, isTest ? lines().testCallLimit : lines().callLimit]
    void Promise.allSettled(texts.map(text => lineAudio(voiceOfLines, text)))
  }
  // A phone call: the assistant's own limit, never above ASSISTANT_CALL_MAX_MINUTES (an older API sends none).
  const limitMinutes = isTest ? TEST_CALL_LIMIT_MS / 60_000 : Math.min(call.assistant?.max_call_minutes ?? ASSISTANT_CALL_MAX_MINUTES, ASSISTANT_CALL_MAX_MINUTES)
  const cancelLimit = hangUpAtCallLimit(limitMinutes * 60_000, {
    transferred,
    goodbye: () => {
      log.record('system', `Call ended after ${limitMinutes} minutes`)
      hangUpAfterLine(sayLine(isTest ? lines().testCallLimit : lines().callLimit), deleteRoom)
    },
  })
  session.on(voice.AgentSessionEventTypes.Close, cancelLimit)
  // Either pipeline puts calls through; a realtime call's transfer speaks and hears with OpenAI's models (transferSpeechOf).
  const transfer = transferFrom(ctx, api, call, config, callerJoined, stopRecordingForTransfer)
  // The instructions change when the call-start webhook answers.
  const known: { details: CallerDetails | null } = { details: null }
  // A realtime model says the greeting itself; the voice provider says it before the model's first turn otherwise.
  const instructionsNow = () => buildInstructions(call.assistant, call.businessHours, call.booking, transfer?.contacts ?? [], call.caller, call.timeZone, undefined, known.details, call.lookups.length > 0)
  const instructions = instructionsNow()
  const collect: CollectContext = {
    log,
    today: () => call.booking?.todayDate ?? new Date().toISOString().slice(0, 10),
    languageRule: collectLanguageRule(call.assistant) ?? undefined,
    addToMessage: detail => addToMessage(api, call, log, detail),
    callerId: callerIdOf(call),
    facts: () => stepFacts({ today: collect.today(), hours: call.businessHours?.summary, address: call.assistant?.business_profile?.address }),
  }
  const agent = new voice.Agent({ instructions, tools: assistantTools(api, call, log, endCall, flagUrgent, transfer, collect) })
  if (stages) void warmUpLlm(stages.llm, instructions)
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
  void callerDetails.then(async details => {
    if (!details) return
    known.details = details
    await agent.updateInstructions(instructionsNow())
  }).catch(e => console.warn(`call ${call.callId}: caller details not given to the assistant: ${e instanceof Error ? e.message : String(e)}`))
  if (!stages || !key) {
    // A realtime model has no voice provider: it says the greeting itself. A greeting with the caller's details waits for
    // them (at most GREETING_WAIT_MS) and goes to the model filled in; its instructions never hold that greeting (prompt.ts).
    const details = personalGreeting ? await within(callerDetails, GREETING_WAIT_MS, null) : null
    session.generateReply({ instructions: realtimeLine(personalGreeting ? fillTemplate(openingOf(call), details) : openingOf(call)) })
    return setup.note('spoken by the realtime model')
  }
  setup.note(await greet(session, stages, call, cachedGreeting, key, personalGreeting ? callerDetails : null))
}

/** The realtime model's tokens for the whole call, logged once when the session closes (cost per minute, per model). */
function logRealtimeUsage(session: voice.AgentSession, callId: string, model: string) {
  const usage = realtimeUsageCounter()
  const startedAt = Date.now()
  session.on(voice.AgentSessionEventTypes.MetricsCollected, ({ metrics }) => usage.add(metrics as RealtimeUsageMetrics))
  session.on(voice.AgentSessionEventTypes.Close, () => console.log(describeRealtimeUsage(callId, model, (Date.now() - startedAt) / 1000, usage.get())))
}

/**
 * transfer_call for this call, from its start: the contacts that take calls now (transferContactsFor). How to dial each
 * is looked up right away, so a transfer does not wait for it, but nothing is dialled until the assistant uses the tool.
 * null: no contact takes calls now (none set up, closed, vacation mode).
 */
function transferFrom(ctx: JobContext, api: ApiClient, call: CallSession, config: CallConfig, callerJoined: Promise<RemoteParticipant>, stopRecording: () => Promise<void>): Transfer {
  const contacts = transferContactsFor(call.assistant, call.businessHours)
  if (!contacts.length) return null
  const speech = transferSpeechOf(config, call.assistant)
  const dialers = new Map(
    contacts.map(contact => [
      contact.id,
      onCallDialerFor(call, contact.number, speech, api).catch(e => {
        console.warn(`call ${call.callId}: cannot dial ${contact.name}: ${e instanceof Error ? e.message : String(e)}`)
        return null
      }),
    ]),
  )
  const callerIdentity = callerJoined.then(caller => caller.identity)
  void callerIdentity.catch(() => {}) // the call ends without a caller; nobody waits for it then
  return { ctx, speech, callerIdentity, contacts, dialerOf: (contact: Dialable) => dialers.get(contact.id) ?? Promise.resolve(null), stopRecording }
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
  if (call.forwardingCheck) {
    // Our own forwarding check arrived: the API recorded it. Nobody is on the line, so nothing is said.
    await ctx.deleteRoom()
    return ctx.shutdown('forwarding check')
  }
  if (call.blocked) {
    // The API already filed the call: in Spam (blocked caller) or as missed with a callback (busy, over the spending
    // cap). Each caller hears one line first, once the voice is set up.
    await tellCaller(ctx, call, unansweredLine(call), ready, callerJoined)
    await ctx.deleteRoom()
    return ctx.shutdown(call.overCap ? 'workspace over its monthly spending cap' : call.busy ? 'too many calls at once in the workspace' : 'blocked caller')
  }
  // The call-start webhook is asked now, so its answer is on the way while the voice is set up. Not on a test call.
  const callerDetails = call.businessNumber === null ? Promise.resolve(null) : lookUpCaller(api, call)
  const readiness = await ready
  if (!readiness.ready) {
    await declineCall(call, readiness, () => ctx.deleteRoom())
    return ctx.shutdown('assistant not set up')
  }
  setup.mark('providers')
  // The assistant's pipeline (Settings › Assistant); the other one when that is not set up.
  // A call test may compare realtime models without changing the install's (call-test --realtime-model).
  const config = withRealtimeModel(
    configForAssistant(readiness.config, call.assistant?.voice_pipeline, line => console.warn(`call ${call.callId}: ${line}`)),
    call.realtimeModel,
  )
  if (isRealtime(config)) console.log(`call ${call.callId}: realtime model ${config.realtime.model}`)
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
    await converse(ctx, callerJoined, api, config, call, log, finishOnce, setup, stopRecordingForTransfer, callerDetails)
  } catch (e) {
    await finishOnce()
    throw e
  }
}

/** How long an unanswered call waits for the caller to be in the room before it hangs up without the line. */
const BUSY_CALLER_WAIT_MS = 5000

/** Plays `line` to the caller once they are in the room, in the voice of the assistant's pipeline; nothing when no voice is set up. */
async function tellCaller(ctx: JobContext, call: CallSession, line: string, ready: Promise<Readiness>, callerJoined: Promise<RemoteParticipant>) {
  const readiness = await ready
  if (!readiness.ready) return
  const config = configForAssistant(readiness.config, call.assistant?.voice_pipeline, () => {})
  const joined = await Promise.race([callerJoined.then(() => true, () => false), sleep(BUSY_CALLER_WAIT_MS).then(() => false)])
  if (joined) await playLine(ctx.room, lineVoiceOf(config, call.assistant), call, line)
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
  const stages = readiness.ready ? stagesOf(readiness.config) : null
  if (!stages) {
    console.error(`test caller cannot call: ${readiness.ready ? 'it talks through speech to text, language model and voice, which are not set up' : readiness.reason}`)
    return ctx.deleteRoom()
  }
  await runTestCaller(ctx, scenario, stages, readiness.ready && isRealtime(readiness.config) ? readiness.config.realtime : null)
}

async function runAsOnCallResponder(ctx: JobContext, responder: OnCallResponderMetadata) {
  const readiness = await checkReadiness(loadAgentConfig)
  const stages = readiness.ready ? stagesOf(readiness.config) : null
  if (!stages) {
    console.error(`on-call responder cannot answer: ${readiness.ready ? 'it talks through speech to text, language model and voice, which are not set up' : readiness.reason}`)
    return ctx.deleteRoom()
  }
  await runOnCallResponder(ctx, responder, stages)
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
  // The API counts the agent as running by its last settings read (Admin › Overview, the test call's check): read
  // them on a timer too, not only when a call comes, so a test call is not refused after the API restarts.
  setInterval(() => void loadAgentConfig().catch(() => {}), SETTINGS_TTL_MS + 1000).unref()
  // Processes kept warm for the next call. Three by default: a call takes one, and a phone call test two
  // (the test caller and the business), while the next one starts (a new process needs ~2 s of CPU).
  const numIdleProcesses = Number(process.env.AGENT_IDLE_PROCESSES) || 3
  // How long a new process may take to load the agent. Under a running call on a small box this takes
  // well over the library's 10 s, and a process that times out is killed and started again in a loop.
  const initializeProcessTimeout = Number(process.env.AGENT_INIT_TIMEOUT_MS) || 60_000
  // LiveKit stops giving a worker jobs above this CPU load (0.7 by default in production). On a small
  // single-box install that refuses calls, and the second job of a call test, while one call runs.
  const loadThreshold = Number(process.env.AGENT_LOAD_THRESHOLD) || 0.95
  // On SIGTERM (an update) the worker takes no new calls and finishes the ones it has. A call put through to a
  // person lasts up to CALL_MAX_MINUTES, longer than the library's 60 minutes; the container's
  // stop_grace_period (LINEDESK_AGENT_DRAIN) is a little longer again, so this limit is the one that applies.
  const drainTimeout = (CALL_MAX_MINUTES + 5) * 60_000
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME, numIdleProcesses, loadThreshold, initializeProcessTimeout, drainTimeout }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
