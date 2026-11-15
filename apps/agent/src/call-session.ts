// One call as the agent sees it: start, append transcript segments, finish.
import {
  type CallerAttestation,
  BEHAVIOUR_IDS,
  type BookingContext,
  type CallerHistory,
  callAppendTranscript,
  callFinish,
  callRecordTimings,
  callReportVoiceFailure,
  providerReportOk,
  type ProviderName,
  type ReportVoiceFailureData,
  callStart,
  callStartTest,
  DEFAULT_AI_DISCLOSURE,
  ASSISTANT_CALL_MAX_MINUTES,
  DEMO_CALL_LIMIT_LINE,
  DEMO_CALL_MAX_SECONDS,
  DEMO_OPENING_SUFFIX,
  type SpokenLines,
  greetingWithDisclosure,
  type Language,
  languageCodes,
  localizedDefault,
  mainLanguageOf,
  silenceClosingOf,
  spokenLines,
  VOICE_PIPELINES,
  type VoiceFailure,
  type VoicePipeline,
} from '@linedesk/actions'
import {
  type Assistant,
  type Contact,
  DEFAULT_TRANSFERS,
  type ToolEvent,
  type TransferContact,
  type WebhookLookup,
} from '@linedesk/db/types'
import type { z } from 'zod'
import type { ApiClient } from './api-client.ts'
import { callerAttestation, spamLikely, warnIfNoSipHeaders } from './caller-attestation.ts'
import { type SimulatedAnswer, simulatedAnswers } from './on-call-dialer.ts'
import { type CallerContext, forHours } from './prompt.ts'

export type Speaker = z.input<typeof callAppendTranscript.input>['speaker']
export type CallResult = Omit<z.input<typeof callFinish.input>, 'callId'>

/**
 * The business's hours as `call.start` reports them: `summary` is a ready sentence for the assistant.
 * `closure`: vacation or closure mode is on today (its greeting); nobody is put through then.
 */
export type BusinessHours = { openNow: boolean; summary: string; closure?: { greeting: string } }

export interface CallSession {
  callId: string
  workspaceId: string
  /** The call token from `call.start` for every later request about this call; missing from an older API. */
  token?: string
  assistant: Assistant | null
  /** null: the caller ID is withheld or not a number ("anonymous"), so the caller has no contact. */
  contact: Contact | null
  /**
   * Hang up without answering: the API filed the call already, in Spam (a blocked number) or as missed (`busy`,
   * the workspace has as many calls in progress as its assistant answers at once, or `overCap`, it reached its
   * monthly spending cap).
   */
  blocked: boolean
  /** Linedesk's own forwarding check arriving (blocked too): hang up at once, without a word; nothing is filed. */
  forwardingCheck: boolean
  busy: boolean
  overCap: boolean
  /** null: the business has no hours set, and the assistant says nothing about them. */
  businessHours: BusinessHours | null
  /** What the assistant can book; null: no appointment type or no calendar, so it only takes messages. */
  booking: BookingContext | null
  /** What the assistant can ask the business's system during the call (its webhook's lookups); none: no such tools. */
  lookups: WebhookLookup[]
  /** false: the workspace keeps no recordings (Settings, Recordings: Don't keep), so the call is not recorded. Missing: record. */
  keepRecording?: boolean
  /**
   * The workspace's recording notice from call.start (null: off). Not in the greeting yet: it is added only once the
   * worker knows this agent records (announceRecording), so nobody hears it on a server that records nothing.
   */
  recordingNotice?: string | null
  /**
   * The matched contact with their last calls and upcoming bookings, and whether the greeting used their first
   * name (then it is not the cached greeting); null: no contact (withheld number).
   */
  caller: CallerContext | null
  /** The business's time zone, for the date and time the assistant is told; null from an older API (then booking's, if any). */
  timeZone: string | null
  /** The business's Linedesk number the caller dialled (a transfer shows it as caller ID); null for a test call. */
  businessNumber: string | null
  /** No-phone call test or a test call from the web app: a simulated on-call person answers transfers instead of a phone. */
  simulatedOnCall: SimulatedAnswer | null
  /** What the simulated person says once put through; missing: the call test's line (GREETING_LINE). */
  simulatedOnCallLine?: string
  /** A call test's realtime model instead of the install's (call-test --realtime-model); missing on every other call. */
  realtimeModel?: string
  /**
   * A public demo call from a website (apps/api/src/demo-call.ts): it ends after DEMO_CALL_MAX_SECONDS with
   * DEMO_CALL_LIMIT_LINE, and its opening says it is a demo. Missing on every other call.
   */
  demo?: boolean
  /**
   * The workspace's country (ISO 3166-1 alpha-2): the region phone numbers the caller says are read in ("0151…" in
   * Germany). Missing: 'US'.
   */
  country?: string
  /** The workspace language: what the summary and messages for the team are written in. Missing: 'en'. */
  teamLanguage?: string
  append(speaker: Speaker, text: string, toolEvent?: ToolEvent): Promise<void>
  finish(result: CallResult): Promise<void>
  /** Stores how long the replies took (call.recordTimings), for the admin overview. */
  recordTimings(timings: CallTimings): Promise<void>
  /** Marks the call with a failed stage of the voice pipeline (call.reportVoiceFailure); the failure as kept, refined. */
  reportVoiceFailure?(failure: VoiceFailure): Promise<VoiceFailure>
  /** Providers that worked on this call (provider.reportOk): a failure recorded for them before is over. */
  reportProvidersOk?(providers: ProviderName[]): Promise<void>
}

