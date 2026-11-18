// The voice agent: a LiveKit Agents worker. One job per call room; all writes go through the API.
// Which speech and language vendors are used is decided in pipeline.ts.
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  agentTokenProblem,
  VOICE_FAILURE_ATTRIBUTE,
  type Language,
  type ProviderName,
  type VoiceFailure,
  type VoiceStage,
  voiceProviderLabel,
  voiceStageName,
  CALL_MAX_MINUTES,
  callFlagUrgent,
  callStartRecording,
  fillTemplate,
  goodbyeLineOf,
  mainLanguageOf,
  type SpokenLines,
  spokenLines,
  swapDefault,
  templateNames,
} from '@linedesk/actions'
import type { CallerDetails } from '@linedesk/db/types'
import { cli, defineAgent, ServerOptions, voice, type JobContext } from '@livekit/agents'
import type { RemoteParticipant, Room } from '@livekit/rtc-node'
import { RoomServiceClient } from 'livekit-server-sdk'
import { apiClientFromEnv, type ApiClient } from './api-client.ts'
import { initErrorReporting } from './error-reporting.ts'
import { assistantTools, type Transfer } from './assistant-tools.ts'
import { type CollectContext, stepFacts } from './collect/collect-tools.ts'
import { callerIdOf } from './callback-number.ts'
import {
  CallLog,
  finalizeCall,
  finishCall,
  type FinishedCall,
  hangUp,
  once,
  RECORDING_WAIT_MS,
  repeatFilter,
} from './call-log.ts'
import { onceEachStage, watchVoicePipeline } from './voice-failures.ts'
import { retryEmptyReplies } from './empty-reply.ts'
import { GREETING_WAIT_MS, lookUpCaller, within } from './caller-lookup.ts'
import {
  announceRecording,
  callLimitOf,
  callOrigin,
  parseTestMetadata,
  startCall,
  type CallSession,
} from './call-session.ts'
import { earlyOrigin, livekitParticipants } from './early-origin.ts'
import {
  type AgentConfig,
  type CallConfig,
  configForAssistant,
  createConfigLoader,
  parsePartnerSettings,
  partnerCallConfig,
  isRealtime,
  parseProviderSettings,
  pipelineOfAssistant,
  SETTINGS_TTL_MS,
  stagesOf,
  withAssistantModel,
  withAssistantRealtimeModel,
  withAssistantRealtimeVoice,
  withLevelFallbacks,
  withSttModel,
  withRealtimeModel,
} from './config.ts'
import { livekitHttpUrl, requireLivekitEnv, slowLoopMonitor, turnOffLocalInference, workerAgentName } from './env.ts'
import { describeLoadPolicy, describeProcessWait, loadPolicy, reportedLoad } from './worker-load.ts'
import { checkReadiness, declineCall, describeReadiness, type Readiness } from './not-ready.ts'
import {
  type CallLanguages,
  callLanguagesOf,
  callVoicesOf,
  createPipeline,
  withCallLanguages,
  createRealtimePipeline,
  createTts,
  greetingVoice,
  type LineVoice,
  lineVoiceOf,
  realtimeLine,
  spokeWithBackup,
  ttsFor,
  realtimeRepliesEvent,
  type RealtimeEvents,
  summaryLlm,
  transferSpeechOf,
  talkingSpeedOf,
  warmUpLlm,
  REALTIME_TURNS,
} from './pipeline.ts'
import { audioStream, createGreetingCache, greetingKey, synthesize, withoutLeadingSilence } from './greeting-cache.ts'
import { cascadedReplyTimer, logTurnMetrics } from './turn-metrics.ts'
import { describeRealtimeReply, realtimeTurnTimer } from './realtime-timing.ts'
import { describeRealtimeUsage, type RealtimeUsageMetrics, realtimeUsageCounter } from './realtime-usage.ts'
import { realtimeHistoryCompactor } from './realtime-history.ts'
import { callNotesKeeper } from './call-notes.ts'
import { followCallerLanguage } from './caller-language.ts'
import { skipQuietToolReplies } from './tool-replies.ts'
import { CallAgent, toolFiller } from './tool-filler.ts'
import {
  asksAnythingElse,
  asksCaller,
  closingFlow,
  END_CALL_ASKED,
  END_CALL_ENDS,
  endRoom,
  ROOM_DELETE_TIMEOUT_MS,
  greetingPlayed,
  hangUpAtCallLimit,
  hangUpWithGoodbye,
  lastLineOfCall,
  playedOut,
  type Reply,
  remindOnSilence,
  skipEndCallReplies,
  silencePolicyOf,
  announcesHangUp,
  withoutEndCall,
  wordsOf,
  writesEndCall,
} from './hang-up.ts'
import { lineAudio, playLine, unansweredLine } from './busy-line.ts'
import { realtimeLineSpeaker, type SayFixedLine } from './realtime-lines.ts'
import { promisesUrgent, urgentFlagger } from './urgent-promise.ts'
import { buildInstructions, collectLanguageRule, spokenLanguageRule } from './prompt.ts'
import {
  describeRecording,
  livekitRecorder,
  resolveRecording,
  saveRecording,
  startRecording,
  stopRecording,
  stopRecordingOrThrow,
} from './recording.ts'
import { ALL_PARTICIPANT_KINDS, waitForCounterpart } from './counterpart.ts'
import { runTestCaller } from './test-caller/caller.ts'
import { type Dialable, transferContactsFor } from './transfer.ts'
import { watchTakeOver } from './take-over.ts'
import { dialerLookup, onCallDialerFor } from './transfer-tool.ts'
import { parseTestCallerMetadata, type TestCallerMetadata } from './test-caller/scenarios.ts'
import { type OnCallResponderMetadata, parseOnCallResponderMetadata, runOnCallResponder } from './oncall-responder.ts'
import { GREETING_STEP, type SetupTimer, setupTimer, watchAgentAudio } from './setup-timing.ts'

