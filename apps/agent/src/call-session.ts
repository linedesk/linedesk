// One call as the agent sees it: start, append transcript segments, finish.
import { type BookingContext, type CallCustomField, type CallDocuments, type CallerHistory, callAppendTranscript, callFinish, callStart, callStartTest, DEFAULT_KNOWN_CALLER_GREETING, EMERGENCY_CONDITION } from '@linedesk/actions'
import type { Assistant, Contact, ToolEvent, TransferContact } from '@linedesk/db/types'
import type { z } from 'zod'
import type { ApiClient } from './api-client.ts'
import { type SimulatedAnswer, simulatedAnswers } from './on-call-dialer.ts'
import { type CallerContext, forHours, personalGreeting } from './prompt.ts'

export type Speaker = z.input<typeof callAppendTranscript.input>['speaker']
export type CallResult = Omit<z.input<typeof callFinish.input>, 'callId'>

/** The business's hours as `call.start` reports them: `summary` is a ready sentence for the assistant. */
export type BusinessHours = { openNow: boolean; summary: string }

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
  /** The workspace's custom fields: the assistant asks for those with `ask_caller`, the summary fills all. */
  customFields: CallCustomField[]
  /**
   * The matched contact with their last calls and upcoming bookings, and whether the greeting used their first
   * name (then it is not the cached greeting); null: no contact (withheld number).
   */
  caller: CallerContext | null
  /** The assistant's reference documents: inline text or a look-up; null when it has none (or the API is older). */
  documents: CallDocuments | null
  /** The business's Linedesk number the caller dialled (a transfer shows it as caller ID); null for a test call. */
  businessNumber: string | null
  /** No-phone call test: a simulated on-call person answers transfers instead of a phone. */
  simulatedOnCall: SimulatedAnswer | null
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
  /** Missing from an API of an older version: none. */
  customFields?: CallCustomField[]
  documents?: CallDocuments | null
  /** A phone caller matched to a contact: their last calls and upcoming bookings; null or missing (older API): none. */
  callerHistory?: CallerHistory | null
}

/**
 * The caller for the prompt, and the assistant's greeting for a caller who called before (greeting_known_caller,
 * empty: none) when call.start sent the caller's history (a phone caller with a contact). An assistant row of
 * an older API has no such text: its greet_by_name decides, with the default text.
 */
export function greetCaller(assistant: Assistant | null, contact: Contact | null, history: CallerHistory | null | undefined): { assistant: Assistant | null; caller: CallerContext | null } {
  if (!contact) return { assistant, caller: null }
  const caller: CallerContext = { name: contact.name, note: contact.note, history: history ?? null, greetedByName: false }
  const template = assistant?.greeting_known_caller ?? (assistant?.greet_by_name === false ? '' : DEFAULT_KNOWN_CALLER_GREETING)
  const personal = assistant ? personalGreeting(assistant.greeting, template, caller) : null
  if (!assistant || !personal) return { assistant, caller }
  // The full name was said: its check proves nothing, so no appointments are listed for the assistant to share.
  const shared = personal.usesLastName && caller.history ? { ...caller.history, upcomingBookings: [] } : caller.history
  return {
    assistant: { ...assistant, greeting: personal.text },
    caller: { ...caller, history: shared, greetedByName: personal.usesName, greetedFullName: personal.usesLastName },
  }
}