/** The replies' times of one call and who did each part (call.recordTimings without the call id). */
export type CallTimings = Omit<z.input<typeof callRecordTimings.input>, 'callId'>

type StartData = Pick<CallSession, 'callId' | 'workspaceId' | 'assistant' | 'contact'> & {
  callToken?: string
  blocked?: boolean
  forwardingCheck?: boolean
  busy?: boolean
  overCap?: boolean
  businessHours?: BusinessHours | null
  booking?: BookingContext | null
  /** The workspace's recording notice, said right after the greeting; null or missing: off. */
  recordingNotice?: string | null
  /** Missing (older API): recordings are kept. */
  keepRecording?: boolean
  /** A phone caller matched to a contact: their last calls and upcoming bookings; null or missing (older API): none. */
  callerHistory?: CallerHistory | null
  /** The workspace's time zone; missing from an older API. */
  timeZone?: string | null
  /** The webhook's during-call lookups; missing from an older API. */
  lookups?: WebhookLookup[]
  /** The workspace's country and language as they apply (workspace-locale.ts); missing from an older API: US, English. */
  workspaceCountry?: string
  workspaceLanguage?: string
}

/**
 * The assistant with its main language: the one it has; without one, the workspace language when calls can be answered
 * in it (a German workspace greets in German), else English as before.
 */
export function withWorkspaceLanguage(assistant: Assistant | null, workspaceLanguage: string | null | undefined): Assistant | null {
  if (!assistant || assistant.languages?.main) return assistant
  const main = mainLanguageOf(assistant.languages, workspaceLanguage)
  if (main === 'en') return assistant
  return { ...assistant, languages: { ...(assistant.languages ?? { mode: 'english', allowed: [] }), main } }
}

/**
 * The caller for the prompt: the matched contact's name and note, and their history when call.start sent it.
 * `nameConfirmed` (the team gave or confirmed the name) is only for what a person is told about the caller (a
 * transfer's briefing); the prompt has no name check.
 */
export function callerOf(
  contact: Contact | null,
  history: CallerHistory | null | undefined,
  { testCall = false }: { testCall?: boolean } = {},
): CallerContext | null {
  if (!contact) return null
  const nameConfirmed = !!contact.name?.trim() && contact.name_source === 'member'
  return {
    name: contact.name,
    note: contact.note,
    phone: contact.phone,
    nameConfirmed,
    history: history ?? null,
    ...(testCall ? { testCall } : {}),
  }
}