// Sentry, when SENTRY_DSN is set (error-reporting.ts), in the worker and in every job process it starts for a call.
initErrorReporting()

let configLoader: (() => Promise<CallConfig>) | undefined
/** The effective provider config: Linedesk's provider settings first, the environment as fallback, cached briefly per process. */
function loadAgentConfig(): Promise<CallConfig> {
  configLoader ??= createConfigLoader({
    fetchSettings: async () => parseProviderSettings(await apiClientFromEnv().providerSettings()),
  })
  return configLoader()
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
    if (item.type !== 'message' || item.role !== 'assistant' || !item.textContent || !promisesUrgent(item.textContent))
      return
    flagUrgent().catch(e =>
      console.error(`call ${callId}: could not flag as urgent: ${e instanceof Error ? e.message : String(e)}`),
    )
  })
}

/**
 * When the assistant said it hangs up now, or wrote end_call into its goodbye, but left out the tool, the call ends
 * after those words as if it had called it. Not when those words ask the caller something (asksCaller): they answer.
 */
function keepHangUpPromises(session: voice.AgentSession, log: CallLog, endCall: (id: string, said: string) => void) {
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || item.role !== 'assistant' || !item.textContent || log.transferred) return
    if (asksCaller(withoutEndCall(item.textContent))) return
    if (writesEndCall(item.textContent) || announcesHangUp(item.textContent))
      endCall(item.id, withoutEndCall(item.textContent))
  })
}

function recordConversation(session: voice.AgentSession, log: CallLog) {
  const repeated = repeatFilter()
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || !item.textContent) return
    if (repeated({ id: item.id, role: item.role, text: item.textContent })) return
    if (item.role === 'user') log.record('caller', item.textContent)
    // Put through to a person, the assistant is muted: a reply it still makes (to a tool of the same response) is never heard.
    const said = item.role === 'assistant' && !log.transferred && withoutEndCall(item.textContent)
    if (said) log.record('agent', said)
  })
}

/**
 * Tools whose result the caller need not hear: no extra LLM round when the assistant already spoke. end_call's reply is
 * always skipped (skipEndCallReplies).
 */
const QUIET_TOOLS = new Set(['flag_urgent'])

const greetingCache = createGreetingCache()

/** What the assistant opens the call with: its greeting, else the fallback in its main language. */
const openingOf = (call: CallSession) =>
  call.assistant?.greeting || spokenLines(mainLanguageOf(call.assistant?.languages)).fallbackGreeting

/**
 * Starts the greeting: the stored audio when there is some for this text and voice, else the voice
 * provider live, while the audio is made and stored for the next call.
 */
async function greet(
  session: voice.AgentSession,
  config: AgentConfig,
  call: CallSession,
  cached: Promise<Awaited<ReturnType<typeof greetingCache.get>>>,
  key: string,
  details: Promise<CallerDetails | null> | null,
  queued: () => void,
) {
  // A greeting with caller details ({{name}}) waits briefly for them and is spoken live: it differs per caller.
  if (details) {
    const text = fillTemplate(openingOf(call), await within(details, GREETING_WAIT_MS, null))
    queued()
    session.say(text)
    return 'personal'
  }
  const text = openingOf(call)
  const audio = await cached
  queued()
  if (audio) {
    // Without the silence the voice put before the first word: it would only delay the greeting (LIN-262).
    session.say(text, { audio: audioStream(withoutLeadingSilence(audio)) })
    return 'cached'
  }
  session.say(text)
  const voiceOfGreeting = createTts(
    config.tts,
    call.assistant?.voice,
    mainLanguageOf(call.assistant?.languages),
    talkingSpeedOf(call.assistant),
  )
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
  const stage = voiceStageName(failure.stage)
  log.voiceFailed ??= failure.stage
  // No reason on the transcript: the first one may still be refined (below); the call's failure keeps the cause.
  log.record('system', `${stage[0]!.toUpperCase()}${stage.slice(1)} failed: ${voiceProviderLabel(failure.provider)}`)
  const show = (shown: VoiceFailure) =>
    void room.localParticipant?.setAttributes({ [VOICE_FAILURE_ATTRIBUTE]: JSON.stringify(shown) }).catch(() => {})
  show(failure)
  // The API records it as the provider's failure too and may refine a vague reason (a used-up quota behind "no audio"):
  // the test call then shows the cause.
  // Whose key served the stage: a call forecast on the partner's keys that fell back reports `install` (S7).
  void call
    .reportVoiceFailure?.(failure, call.keySources?.[failure.stage] ?? 'install')
    .then(kept => {
      if (kept.reason !== failure.reason || kept.message !== failure.message) show(kept)
    })
    .catch(e =>
      console.warn(
        `could not report the failure for call ${call.callId}: ${e instanceof Error ? e.message : String(e)}`,
      ),
    )
}

/**
 * Ends the call for everyone (endRoom): the room is deleted through LiveKit's server API, which says when that failed
 * (JobContext.deleteRoom only logs it), and tried again; when it keeps failing, the agent leaves the call. Once per call:
 * later calls change nothing.
 */
function roomEnder(ctx: JobContext, callId: string) {
  let ending = false
  return () => {
    if (ending) return
    ending = true
    void (async () => {
      const env = requireLivekitEnv()
      const rooms = new RoomServiceClient(
        livekitHttpUrl(env.LIVEKIT_URL),
        env.LIVEKIT_API_KEY,
        env.LIVEKIT_API_SECRET,
        { requestTimeout: ROOM_DELETE_TIMEOUT_MS / 1000 },
      )
      const room = ctx.room.name ?? ''
      const how = await endRoom({
        deleteRoom: () => rooms.deleteRoom(room),
        leave: () => ctx.shutdown('the room could not be deleted'),
      })
      if (how === 'left') console.warn(`call ${callId}: the room could not be deleted, the agent left the call`)
    })().catch(e =>
      console.warn(`call ${callId}: could not end the call: ${e instanceof Error ? e.message : String(e)}`),
    )
  }
}