/** The greeting followed by the recording notice, so both are said (and cached as audio) as one opening. */
export function withRecordingNotice(assistant: Assistant | null, notice: string | null | undefined): Assistant | null {
  const sentence = notice?.trim()
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
  | { kind: 'test'; workspaceId: string; room: string; assistantId?: string; businessHours?: BusinessHours; outsideGreeting?: string; onCall?: SimulatedOnCall }

/** The call test's simulated on-call person and the number it stands in for (transfer is on for the test). */
export type SimulatedOnCall = { answer: SimulatedAnswer; number: string }

/** The call test's only transfer contact: urgent calls to the simulated on-call person. */
export const simulatedContact = (number: string): TransferContact => ({
  id: 'oncall', name: 'Mike', number, condition: EMERGENCY_CONDITION, hours_only: false,
  ring_seconds: 25, if_no_answer: 'message_urgent', enabled: true,
})

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
  const configured = started.assistant && (outsideGreeting || onCall)
    ? {
        ...started.assistant,
        ...(outsideGreeting ? { greeting_outside: outsideGreeting } : {}),
        ...(onCall ? { transfers: [simulatedContact(onCall.number)] } : {}),
      }
    : started.assistant
  // The greeting and instructions that apply now: outside business hours, the outside variants.
  const greeted = greetCaller(forHours(configured, businessHours), contact, started.callerHistory)
  const assistant = withRecordingNotice(greeted.assistant, started.recordingNotice)
  const caller = greeted.caller
  const booking = started.booking ?? null
  const startedAt = Date.now()
  return {
    callId, ...scope, assistant, contact, blocked, busy, overCap, businessHours, booking, caller, documents: started.documents ?? null,
    customFields: started.customFields ?? [],
    businessNumber: origin.kind === 'phone' ? origin.to : null,
    simulatedOnCall: onCall?.answer ?? null,
    async append(speaker, text, toolEvent) {
      await api.run(callAppendTranscript, { callId, speaker, text, atMs: Date.now() - startedAt, toolEvent }, scope)
    },
    async finish(result) {
      await api.run(callFinish, { callId, ...result }, scope)
    },
  }
}

/**
 * Where the call comes from. A test room from the web app carries `{ source: 'test', workspaceId, assistantId? }`
 * in the job metadata the API signed into the browser's token; anything else is a phone call, with
 * caller and dialled number in the attributes LiveKit SIP sets (the talk page sets the same ones).
 */
export function callOrigin(jobMetadata: string, attributes: Record<string, string>, room: string): CallOrigin {
  const test = parseTestMetadata(jobMetadata)
  if (test)
    return {
      kind: 'test',
      workspaceId: test.workspaceId,
      room,
      ...(test.assistantId ? { assistantId: test.assistantId } : {}),
      ...(test.businessHours ? { businessHours: test.businessHours } : {}),
      ...(test.outsideGreeting ? { outsideGreeting: test.outsideGreeting } : {}),
      ...(test.onCall ? { onCall: test.onCall } : {}),
    }
  const to = attributes['sip.trunkPhoneNumber']
  if (!to) throw new Error('participant has no sip.trunkPhoneNumber attribute')
  // A withheld number may come without any caller ID: it is registered as such, never as someone's number.
  const from = attributes['sip.phoneNumber'] || 'anonymous'
  return { kind: 'phone', from, to, room }
}

/** The workspace (and the assistant picked in the web app) of a test room the API signed, or null for any other room. */
export function parseTestMetadata(
  metadata: string,
): { workspaceId: string; assistantId?: string; businessHours?: BusinessHours; outsideGreeting?: string; onCall?: SimulatedOnCall } | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { source?: unknown; workspaceId?: unknown; assistantId?: unknown; businessHours?: unknown; outsideGreeting?: unknown; onCall?: unknown }
    if (parsed.source !== 'test' || typeof parsed.workspaceId !== 'string' || !parsed.workspaceId) return null
    const hours = parsed.businessHours as Partial<BusinessHours> | undefined
    const businessHours = hours && typeof hours.openNow === 'boolean' && typeof hours.summary === 'string' ? { openNow: hours.openNow, summary: hours.summary } : undefined
    const assistantId = typeof parsed.assistantId === 'string' && parsed.assistantId ? parsed.assistantId : undefined
    const outsideGreeting = typeof parsed.outsideGreeting === 'string' && parsed.outsideGreeting ? parsed.outsideGreeting : undefined
    const onCall = parseSimulatedOnCall(parsed.onCall)
    return {
      workspaceId: parsed.workspaceId,
      ...(assistantId ? { assistantId } : {}),
      ...(businessHours ? { businessHours } : {}),
      ...(outsideGreeting ? { outsideGreeting } : {}),
      ...(onCall ? { onCall } : {}),
    }
  } catch {
    return null
  }
}

function parseSimulatedOnCall(value: unknown): SimulatedOnCall | undefined {
  const v = value as Partial<SimulatedOnCall> | undefined
  if (!v || typeof v.number !== 'string' || !/^\+\d{8,15}$/.test(v.number)) return undefined
  return simulatedAnswers.includes(v.answer as SimulatedAnswer) ? { answer: v.answer as SimulatedAnswer, number: v.number } : undefined
}