/** The greeting with the AI note when the assistant says it at the start; an API of an older version sends no mode. */
export function withAiNote(assistant: Assistant | null): Assistant | null {
  if (!assistant?.greeting) return assistant
  const mode = assistant.ai_disclosure ?? DEFAULT_AI_DISCLOSURE
  return {
    ...assistant,
    greeting: greetingWithDisclosure(assistant.greeting, assistant.name, mode, mainLanguageOf(assistant.languages)),
  }
}

/**
 * The owner's texts as the call says them in the assistant's main language: a text that is still the English
 * default (greeting, closing line) becomes that language's default; written ones stay.
 */
export function inMainLanguage(assistant: Assistant | null): Assistant | null {
  const main = mainLanguageOf(assistant?.languages)
  if (!assistant || main === 'en') return assistant
  const local = (text: string) => localizedDefault(text, main)
  return {
    ...assistant,
    greeting: local(assistant.greeting),
    greeting_outside: assistant.greeting_outside ? local(assistant.greeting_outside) : assistant.greeting_outside,
    silence_closing: local(silenceClosingOf(assistant.silence_closing)),
  }
}

/**
 * The greeting followed by the recording notice (the English default in the main language), said and cached as one
 * opening. An assistant without a greeting opens with the fallback greeting, as it would without the notice.
 */
export function withRecordingNotice(assistant: Assistant | null, notice: string | null | undefined): Assistant | null {
  const language = mainLanguageOf(assistant?.languages)
  const sentence = notice?.trim() ? localizedDefault(notice.trim(), language) : null
  if (!assistant || !sentence) return assistant
  const greeting = assistant.greeting?.trim() || spokenLines(language).fallbackGreeting
  return { ...assistant, greeting: `${greeting} ${sentence}` }
}

/** A test call from the web app ends by itself after this long, so a forgotten browser tab does not run up provider minutes. */
export const TEST_CALL_LIMIT_MS = 5 * 60_000

/**
 * How long the assistant stays on the call and what it says then: a public demo call DEMO_CALL_MAX_SECONDS, a test
 * call from the web app TEST_CALL_LIMIT_MS, a phone call the assistant's own limit, never above
 * ASSISTANT_CALL_MAX_MINUTES (an older API sends none).
 */
export function callLimitOf(
  call: Pick<CallSession, 'demo' | 'businessNumber' | 'assistant'>,
  lines: Pick<SpokenLines, 'callLimit' | 'testCallLimit'>,
): { ms: number; line: string } {
  if (call.demo) return { ms: DEMO_CALL_MAX_SECONDS * 1000, line: DEMO_CALL_LIMIT_LINE }
  if (call.businessNumber === null) return { ms: TEST_CALL_LIMIT_MS, line: lines.testCallLimit }
  const minutes = Math.min(call.assistant?.max_call_minutes ?? ASSISTANT_CALL_MAX_MINUTES, ASSISTANT_CALL_MAX_MINUTES)
  return { ms: minutes * 60_000, line: lines.callLimit }
}

/** The greeting followed by the sentence that says this is a public demo call, said and cached as one opening. */
export function withDemoOpening(assistant: Assistant | null): Assistant | null {
  if (!assistant) return assistant
  const greeting = assistant.greeting?.trim()
  return { ...assistant, greeting: greeting ? `${greeting} ${DEMO_OPENING_SUFFIX}` : DEMO_OPENING_SUFFIX }
}

/**
 * Whether the call is to be recorded, given that this agent can record: not when its assistant does not record calls
 * or its workspace keeps no recordings (Settings, Recordings: Don't keep).
 */