/** The realtime model of a call, for its fixed lines: its session (once open) and how many turns the caller finished. */
type RealtimeLines = { model: () => RealtimeEvents | null; callerTurns: () => number; languages: CallLanguages }

/**
 * Says a fixed line. The three stages: the voice provider says it as written. A realtime model: the line is made in its
 * voice and played (realtime-lines.ts), when the call has one language; with other languages allowed the model is asked
 * to say it, in the caller's language, which it follows itself (the line is written in the language the call started in).
 */
function fixedLineSpeaker(
  session: voice.AgentSession,
  voiceOfLines: LineVoice,
  realtime: RealtimeLines | null,
): SayFixedLine {
  if (!realtime) return (text, options) => session.say(text, options).waitForPlayout()
  const askModel = (text: string) => session.generateReply({ instructions: realtimeLine(text) }).waitForPlayout()
  if (realtime.languages.others.length) return askModel
  return realtimeLineSpeaker({
    audio: text => lineAudio(voiceOfLines, text),
    play: (text, audio, allowInterruptions) =>
      session.say(text, { audio: audioStream(audio), allowInterruptions }).waitForPlayout(),
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
async function converse(
  ctx: JobContext,
  callerJoined: Promise<RemoteParticipant>,
  api: ApiClient,
  config: CallConfig,
  call: CallSession,
  log: CallLog,
  onClose: () => void,
  setup: SetupTimer,
  stopRecordingForTransfer: () => Promise<void>,
  callerDetails: Promise<CallerDetails | null>,
) {
  // The three stages answer the call, or a realtime model alone (then: no cached greeting, no quick tool replies).
  const stages = isRealtime(config) ? null : config
  const realtime = isRealtime(config) ? config.realtime : null
  const personalGreeting = templateNames(openingOf(call)).length > 0
  const key =
    stages &&
    greetingKey({
      ...greetingVoice(stages, call),
      text: openingOf(call),
    })
  const cachedGreeting = personalGreeting || !key ? Promise.resolve(null) : greetingCache.get(key) // read while the session starts
  void cachedGreeting.then(audio => audio && setup.mark('greeting read'))
  let callerIdentity: string | undefined
  void callerJoined.then(
    caller => (callerIdentity = caller.identity),
    () => {},
  )
  const silence = silencePolicyOf(call.assistant)
  const languages = callLanguagesOf(
    call.assistant?.languages,
    stages ? callVoicesOf(stages.tts, call.assistant?.voice) : [],
    stages?.stt,
  )
  const speed = talkingSpeedOf(call.assistant)
  const pipeline = stages && createPipeline(stages, call.assistant?.voice, silence.firstGapS, languages, speed)
  // The realtime session (again after a reconnect), and the caller's finished turns in it, for the fixed lines.
  let realtimeSession: RealtimeEvents | null = null
  let callerTurns = 0
  const session = new voice.AgentSession(
    realtime
      ? createRealtimePipeline(realtime, silence.firstGapS, speed, languages, events => {
          realtimeSession = events
          events.on('openai_client_event_queued', event => timer?.sent(event))
          events.on('openai_server_event_received', event => {
            if (event.type === 'input_audio_buffer.committed') callerTurns++
            timer?.received(event)
          })
        })
      : pipeline!,
  )
  // Any stage that fails marks the call and shows on a test call, instead of silence.
  const stageProviders: Partial<Record<VoiceStage, ProviderName>> = stages
    ? { stt: stages.stt.provider, llm: stages.llm.provider, tts: ttsFor(stages.tts, call.assistant?.voice).provider }
    : { realtime: realtime!.provider }
  const failedStages = new Set<VoiceStage>()
  // Races in the call's own conversation (two replies at once): logged and counted, the provider stays OK (LIN-249).
  let callErrors = 0
  watchVoicePipeline(
    session,
    stageProviders,
    onceEachStage(failure => {
      failedStages.add(failure.stage)
      reportVoiceFailure(ctx.room, call, log, failure)
    }),
    stages ? [stages.stt.apiKey, stages.llm.apiKey, stages.tts.apiKey] : [realtime!.apiKey],
    failure => {
      callErrors++
      console.warn(
        `call ${call.callId}: ${voiceStageName(failure.stage)} ${failure.provider} refused a reply (per-call, not a provider failure): ${failure.message}`,
      )
    },
  )
  // A call the assistant answered in: the providers of every stage that did not fail worked, so a failure recorded for
  // them before (Server admin › Providers) is over.
  session.on(voice.AgentSessionEventTypes.Close, () => {
    if (callErrors)
      console.log(`call ${call.callId}: ${callErrors} per-call realtime error(s), provider not marked failing`)
    if (!log.replies.length) return
    const worked = Object.entries(stageProviders)
      .filter(([stage]) => !failedStages.has(stage as VoiceStage))
      .map(([, provider]) => provider)
    void call
      .reportProvidersOk?.([...new Set(worked)])
      .catch(e =>
        console.warn(
          `could not report working providers for call ${call.callId}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      )
  })
  if (stages) retryEmptyReplies(session)
  const voiceOfLines = lineVoiceOf(config, call.assistant)
  const realtimeLines = realtime ? { model: () => realtimeSession, callerTurns: () => callerTurns, languages } : null
  const speak = fixedLineSpeaker(session, voiceOfLines, realtimeLines)
  // Fixed lines during the call are in the language spoken now: the main one until the caller switches. A realtime model
  // follows the caller's language itself: with other languages allowed it is asked to say a fixed line in it (fixedLineSpeaker).
  // Each switch also changes what the assistant and a running collection step are told to reply in (switched.to, set once the assistant exists).
  const switched: { to: (language: Language) => void } = { to: () => {} }
  const spokenNow = pipeline
    ? followCallerLanguage(session, pipeline.tts, languages, call.callId, language => switched.to(language))
    : () => languages.main
  const lines = () => spokenLines(spokenNow())
  // Silence only counts once the greeting has played (remindOnSilence).
  const greeted = greetingPlayed(session)
  // Where each reply's time goes (admin overview, Reply delay): realtime from OpenAI's events, the three stages from
  // their metrics. Kept on the call log and sent at hang-up; realtime replies are also logged.
  const timer = realtime
    ? realtimeTurnTimer(
        reply => {
          log.replies.push(reply)
          console.log(`latency ${call.callId}: ${describeRealtimeReply(reply)}`)
        },
        { silenceMs: REALTIME_TURNS.silence_duration_ms },
      )
    : null
  const stagesTimer = realtime ? null : cascadedReplyTimer(reply => log.replies.push(reply))
  log.timing = realtime
    ? { pipeline: 'realtime', providers: { turn: realtime.provider, model: realtime.provider } }
    : {
        pipeline: 'cascaded',
        providers: { turn: stages!.stt.provider, model: stages!.llm.provider, voice: stages!.tts.provider },
      }
  if (stagesTimer)
    session.on(voice.AgentSessionEventTypes.MetricsCollected, ({ metrics }) => stagesTimer.metrics(metrics as never))
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, ({ newState }) => {
    if (newState !== 'speaking') return
    timer?.speaking()
    stagesTimer?.speaking()
  })
  const onSpeaking = ({ newState }: { newState: string }) => {
    if (newState !== 'speaking') return
    session.off(voice.AgentSessionEventTypes.AgentStateChanged, onSpeaking)
    setup.mark(GREETING_STEP)
    setup.log(call.callId, ctx.room)
  }
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, onSpeaking)
  recordConversation(session, log)
  const flagUrgent = callFlagger(api, call, log)
  keepUrgentPromises(session, flagUrgent, call.callId)
  logTurnMetrics(session, call.callId)
  const realtimeUsage = realtime ? logRealtimeUsage(session, call.callId, realtime.model) : null
  // A realtime model has no voice for the ready lines: it only skips the reply after a turn it already spoke in.
  skipQuietToolReplies(session, QUIET_TOOLS, lines, {
    readyReplies: pipeline !== null,
    callerId: callerIdOf(call) !== null,
  })
  session.on(voice.AgentSessionEventTypes.Close, onClose)
  const deleteRoom = roomEnder(ctx, call.callId)
  // The assistant always says something before the call ends: the goodbye line, the closing line after silence, or the
  // goodbye at its time limit.
  const sayLine = (text: string) => speak(text, { allowInterruptions: false, last: true })
  // The owner's goodbye line (Settings › Assistant › Extended), else "Thanks for calling. Goodbye!" in the language spoken.
  const goodbyeLine = () => goodbyeLineOf(call.assistant?.goodbye_line) ?? lines().goodbye
  // The closing flow (LIN-358): end_call first asks "anything else?"; only right after the caller answered it does it say
  // the goodbye line and hang up. Once per call: end_call and the assistant's words that say it hangs up can both ask.
  const closing = closingFlow()
  const idsOf = (reply: Reply | null) => new Set((reply?.chatItems ?? []).flatMap(item => (item.id ? [item.id] : [])))
  // The silence reminders said on this call: they do not count in the closing flow.
  const reminders = new Set<string>()
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || item.role !== 'assistant' || !item.textContent) return
    const text = withoutEndCall(item.textContent)
    closing.assistantSaid(item.id, text, reminders.has(text.trim()))
  })
  skipEndCallReplies(session)
  let ending = false
  let asking = false
  const askAnythingElse = async (toolReply: Reply | null) => {
    asking = true
    try {
      if (toolReply) await playedOut(toolReply)
      const words = toolReply ? wordsOf(toolReply) : ''
      // The model asked it itself, or asked something else the caller answers first (LIN-341): no second question.
      if (words && (asksAnythingElse(words) || asksCaller(words))) return
      closing.questionComing(idsOf(toolReply))
      await speak(lines().anythingElse)
    } finally {
      asking = false
    }
  }
  const hangUp = (toolReply: Reply | null, said = '') => {
    ending = true
    void hangUpWithGoodbye({
      toolReply,
      said,
      sayGoodbye: () => sayLine(goodbyeLine()),
      stopListening: () => session.input.setAudioEnabled(false),
      callerSpeaking: () => session.userState === 'speaking',
      hangUp: deleteRoom,
    }).then(ended => {
      if (ended) return
      // The assistant asked the caller something in its last words (LIN-341), or the caller is still speaking (LIN-499):
      // the call goes on.
      console.log(`call ${call.callId}: end_call after a question or while the caller speaks, the call goes on`)
      ending = false
      session.input.setAudioEnabled(true)
    })
  }
  const endCall = (toolReply: Reply): string => {
    if (ending || asking) return END_CALL_ASKED
    if (closing.step(idsOf(toolReply)) === 'ask') {
      void askAnythingElse(toolReply)
      return END_CALL_ASKED
    }
    hangUp(toolReply)
    return END_CALL_ENDS
  }
  // The assistant said it hangs up now (or wrote end_call) without the tool: the same flow.
  keepHangUpPromises(session, log, (id, said) => {
    if (ending || asking) return
    if (closing.step(new Set([id])) === 'ask') void askAnythingElse(null)
    else hangUp(null, said)
  })
  // After a warm transfer or a take-over the caller talks with a person and the assistant is out of it: neither silence on its
  // side nor its time limit ends that call (the trunk's CALL_MAX_MINUTES does).
  const transferred = () => log.transferred
  // The closing line after silence or the goodbye at the time limit, whichever comes first: it cuts off what is still
  // playing, so the hang-up never cuts the line itself.
  const lastLine = lastLineOfCall({
    stopSpeaking: () => void session.interrupt({ force: true }).await.catch(() => {}),
    stopListening: () => session.input.setAudioEnabled(false),
    say: sayLine,
    hangUp: deleteRoom,
  })
  const stopSilence = remindOnSilence(session, silence, {
    remind: () => {
      const line = silence.reminder ?? lines().stillThere
      reminders.add(line.trim())
      void speak(line)
    },
    close: () => {
      log.record('system', 'Hung up after silence on the line')
      // The default closing line in the language spoken now (the reminder before it is too), not only in the main language.
      lastLine(swapDefault(silence.closing, languages.main, spokenNow()))
    },
    transferred,
    onHold: () => log.onHold,
    greeted,
  })
  // The caller hung up (or the call ended another way): silence on the line no longer counts.
  session.on(voice.AgentSessionEventTypes.Close, stopSilence)
  // A test call from the web app ends sooner, so a forgotten browser tab does not run up provider minutes; a public demo
  // call sooner still (callLimitOf).
  const limit = callLimitOf(call, lines())
  // A realtime call's lines in its voice are made now, so the first one does not wait for it (then cached for every call).
  if (realtimeLines && !languages.others.length) {
    const texts = [
      silence.reminder ?? lines().stillThere,
      silence.closing,
      lines().anythingElse,
      goodbyeLine(),
      limit.line,
      lines().stillChecking,
    ]
    void Promise.allSettled(texts.map(text => lineAudio(voiceOfLines, text)))
  }
  const cancelLimit = hangUpAtCallLimit(limit.ms, {
    transferred,
    goodbye: () => {
      log.record('system', `Call ended after ${limit.ms / 60_000} minutes`)
      lastLine(limit.line)
    },
  })
  session.on(voice.AgentSessionEventTypes.Close, cancelLimit)
  // Either pipeline puts calls through; a realtime call's transfer speaks and hears with OpenAI's models (transferSpeechOf).
  const transfer = transferFrom(ctx, api, call, config, callerJoined, stopRecordingForTransfer, lines)
  // The instructions change when the call-start webhook answers.
  const known: { details: CallerDetails | null } = { details: null }
  // A realtime model says the greeting itself; the voice provider says it before the model's first turn otherwise.
  // Once the caller switched to another allowed language, the assistant is told to reply in it (spokenLanguageRule).
  const callAssistant = withCallLanguages(call.assistant, languages)
  // A realtime call keeps what the caller said as call notes at the end of its instructions (call-notes.ts): its early
  // turns are cut or turned into text later (REALTIME_TRUNCATION, realtime-history.ts).
  const notes = realtime ? callNotesKeeper(log, (): Promise<void> => agent.updateInstructions(instructionsNow())) : null
  const instructionsNow = (): string =>
    [
      buildInstructions(
        callAssistant,
        call.businessHours,
        call.booking,
        transfer?.contacts ?? [],
        call.caller,
        call.timeZone,
        undefined,
        known.details,
        call.lookups.length > 0,
        call.teamLanguage,
        call.promptOverrides,
      ),
      spokenLanguageRule(callAssistant, spokenNow()),
      notes?.current(),
    ]
      .filter(Boolean)
      .join('\n\n')
  const instructions = instructionsNow()
  const collect: CollectContext = {
    log,
    today: () => call.booking?.todayDate ?? new Date().toISOString().slice(0, 10),
    languageRule: () => collectLanguageRule(callAssistant, spokenNow()) ?? undefined,
    language: spokenNow,
    callerId: callerIdOf(call),
    testCall: call.caller?.testCall === true,
    country: call.country,
    facts: () =>
      stepFacts({
        today: collect.today(),
        hours: call.businessHours?.summary,
        address: call.assistant?.business_profile?.address,
      }),
  }
  const filler = toolFiller(session, line => speak(line), { stillLine: () => lines().stillChecking })
  const agent = new CallAgent(
    { instructions, tools: assistantTools(api, call, log, endCall, flagUrgent, transfer, collect, filler) },
    filler.busy,
  )
  switched.to = () => {
    const failed = (e: unknown) =>
      console.warn(`call ${call.callId}: reply language not updated: ${e instanceof Error ? e.message : String(e)}`)
    void agent.updateInstructions(instructionsNow()).catch(failed)
    void collect.step?.languageChanged(collect.languageRule?.()).catch(failed)
  }
  if (stages) void warmUpLlm(stages.llm, instructions)
  if (notes && realtimeUsage) keepRealtimeHistory(session, agent, notes, realtimeUsage, call.callId)
  await session.start({
    agent,
    room: ctx.room,
    // Linked to the caller when known by now, else to the first participant that joins (only the caller does).
    inputOptions: {
      ...(callerIdentity ? { participantIdentity: callerIdentity } : {}),
      participantKinds: ALL_PARTICIPANT_KINDS,
      closeOnDisconnect: true,
    },
  })
  setup.mark('session')
  // A member can take the call over from the web app at any point now (call.takeOver).
  const stopWatching = watchTakeOver({
    room: ctx.room,
    session,
    log,
    stopRecording: stopRecordingForTransfer,
    sayLine,
    line: name => lines().takeOver(name),
    endCall: deleteRoom,
  })
  session.on(voice.AgentSessionEventTypes.Close, stopWatching)
  void callerDetails
    .then(async details => {
      if (!details) return
      known.details = details
      await agent.updateInstructions(instructionsNow())
    })
    .catch(e =>
      console.warn(
        `call ${call.callId}: caller details not given to the assistant: ${e instanceof Error ? e.message : String(e)}`,
      ),
    )
  if (!stages || !key) {
    // A realtime model has no voice provider: it says the greeting itself. A greeting with the caller's details waits for
    // them (at most GREETING_WAIT_MS) and goes to the model filled in; its instructions never hold that greeting (prompt.ts).
    const details = personalGreeting ? await within(callerDetails, GREETING_WAIT_MS, null) : null
    const replies = realtimeLines?.model()?.replies
    if (replies?.serverReplies()) return setup.note('dropped: the realtime model already answered the caller')
    const askedBefore = replies?.asked() ?? 0
    setup.mark('greeting queued')
    const greeting = session.generateReply({
      instructions: realtimeLine(personalGreeting ? fillTemplate(openingOf(call), details) : openingOf(call)),
    })
    // The caller spoke first and the model answered them before the greeting went out: that answer opens the call, and
    // the greeting is dropped instead of following it (or colliding with it: two replies at once). Only while it was
    // not sent yet: interrupting a sent one would cancel the model's answer.
    const stop = replies?.onReply(byServer => {
      stop?.()
      if (byServer && replies.asked() === askedBefore) greeting.interrupt()
    })
    return setup.note('spoken by the realtime model')
  }
  setup.note(
    await greet(session, stages, call, cachedGreeting, key, personalGreeting ? callerDetails : null, () =>
      setup.mark('greeting queued'),
    ),
  )
}

/** The realtime model's tokens for the whole call, logged once when the session closes (cost per minute, per model). */
function logRealtimeUsage(session: voice.AgentSession, callId: string, model: string) {
  const usage = realtimeUsageCounter()
  const startedAt = Date.now()
  session.on(voice.AgentSessionEventTypes.MetricsCollected, ({ metrics }) => usage.add(metrics as RealtimeUsageMetrics))
  session.on(voice.AgentSessionEventTypes.Close, () =>
    console.log(describeRealtimeUsage(callId, model, (Date.now() - startedAt) / 1000, usage.get())),
  )
  return usage
}

/**
 * A long realtime call (research §8.6): the call notes are brought up to date after each line and tool (sent only when a
 * field changed), and the earlier turns are turned into text in rare batches once the conversation is long.
 */
function keepRealtimeHistory(
  session: voice.AgentSession,
  agent: voice.Agent,
  notes: ReturnType<typeof callNotesKeeper>,
  usage: ReturnType<typeof realtimeUsageCounter>,
  callId: string,
) {
  const failed = (e: unknown) =>
    console.warn(`call ${callId}: call notes not updated: ${e instanceof Error ? e.message : String(e)}`)
  const refresh = () => void notes.refresh().catch(failed)
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, refresh)
  session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, refresh)
  const history = realtimeHistoryCompactor(agent, {
    log: line => console.log(`call ${callId}: ${line}`),
    onBatch: () => usage.addHistoryBatch(),
  })
  session.on(voice.AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
    const m = metrics as RealtimeUsageMetrics
    if (m.type === 'realtime_model_metrics' && m.inputTokens) void history.onReply(m.inputTokens)
  })
}

/**
 * transfer_call for this call, from its start: the contacts that take calls now (transferContactsFor). How to dial each
 * is looked up right away, so a transfer does not wait for it, but nothing is dialled until the assistant uses the tool.
 * null: no contact takes calls now (none set up, closed, vacation mode).
 */
function transferFrom(
  ctx: JobContext,
  api: ApiClient,
  call: CallSession,
  config: CallConfig,
  callerJoined: Promise<RemoteParticipant>,
  stopRecording: () => Promise<void>,
  lines: () => SpokenLines,
): Transfer {
  const contacts = transferContactsFor(call.assistant, call.businessHours)
  if (!contacts.length) return null
  const speech = transferSpeechOf(config, call.assistant)
  const dialers = new Map(
    contacts.map(contact => [
      contact.id,
      dialerLookup(
        () => onCallDialerFor(call, contact.number, speech, api),
        message => console.warn(`call ${call.callId}: cannot dial transfer contact ${contact.id}: ${message}`),
      ),
    ]),
  )
  const callerIdentity = callerJoined.then(caller => caller.identity)
  void callerIdentity.catch(() => {}) // the call ends without a caller; nobody waits for it then
  return {
    ctx,
    speech,
    callerIdentity,
    contacts,
    dialerOf: (contact: Dialable) => dialers.get(contact.id)?.() ?? Promise.resolve(null),
    stopRecording,
    lines,
  }
}

async function entry(ctx: JobContext) {
  const setup = setupTimer(describeProcessWait(ctx.info))
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
  // When the agent's audio goes out and is subscribed: on a phone call that is when LiveKit SIP answers (setup-timing.ts).
  watchAgentAudio(ctx.room, setup.mark)
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
  const registered =
    (await early) ??
    (await startCall(api, callOrigin(ctx.job.metadata, (await callerJoined).attributes, ctx.room.name ?? '')))
  setup.mark('registered')
  if (registered.forwardingCheck) {
    // Our own forwarding check arrived: the API recorded it. Nobody is on the line, so nothing is said.
    await ctx.deleteRoom()
    return ctx.shutdown('forwarding check')
  }
  if (registered.blocked) {
    // The API already filed the call: in Spam (blocked caller) or as missed with a callback (busy, over the spending
    // cap, refused by billing). Each caller hears one line first, once the voice is set up.
    await tellCaller(ctx, registered, unansweredLine(registered), ready, callerJoined)
    await ctx.deleteRoom()
    return ctx.shutdown(
      registered.overCap
        ? 'workspace over its monthly spending cap'
        : registered.refused
          ? `refused by billing: ${registered.refused}`
          : registered.busy
            ? 'too many calls at once in the workspace'
            : 'blocked caller',
    )
  }
  // The call-start webhook is asked now, so its answer is on the way while the voice is set up. Not on a test call.
  const callerDetails = registered.businessNumber === null ? Promise.resolve(null) : lookUpCaller(api, registered)
  const readiness = await ready
  if (!readiness.ready) {
    await declineCall(registered, readiness, () => ctx.deleteRoom())
    return ctx.shutdown('assistant not set up')
  }
  // Linedesk Cloud: nothing the workspace may use is set up (not even the Standard defaults, apps/api usage-levels.ts),
  // so the call has no price: not answered, filed as missed like a call before the providers are set up.
  if (registered.usageLevel === 'not_allowed') {
    await declineCall(registered, { reason: notAllowedReason, stages: [] }, () => ctx.deleteRoom())
    return ctx.shutdown('no voice and model the workspace may use')
  }
  setup.mark('providers')
  // The assistant's pipeline (Settings › Assistant); the other one when that is not set up.
  // A call test may compare realtime models without changing the install's (call-test --realtime-model).
  // A realtime call speaks with the assistant's own realtime voice (the server's default when it picked none).
  // The three stages think with the assistant's own language model when it picked one (Settings › Assistant › Voice).
  // Linedesk Cloud: only fallback models of the call's level (withLevelFallbacks).
  // The three stages hear with the speech recognition model of the call's level (withSttModel).
  const warn = (line: string) => console.warn(`call ${registered.callId}: ${line}`)
  // White-label own keys (S7): a call call.start forecast on the partner's own keys runs on them alone, read for this
  // call only; anything missing (the API, a stage) and it runs on the install's and is billed at its level.
  const base = await partnerKeysConfig(api, registered, readiness.config, warn)
  const config = withRealtimeModel(
    withAssistantRealtimeModel(
      withAssistantRealtimeVoice(
        withLevelFallbacks(
          withSttModel(
            withAssistantModel(
              configForAssistant(base, pipelineOfAssistant(registered.assistant), warn),
              registered.assistant?.llm_model,
            ),
            registered.sttModel,
          ),
          registered.usageLevel,
          warn,
        ),
        registered.assistant?.realtime_voice,
      ),
      registered.assistant?.realtime_model,
    ),
    registered.realtimeModel,
  )
  if (isRealtime(config))
    console.log(`call ${registered.callId}: realtime model ${config.realtime.model}, voice ${config.realtime.voice}`)
  const recorder = livekitRecorder(
    config.recording,
    process.env,
    async () => (await api.run(callStartRecording, { callId: registered.callId }, registered)).data!.egressId as string,
  )
  // The recording notice is said only when the call is recorded: with no recording store, or an assistant or workspace
  // that does not record, nothing is.
  const call = announceRecording(registered, recorder !== null)
  // Reported with call.finish: whose keys served the call (only a call that started on the partner's keys).
  if (registered.partnerKeys)
    call.keySources = registered.keySources ?? { stt: 'install', llm: 'install', tts: 'install' }
  const log = new CallLog(call)

  // From here on the call exists and must be finished: on hang-up (session close), on any error
  // while setting up the conversation, and at job shutdown as the last resort.
  const recording = startRecording(recorder, call, ctx.room.name ?? call.callId)
  // Stopped at hang-up, or earlier when a warm transfer connects (the on-call conversation is not recorded).
  const stopCallRecording = async () => stopRecording(recorder, await recording) // at hang-up
  // A transfer only goes ahead when the recording really stopped.
  const stopRecordingForTransfer = async () => stopRecordingOrThrow(recorder, await recording)
  let finished: FinishedCall | null = null
  const finish = () =>
    hangUp({
      stopRecording: stopCallRecording,
      // A recorded call's news may wait for the after-call transcript (finalizeCall).
      finishCall: async () =>
        (finished = await finishCall(call, log, summaryLlm(config), undefined, recorder !== null)),
      saveRecording: async () => saveRecording(api, call, recorder, await recording, RECORDING_WAIT_MS),
      finalize: async saved => finalizeCall(call, log, summaryLlm(config), finished!, saved),
    })
  const finishOnce = once(finish, `could not finish call ${call.callId}`)
  ctx.addShutdownCallback(finishOnce)
  try {
    await converse(
      ctx,
      callerJoined,
      api,
      config,
      call,
      log,
      finishOnce,
      setup,
      stopRecordingForTransfer,
      callerDetails,
    )
  } catch (e) {
    await finishOnce()
    throw e
  }
}

/**
 * The config a call starts from: on the partner's own keys when call.start said so and they cover the assistant's
 * pipeline (partnerCallConfig), else the install's. Sets `call.keySources` to what it picked.
 */
async function partnerKeysConfig(
  api: ReturnType<typeof apiClientFromEnv>,
  call: CallSession,
  install: CallConfig,
  warn: (line: string) => void,
): Promise<CallConfig> {
  if (!call.partnerKeys) return install
  try {
    if (!api.callProviderSettings) throw new Error('this API client cannot read them')
    const partner = parsePartnerSettings(await api.callProviderSettings(call.callId))
    const picked = partnerCallConfig(partner, install.recording, pipelineOfAssistant(call.assistant))
    if (picked) {
      call.keySources = picked.keySources
      console.log(`call ${call.callId}: on the partner's own provider keys`)
      return picked.config
    }
    warn("the partner's own keys do not cover this call's pipeline: the install's keys answer, the call is billed")
  } catch (e) {
    warn(
      `could not read the partner's own keys, the install's keys answer and the call is billed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  call.keySources = isRealtime(install) ? { realtime: 'install' } : { stt: 'install', llm: 'install', tts: 'install' }
  return install
}

/** Why a call on Linedesk Cloud is not answered when its usage level is still `not_allowed` at call start. */
export const notAllowedReason =
  'usage level not_allowed: no Standard voice and language model is set up on this install'

/** How long an unanswered call waits for the caller to be in the room before it hangs up without the line. */
const BUSY_CALLER_WAIT_MS = 5000

/** Plays `line` to the caller once they are in the room, in the voice of the assistant's pipeline; nothing when no voice is set up. */
async function tellCaller(
  ctx: JobContext,
  call: CallSession,
  line: string,
  ready: Promise<Readiness>,
  callerJoined: Promise<RemoteParticipant>,
) {
  const readiness = await ready
  if (!readiness.ready) return
  const config = withAssistantRealtimeVoice(
    configForAssistant(readiness.config, pipelineOfAssistant(call.assistant), () => {}),
    call.assistant?.realtime_voice,
  )
  const joined = await Promise.race([
    callerJoined.then(
      () => true,
      () => false,
    ),
    sleep(BUSY_CALLER_WAIT_MS).then(() => false),
  ])
  if (joined) await playLine(ctx.room, lineVoiceOf(config, call.assistant), call, line)
}

/** call.start for an origin known before joining; null when it is not known or the request failed. */
async function registerEarly(ctx: JobContext, api: ApiClient): Promise<CallSession | null> {
  try {
    const origin = await earlyOrigin(ctx.job.metadata, ctx.job.room?.name ?? '', livekitParticipants())
    return origin ? await startCall(api, origin) : null
  } catch (e) {
    console.warn(
      `call could not be registered before joining, trying after: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  }
}

async function runAsTestCaller(ctx: JobContext, scenario: TestCallerMetadata) {
  const readiness = await checkReadiness(loadAgentConfig)
  const stages = readiness.ready ? stagesOf(readiness.config) : null
  if (!stages) {
    console.error(
      `test caller cannot call: ${readiness.ready ? 'it talks through speech to text, language model and voice, which are not set up' : readiness.reason}`,
    )
    return ctx.deleteRoom()
  }
  // The load test asks for the three stages only: then the caller's voice is never OpenAI's with the realtime key.
  const openAi =
    !scenario.threeStage && readiness.ready && isRealtime(readiness.config) ? readiness.config.realtime : null
  await runTestCaller(ctx, scenario, stages, openAi)
}

async function runAsOnCallResponder(ctx: JobContext, responder: OnCallResponderMetadata) {
  const readiness = await checkReadiness(loadAgentConfig)
  const stages = readiness.ready ? stagesOf(readiness.config) : null
  if (!stages) {
    console.error(
      `on-call responder cannot answer: ${readiness.ready ? 'it talks through speech to text, language model and voice, which are not set up' : readiness.reason}`,
    )
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
    const tokenProblem = agentTokenProblem(process.env.AGENT_API_TOKEN, {
      production: process.env.NODE_ENV === 'production',
    })
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
  // The API counts the agent as running by its last settings read (Server admin › Overview, the test call's check):
  // read them on a timer too, not only when a call comes, so a test call is not refused after the API restarts.
  setInterval(() => void loadAgentConfig().catch(() => {}), SETTINGS_TTL_MS + 1000).unref()
  // Processes kept warm for the next call: a call takes one, and a phone call test two (the test caller and the
  // business), while the next one starts (a new process needs ~2 s of CPU). The SDK loads up to one new process per CPU at
  // once (at most four; our patch, LIN-226), so calls beyond the warm ones that start together wait for those (LIN-465).
  // docker-compose.yml sets 1 unless the install's .env says otherwise; 3 is the default outside compose.
  const numIdleProcesses = Number(process.env.AGENT_IDLE_PROCESSES) || 3
  // How long a new process may take to load the agent. Under a running call on a small box this takes
  // well over the library's 10 s, and a process that times out is killed and started again in a loop.
  const initializeProcessTimeout = Number(process.env.AGENT_INIT_TIMEOUT_MS) || 60_000
  // Whether the worker ever reports itself full because of CPU load (worker-load.ts): by default never, since the load
  // is the whole machine's and one worker that is "full" leaves every call unanswered. AGENT_LOAD_THRESHOLD turns it
  // on for installs with more than one worker; docker-compose.yml gives LiveKit's agents.target_load the same value.
  const load = loadPolicy(process.env.AGENT_LOAD_THRESHOLD)
  console.log(describeLoadPolicy(load))
  console.log(
    `Processes kept warm for the next calls: ${numIdleProcesses} (AGENT_IDLE_PROCESSES). In a burst of more calls, each further call waits for a new process to load.`,
  )
  // On SIGTERM (an update) the worker takes no new calls and finishes the ones it has. A call put through to a
  // person lasts up to CALL_MAX_MINUTES, longer than the library's 60 minutes; the container's
  // stop_grace_period (LINEDESK_AGENT_DRAIN) is a little longer again, so this limit is the one that applies.
  const drainTimeout = (CALL_MAX_MINUTES + 5) * 60_000
  const options = new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: workerAgentName(),
    numIdleProcesses,
    loadThreshold: load.threshold,
    initializeProcessTimeout,
    drainTimeout,
  })
  // The SDK's own measure (its default loadFunc), with the overload warning and the cap LiveKit needs (worker-load.ts).
  options.loadFunc = reportedLoad(options.loadFunc, load, line => console.warn(line))
  // No local end-of-turn model and no process for it: no call uses it (env.ts).
  turnOffLocalInference()
  // The event-loop monitor checks every 50 ms instead of 20 ms, in idle processes too (env.ts).
  slowLoopMonitor()
  cli.runApp(options)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
