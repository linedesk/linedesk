// One call as the agent sees it: start, append transcript segments, finish.
import { type BookingContext, type CallerHistory, callAppendTranscript, callFinish, callStart, callStartTest, DEFAULT_AI_DISCLOSURE, greetingWithDisclosure, type Language, languageCodes, localizedDefault, mainLanguageOf, silenceClosingOf } from '@linedesk/actions'
import { type Assistant, type Contact, DEFAULT_TRANSFERS, type ToolEvent, type TransferContact, type WebhookLookup } from '@linedesk/db/types'
import type { z } from 'zod'
import type { ApiClient } from './api-client.ts'
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
  append(speaker: Speaker, text: string, toolEvent?: ToolEvent): Promise<void>
  finish(result: CallResult): Promise<void>
}

type StartData = Pick<CallSession, 'callId' | 'workspaceId' | 'assistant' | 'contact'> & {
  callToken?: string
  blocked?: boolean
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
}

/** The caller for the prompt: the matched contact's name and note, and their history when call.start sent it. */
export function callerOf(contact: Contact | null, history: CallerHistory | null | undefined): CallerContext | null {
  return contact ? { name: contact.name, note: contact.note, phone: contact.phone, history: history ?? null } : null
}

/** The greeting with the AI note when the assistant says it at the start; an API of an older version sends no mode. */
export function withAiNote(assistant: Assistant | null): Assistant | null {
  if (!assistant?.greeting) return assistant
  const mode = assistant.ai_disclosure ?? DEFAULT_AI_DISCLOSURE
  return { ...assistant, greeting: greetingWithDisclosure(assistant.greeting, assistant.name, mode, mainLanguageOf(assistant.languages)) }
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

/** The greeting followed by the recording notice (the English default in the main language), said and cached as one opening. */
export function withRecordingNotice(assistant: Assistant | null, notice: string | null | undefined): Assistant | null {
  const sentence = notice?.trim() ? localizedDefault(notice.trim(), mainLanguageOf(assistant?.languages)) : null
  if (!assistant || !sentence) return assistant
  const greeting = assistant.greeting?.trim()
  return { ...assistant, greeting: greeting ? `${greeting} ${sentence}` : sentence }
}

/**
 * Where a call comes from. A test call may bring `businessHours` to use instead of the workspace's
 * (the call test sets "closed" for its after-hours scenario without touching the real settings).
 */
export type CallOrigin =
  | { kind: 'phone'; from: string; to: string; room?: string }
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
export function simulatedContacts({ number, for: forCalls, backup }: Pick<SimulatedOnCall, 'number' | 'for' | 'backup'>): TransferContact[] {
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
    : { id: 'oncall', name: 'Mike', number, condition: 'Urgent: a burst pipe, flooding, a gas smell or no heat in freezing weather', hours_only: false, ring_seconds: 25, if_no_answer: 'message', enabled: true }

/** What a test room's job metadata may carry: the workspace, and settings the call test uses instead of the assistant's. */
type TestMetadata = {
  workspaceId: string
  assistantId?: string
  businessHours?: BusinessHours
  outsideGreeting?: string
  onCall?: SimulatedOnCall
  /** A test call from the web app: transfers reach a simulated person who accepts (TEST_CALL_ON_CALL_LINE). */
  simulateTransfer?: boolean
  /** Languages besides English the assistant speaks on this test call. */
  languages?: Language[]
}

export async function startCall(api: ApiClient, origin: CallOrigin): Promise<CallSession> {
  const { data } = origin.kind === 'phone'
    ? await api.run(callStart, { from: origin.from, to: origin.to, room: origin.room })
    : await api.run(callStartTest, { room: origin.room, ...(origin.assistantId ? { assistantId: origin.assistantId } : {}) }, { workspaceId: origin.workspaceId })
  const started = data as StartData
  const { callId, workspaceId, contact, blocked = false, busy = false, overCap = false } = started
  const scope = { workspaceId, ...(started.callToken ? { token: started.callToken } : {}) }
  const businessHours = (origin.kind === 'test' && origin.businessHours) || started.businessHours || null
  // The call test may set an outside greeting to check without touching the real assistant.
  const outsideGreeting = origin.kind === 'test' ? origin.outsideGreeting : undefined
  const onCall = origin.kind === 'test' ? origin.onCall : undefined
  const languages = origin.kind === 'test' ? origin.languages : undefined
  const configured = started.assistant && (outsideGreeting || onCall || languages)
    ? {
        ...started.assistant,
        ...(outsideGreeting ? { greeting_outside: outsideGreeting } : {}),
        ...(onCall ? { transfers: simulatedContacts(onCall) } : {}),
        ...(languages ? { languages: { mode: 'allowed' as const, allowed: languages } } : {}),
      }
    : started.assistant
  // The greeting and instructions that apply now: outside business hours, the outside variants.
  // …with the AI note (and in the consent mode the question) the owner chose for the start of the call.
  const assistant = withRecordingNotice(withAiNote(forHours(inMainLanguage(configured), businessHours)), started.recordingNotice)
  const caller = callerOf(contact, started.callerHistory)
  const booking = started.booking ?? null
  const startedAt = Date.now()
  return {
    callId, ...scope, assistant, contact, blocked, busy, overCap, businessHours, booking, caller,
    timeZone: started.timeZone ?? booking?.timeZone ?? null,
    keepRecording: started.keepRecording !== false,
    lookups: started.lookups ?? [],
    businessNumber: origin.kind === 'phone' ? origin.to : null,
    ...simulatedOnCallOf(origin),
    async append(speaker, text, toolEvent) {
      await api.run(callAppendTranscript, { callId, speaker, text, atMs: Date.now() - startedAt, toolEvent }, scope)
    },
    async finish(result) {
      await api.run(callFinish, { callId, ...result }, scope)
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
  return origin.simulateTransfer ? { simulatedOnCall: 'accept', simulatedOnCallLine: TEST_CALL_ON_CALL_LINE } : { simulatedOnCall: null }
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
  return { kind: 'phone', from, to, room }
}

/** The workspace (and the assistant picked in the web app) of a test room the API signed, or null for any other room. */
export function parseTestMetadata(metadata: string): TestMetadata | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { source?: unknown; workspaceId?: unknown; assistantId?: unknown; businessHours?: unknown; outsideGreeting?: unknown; onCall?: unknown; simulateTransfer?: unknown; languages?: unknown }
    if (parsed.source !== 'test' || typeof parsed.workspaceId !== 'string' || !parsed.workspaceId) return null
    const hours = parsed.businessHours as Partial<BusinessHours> | undefined
    const businessHours = hours && typeof hours.openNow === 'boolean' && typeof hours.summary === 'string' ? { openNow: hours.openNow, summary: hours.summary } : undefined
    const assistantId = typeof parsed.assistantId === 'string' && parsed.assistantId ? parsed.assistantId : undefined
    const outsideGreeting = typeof parsed.outsideGreeting === 'string' && parsed.outsideGreeting ? parsed.outsideGreeting : undefined
    const onCall = parseSimulatedOnCall(parsed.onCall)
    const languages = Array.isArray(parsed.languages) ? languageCodes.filter(code => code !== 'en').filter(code => (parsed.languages as unknown[]).includes(code)) : []
    return {
      workspaceId: parsed.workspaceId,
      ...(assistantId ? { assistantId } : {}),
      ...(businessHours ? { businessHours } : {}),
      ...(outsideGreeting ? { outsideGreeting } : {}),
      ...(onCall ? { onCall } : {}),
      ...(parsed.simulateTransfer === true ? { simulateTransfer: true } : {}),
      ...(languages.length ? { languages } : {}),
    }
  } catch {
    return null
  }
}

function parseSimulatedOnCall(value: unknown): SimulatedOnCall | undefined {
  const v = value as Partial<SimulatedOnCall> | undefined
  if (!v || typeof v.number !== 'string' || !/^\+\d{8,15}$/.test(v.number)) return undefined
  if (!simulatedAnswers.includes(v.answer as SimulatedAnswer)) return undefined
  return { answer: v.answer as SimulatedAnswer, number: v.number, ...(v.for === 'person' ? { for: 'person' as const } : {}), ...(v.backup === true ? { backup: true } : {}) }
}