export const callWantsRecording = (call: Pick<CallSession, 'assistant' | 'keepRecording'>): boolean =>
  call.assistant?.record_calls !== false && call.keepRecording !== false

/**
 * The call with the recording notice after its greeting when the call is recorded: this agent can record (a recording
 * store is set up, in Linedesk or in RECORDING_STORE) and the call wants a recording (callWantsRecording). Otherwise
 * nothing is recorded, so the assistant does not say the call may be; the workspace's notice setting stays as saved
 * and applies once calls are recorded.
 */
export function announceRecording(call: CallSession, canRecord: boolean): CallSession {
  if (!canRecord || !callWantsRecording(call) || !call.recordingNotice) return call
  return { ...call, assistant: withRecordingNotice(call.assistant, call.recordingNotice) }
}

/**
 * Where a call comes from. A test call may bring `businessHours` to use instead of the workspace's
 * (the call test sets "closed" for its after-hours scenario without touching the real settings).
 */
export type CallOrigin =
  | { kind: 'phone'; from: string; to: string; room?: string; simulated?: boolean; attestation?: CallerAttestation; spamLikely?: boolean }
  | ({ kind: 'test'; room: string } & TestMetadata)

/**
 * The call test's simulated on-call person and the number it stands in for (transfer is on for the test).
 * `for`: which calls go to it, urgent ones (default) or callers who ask for a person. `backup`: a second urgent
 * contact with the same condition, tried next (both answer as `answer`).
 */
export type SimulatedOnCall = { answer: SimulatedAnswer; number: string; for?: 'urgent' | 'person'; backup?: boolean }

/** The second contact of a `backup` test: Mike's condition, its own number, rings shorter so the test stays short. */
export const SIMULATED_BACKUP_NUMBER = '+15035550188'

/** The call test's transfer contacts: the simulated on-call person, and with `backup` a second one tried next. */
export function simulatedContacts({
  number,
  for: forCalls,
  backup,
}: Pick<SimulatedOnCall, 'number' | 'for' | 'backup'>): TransferContact[] {
  const first = simulatedContact(number, forCalls)
  if (!backup) return [first]
  return [
    { ...first, if_no_answer: 'next', ring_seconds: 15 },
    { ...first, id: 'backup', name: 'Sarah', number: SIMULATED_BACKUP_NUMBER, ring_seconds: 15 },
  ]
}

/** The call test's only transfer contact: the simulated on-call person, for urgent calls or for callers who ask for a person. */
export const simulatedContact = (number: string, forCalls: SimulatedOnCall['for'] = 'urgent'): TransferContact =>
  forCalls === 'person'
    ? { ...DEFAULT_TRANSFERS[0]!, name: 'Mike', number, hours_only: false }
    : {
        id: 'oncall',
        name: 'Mike',
        number,
        condition: 'Urgent: a burst pipe, flooding, a gas smell or no heat in freezing weather',
        hours_only: false,
        ring_seconds: 25,
        if_no_answer: 'message',
        enabled: true,
      }

/** What a test room's job metadata may carry: the workspace, and settings the call test uses instead of the assistant's. */
type TestMetadata = {
  workspaceId: string
  assistantId?: string
  businessHours?: BusinessHours
  outsideGreeting?: string
  onCall?: SimulatedOnCall
  /** A test call from the web app: transfers reach a simulated person who accepts (TEST_CALL_ON_CALL_LINE). */
  simulateTransfer?: boolean
  /** A public demo call from a website (CallSession.demo). */
  demo?: boolean
  /** Languages besides English the assistant speaks on this test call. */
  languages?: Language[]
  /** The one language the assistant speaks on this test call, instead of its own setting. */
  mainLanguage?: Language
  /** How this test call is answered instead of the assistant's own choice (call-test --pipeline). */
  pipeline?: VoicePipeline
  /** The realtime model this test call uses instead of the install's (call-test --realtime-model). */
  realtimeModel?: string
  /** A returning caller this test call plays (call-test returning-caller): a saved contact with a note and history. */
  caller?: TestCaller
  /** Behaviour switches this test call uses instead of the assistant's (call-test spoofed-cancel). */
  behaviours?: Record<string, boolean>
}

/** The caller a call test plays: the contact's name, the team's note and the records call.start would send. */
export type TestCaller = { name: string; note?: string; phone: string; history?: CallerHistory }

/** Behaviour switches from job metadata: only known ids with true or false. */
function testBehaviours(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entries = Object.entries(value).filter(([id, on]) => (BEHAVIOUR_IDS as readonly string[]).includes(id) && typeof on === 'boolean')
  return entries.length ? (Object.fromEntries(entries) as Record<string, boolean>) : undefined
}

/** A test caller from job metadata; only plain strings and the history's shape, else none. */
function parseTestCaller(value: unknown): TestCaller | undefined {
  const c = value as Partial<TestCaller> | undefined
  if (!c || typeof c.name !== 'string' || !c.name.trim() || typeof c.phone !== 'string') return undefined
  const h = c.history as Partial<CallerHistory> | undefined
  const history = h && Array.isArray(h.recentCalls) && Array.isArray(h.upcomingBookings) ? (h as CallerHistory) : undefined
  return { name: c.name, phone: c.phone, ...(typeof c.note === 'string' ? { note: c.note } : {}), ...(history ? { history } : {}) }
}

/** An OpenAI realtime model id a test call may ask for: gpt-realtime, gpt-realtime-mini, a dated one. */
export const isRealtimeModelId = (value: unknown): value is string =>
  typeof value === 'string' && /^gpt-realtime[a-z0-9.-]{0,40}$/.test(value)

export async function startCall(api: ApiClient, origin: CallOrigin): Promise<CallSession> {
  const { data } =
    origin.kind === 'phone'
      ? await api.run(callStart, {
          from: origin.from, to: origin.to, room: origin.room,
          ...(origin.simulated ? { source: 'simulated' as const } : {}),
          ...(origin.attestation ? { attestation: origin.attestation } : {}),
          ...(origin.spamLikely ? { spamLikely: true } : {}),
        })
      : await api.run(
          callStartTest,
          { room: origin.room, ...(origin.assistantId ? { assistantId: origin.assistantId } : {}) },
          { workspaceId: origin.workspaceId },
        )
  const started = data as StartData
  const { callId, workspaceId, contact, blocked = false, forwardingCheck = false, busy = false, overCap = false } = started
  const scope = { workspaceId, ...(started.callToken ? { token: started.callToken } : {}) }
  const businessHours = (origin.kind === 'test' && origin.businessHours) || started.businessHours || null
  // The call test may set an outside greeting to check without touching the real assistant.
  const outsideGreeting = origin.kind === 'test' ? origin.outsideGreeting : undefined
  const onCall = origin.kind === 'test' ? origin.onCall : undefined
  const languages = origin.kind === 'test' ? origin.languages : undefined
  const mainLanguage = origin.kind === 'test' ? origin.mainLanguage : undefined
  const pipeline = origin.kind === 'test' ? origin.pipeline : undefined
  const behaviours = origin.kind === 'test' ? origin.behaviours : undefined
  const own = withWorkspaceLanguage(started.assistant, started.workspaceLanguage)
  const configured =
    own && (outsideGreeting || onCall || languages || mainLanguage || pipeline || behaviours)
      ? {
          ...own,
          ...(behaviours ? { behaviours: { ...(own.behaviours ?? {}), ...behaviours } } : {}),
          ...(outsideGreeting ? { greeting_outside: outsideGreeting } : {}),
          ...(onCall ? { transfers: simulatedContacts(onCall) } : {}),
          ...(languages ? { languages: { ...(own.languages?.main ? { main: own.languages.main } : {}), mode: 'allowed' as const, allowed: languages } } : {}),
          ...(mainLanguage ? { languages: { main: mainLanguage, mode: 'english' as const, allowed: [] } } : {}),
          ...(pipeline ? { voice_pipeline: pipeline } : {}),
        }
      : own
  // The greeting and instructions that apply now: outside business hours, the outside variants.
  // …with the AI note (and in the consent mode the question) the owner chose for the start of the call.
  // The recording notice is added later, once it is known that the call is recorded (announceRecording).
  // A public demo call says that it is one right after the greeting.
  const demo = origin.kind === 'test' && origin.demo === true
  const greeted = withAiNote(forHours(inMainLanguage(configured), businessHours))
  const assistant = demo ? withDemoOpening(greeted) : greeted
  // A test room (the web app's test call, a call test): there is no caller ID, and the prompt says so (B4).
  const played = origin.kind === 'test' ? origin.caller : undefined
  const caller = played
    ? { name: played.name, note: played.note ?? null, phone: played.phone, history: played.history ?? null }
    : callerOf(contact, started.callerHistory, { testCall: origin.kind === 'test' })
  const booking = started.booking ?? null
  const startedAt = Date.now()
  return {
    callId,
    ...scope,
    assistant,
    contact,
    blocked,
    forwardingCheck,
    busy,
    overCap,
    businessHours,
    booking,
    caller,
    timeZone: started.timeZone ?? booking?.timeZone ?? null,
    keepRecording: started.keepRecording !== false,
    recordingNotice: started.recordingNotice?.trim() || null,
    lookups: started.lookups ?? [],
    country: started.workspaceCountry ?? 'US',
    teamLanguage: started.workspaceLanguage ?? 'en',
    businessNumber: origin.kind === 'phone' ? origin.to : null,
    ...(origin.kind === 'test' && origin.realtimeModel ? { realtimeModel: origin.realtimeModel } : {}),
    ...(demo ? { demo: true } : {}),
    ...simulatedOnCallOf(origin),
    async append(speaker, text, toolEvent) {
      await api.run(callAppendTranscript, { callId, speaker, text, atMs: Date.now() - startedAt, toolEvent }, scope)
    },
    async finish(result) {
      await api.run(callFinish, { callId, ...result }, scope)
    },
    async recordTimings(timings) {
      await api.run(callRecordTimings, { callId, ...timings }, scope)
    },
    async reportVoiceFailure(failure) {
      const result = await api.run(callReportVoiceFailure, { callId, failure }, scope)
      return (result.data as ReportVoiceFailureData | undefined)?.failure ?? failure
    },
    async reportProvidersOk(providers) {
      if (providers.length) await api.run(providerReportOk, { providers }, scope)
    },
  }
}

/** What the simulated person says on a test call from the web app, once put through. */
export const TEST_CALL_ON_CALL_LINE =
  'This is the simulated on-call person for your test call. On a real call, the person you set up would be talking to you now. Goodbye.'

/** Who answers a transfer on a test call: the call test's simulated person, or on a web app test call one who accepts. */
function simulatedOnCallOf(origin: CallOrigin): Pick<CallSession, 'simulatedOnCall' | 'simulatedOnCallLine'> {
  if (origin.kind !== 'test') return { simulatedOnCall: null }
  if (origin.onCall) return { simulatedOnCall: origin.onCall.answer }
  return origin.simulateTransfer
    ? { simulatedOnCall: 'accept', simulatedOnCallLine: TEST_CALL_ON_CALL_LINE }
    : { simulatedOnCall: null }
}

/**
 * Where the call comes from. A test room from the web app carries `{ source: 'test', workspaceId, assistantId? }`
 * in the job metadata the API signed into the browser's token; anything else is a phone call, with
 * caller and dialled number in the attributes LiveKit SIP sets (the talk page sets the same ones).
 */
export function callOrigin(jobMetadata: string, attributes: Record<string, string>, room: string): CallOrigin {
  const test = parseTestMetadata(jobMetadata)
  if (test) return { kind: 'test', room, ...test }
  const to = attributes['sip.trunkPhoneNumber']
  if (!to) throw new Error('participant has no sip.trunkPhoneNumber attribute')
  // A withheld number may come without any caller ID: it is registered as such, never as someone's number.
  const from = attributes['sip.phoneNumber'] || 'anonymous'
  warnIfNoSipHeaders(attributes)
  const attestation = callerAttestation(attributes)
  return { kind: 'phone', from, to, room, ...(attestation ? { attestation } : {}), ...(spamLikely(attributes) ? { spamLikely: true } : {}) }
}

/** The workspace (and the assistant picked in the web app) of a test room the API signed, or null for any other room. */
export function parseTestMetadata(metadata: string): TestMetadata | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as {
      source?: unknown
      workspaceId?: unknown
      assistantId?: unknown
      businessHours?: unknown
      outsideGreeting?: unknown
      onCall?: unknown
      simulateTransfer?: unknown
      demo?: unknown
      languages?: unknown
      mainLanguage?: unknown
      pipeline?: unknown
      realtimeModel?: unknown
      caller?: unknown
      behaviours?: unknown
    }
    if (parsed.source !== 'test' || typeof parsed.workspaceId !== 'string' || !parsed.workspaceId) return null
    const hours = parsed.businessHours as Partial<BusinessHours> | undefined
    const businessHours =
      hours && typeof hours.openNow === 'boolean' && typeof hours.summary === 'string'
        ? { openNow: hours.openNow, summary: hours.summary }
        : undefined
    const assistantId = typeof parsed.assistantId === 'string' && parsed.assistantId ? parsed.assistantId : undefined
    const outsideGreeting =
      typeof parsed.outsideGreeting === 'string' && parsed.outsideGreeting ? parsed.outsideGreeting : undefined
    const onCall = parseSimulatedOnCall(parsed.onCall)
    const languages = Array.isArray(parsed.languages)
      ? languageCodes.filter(code => code !== 'en').filter(code => (parsed.languages as unknown[]).includes(code))
      : []
    return {
      workspaceId: parsed.workspaceId,
      ...(assistantId ? { assistantId } : {}),
      ...(businessHours ? { businessHours } : {}),
      ...(outsideGreeting ? { outsideGreeting } : {}),
      ...(onCall ? { onCall } : {}),
      ...(parsed.simulateTransfer === true ? { simulateTransfer: true } : {}),
      ...(parsed.demo === true ? { demo: true } : {}),
      ...(languages.length ? { languages } : {}),
      ...((languageCodes as readonly unknown[]).includes(parsed.mainLanguage) ? { mainLanguage: parsed.mainLanguage as Language } : {}),
      ...((VOICE_PIPELINES as readonly unknown[]).includes(parsed.pipeline)
        ? { pipeline: parsed.pipeline as VoicePipeline }
        : {}),
      ...(isRealtimeModelId(parsed.realtimeModel) ? { realtimeModel: parsed.realtimeModel } : {}),
      ...(parseTestCaller(parsed.caller) ? { caller: parseTestCaller(parsed.caller) } : {}),
      ...(testBehaviours(parsed.behaviours) ? { behaviours: testBehaviours(parsed.behaviours) } : {}),
    }
  } catch {
    return null
  }
}

function parseSimulatedOnCall(value: unknown): SimulatedOnCall | undefined {
  const v = value as Partial<SimulatedOnCall> | undefined
  if (!v || typeof v.number !== 'string' || !/^\+\d{8,15}$/.test(v.number)) return undefined
  if (!simulatedAnswers.includes(v.answer as SimulatedAnswer)) return undefined
  return {
    answer: v.answer as SimulatedAnswer,
    number: v.number,
    ...(v.for === 'person' ? { for: 'person' as const } : {}),
    ...(v.backup === true ? { backup: true } : {}),
  }
}
